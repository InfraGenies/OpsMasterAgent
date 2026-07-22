import { PlanRequestSchema, type PlanRequest } from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { detectEnterpriseMode, mockExtractEnterpriseContext } from "./enterpriseRulesEngine.js";

const SYSTEM_PROMPT = loadPrompt("01-intake.md");

const SCHEMA_SHAPE = `{
  "request_id": "string",
  "raw_text": "string",
  "app_type": "string, e.g. web_api | static_site | worker",
  "runtime": "nodejs18 | python3.11 | java17 | static | multi",
  "repo_url": "string | null",
  "dependencies": ["postgresql" | "mysql" | "redis" | "mongodb" | "none"],
  "expected_load": { "rps": number | null, "concurrent_users": number | null },
  "environment": "string, e.g. staging | qa | dev | production",
  "operation": "create | modify | destroy",
  "constraints": { "target": "compose | localstack | minikube | aws", "max_memory_gb": number },
  "existing_env_id": "string | null",
  "notes": ["string"],
  "feasible_input": boolean,
  "infeasibility_reason": "string | null",
  "enterprise_mode": "boolean — true iff the request describes business context (compliance target, team/org size, RPO/RTO, multi-region DR, an industry like payments/healthcare) rather than just an app to size",
  "enterprise_context": {
    "industry_domain": "payments | healthcare | retail | generic",
    "compliance_targets": ["pci_dss" | "hipaa" | "soc2" | "none"],
    "expected_users": "number | null",
    "team_size": "number | null, e.g. from \"N developers/engineers\"",
    "org_scale": "solo (<=3 people) | team (4-49) | scale_up (50-249) | enterprise (250+) — solo if team_size not stated",
    "multi_region": "boolean",
    "rpo_minutes": "number | null",
    "rto_minutes": "number | null",
    "signal_reasoning": "string — which phrases in raw_text mapped to which field above"
  } // or null when enterprise_mode is false
}`;

function buildUserPrompt(requestId: string, rawText: string, existingEnvId: string | null): string {
  return [
    `request_id to use: "${requestId}"`,
    existingEnvId ? `existing_env_id to use if this is a modify/destroy: "${existingEnvId}"` : "",
    `User request (verbatim):\n"""${rawText}"""`,
    `Respond with ONLY a JSON object matching exactly this shape:\n${SCHEMA_SHAPE}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

const POLICY_VIOLATION_PATTERNS = [
  /ignore (all|previous|prior) instructions/i,
  /\brm\s+-rf\b/i,
  /give me root/i,
  /bypass (the )?approval/i,
  /access (the )?secrets?/i,
  /run arbitrary/i,
];

function mockIntake(requestId: string, rawText: string): PlanRequest {
  const lower = rawText.toLowerCase();
  const policyViolation = POLICY_VIOLATION_PATTERNS.some((p) => p.test(rawText));

  const rpsMatch = rawText.match(/(\d[\d,]*)\s*(?:req(?:uests)?\/?s(?:econd)?|rps)/i);
  const rps = rpsMatch ? Number(rpsMatch[1].replace(/,/g, "")) : null;

  const usersMatch = rawText.match(/(\d[\d,]*)\s*(?:concurrent\s+)?(?:users?|voters?)\b/i);
  const concurrentUsers = usersMatch ? Number(usersMatch[1].replace(/,/g, "")) : null;

  const repoMatch = rawText.match(/https?:\/\/\S+/);

  const dependencies: PlanRequest["dependencies"] = [];
  if (lower.includes("postgres")) dependencies.push("postgresql");
  if (lower.includes("mysql")) dependencies.push("mysql");
  if (lower.includes("redis")) dependencies.push("redis");
  if (lower.includes("mongo")) dependencies.push("mongodb");
  if (dependencies.length === 0) dependencies.push("none");

  let runtime: PlanRequest["runtime"] = "nodejs18";
  if (lower.includes("python") || lower.includes("flask") || lower.includes("fastapi")) runtime = "python3.11";
  else if (lower.includes("java") || lower.includes("spring")) runtime = "java17";
  else if (lower.includes("static") || lower.includes("html")) runtime = "static";

  let operation: PlanRequest["operation"] = "create";
  if (/\b(add|modify|update|extend|wire)\b/i.test(rawText)) operation = "modify";
  if (/\b(destroy|tear down|delete)\b/i.test(rawText) && !policyViolation) operation = "destroy";

  const wantsRealProdCloud = /\bproduction\b/i.test(rawText) && /\b(aws|gcp|azure|real cloud)\b/i.test(rawText);
  // UC-9: "aws" without "production" is allowed — this path only ever
  // produces a Terraform plan, never a live apply (see commandAllowList.ts).
  const wantsAws = !wantsRealProdCloud && /\baws\b/i.test(rawText);

  // Enterprise Architecture Advisor: a separate signal from wantsAws/UC-9's
  // fixed retail-store-sample-app worked example — planner.ts branches on
  // enterprise_mode before constraints.target==="aws" so the two never
  // collide. Checked against every existing UC-1..UC-9 request text to
  // confirm none false-trigger (see enterpriseRulesEngine.ts's detector).
  const enterpriseMode = !wantsRealProdCloud && detectEnterpriseMode(rawText);
  if (wantsAws || enterpriseMode) runtime = "multi";

  return {
    request_id: requestId,
    raw_text: rawText,
    app_type: "web_api",
    runtime,
    repo_url: repoMatch ? repoMatch[0] : wantsAws && /retail-store-sample-app/i.test(rawText) ? "https://github.com/aws-containers/retail-store-sample-app" : null,
    dependencies,
    expected_load: { rps, concurrent_users: concurrentUsers },
    environment: lower.includes("staging") ? "staging" : lower.includes("qa") ? "qa" : "dev",
    operation,
    constraints: { target: wantsAws || enterpriseMode ? "aws" : "compose", max_memory_gb: 8 },
    existing_env_id: null,
    notes:
      rps === null
        ? concurrentUsers !== null
          ? [`load stated as ~${concurrentUsers} concurrent users; planner will convert to rps`]
          : ["expected load not stated; assuming light traffic for sizing"]
        : [],
    feasible_input: !policyViolation && !wantsRealProdCloud,
    infeasibility_reason: policyViolation
      ? "policy violation"
      : wantsRealProdCloud
        ? "sandbox-only platform"
        : null,
    enterprise_mode: enterpriseMode,
    enterprise_context: enterpriseMode ? mockExtractEnterpriseContext(rawText) : null,
  };
}

export async function runIntake(
  requestId: string,
  rawText: string,
  existingEnvId: string | null
): Promise<{ value: PlanRequest; rawResponse: string; mocked: boolean }> {
  return runLLMJson({
    schema: PlanRequestSchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(requestId, rawText, existingEnvId),
    mock: () => mockIntake(requestId, rawText),
    node: "intake",
  });
}
