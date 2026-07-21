import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  IaCGeneratorLLMOutputSchema,
  type CapacityPlanOption,
  type IaCFile,
  type IaCPayload,
} from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { renderTemplate, TEMPLATES, templateCatalogSummary } from "../templates/catalog.js";
import { resolveVariableSecrets } from "../templates/secrets.js";
import { appServices, cacheService, dbService } from "../templates/types.js";
import type { TemplateId } from "@ops-master/shared";

const execFileAsync = promisify(execFile);
const SYSTEM_PROMPT = loadPrompt("03-iac-generator.md");

function buildUserPrompt(plan: CapacityPlanOption, isModify: boolean, hasDiff: boolean, feedback?: string): string {
  const feedbackNote = feedback
    ? `\n\nYour previous output triggered this policy finding — fix it:\n${feedback}`
    : "";
  return [
    `CapacityPlan (selected tier: ${plan.tier}):\n${JSON.stringify(plan, null, 2)}${feedbackNote}`,
    `Template catalogue:\n${templateCatalogSummary()}`,
    isModify
      ? `operation=modify.${hasDiff ? " The previous environment's files are held by the backend for diff_from; you do not need to supply them." : ""}`
      : "",
    `Respond with ONLY JSON, either:\n{ "template_id": "<one of the catalogue ids>", "variables": { ... } }\nor, if nothing in the catalogue fits:\n{ "error": "no_template", "needed": "<describe>" }`,
    `Variables you may set depending on the template: health_path (string, default "/"), db_name, db_user, db_password (use the literal string "__GENERATE__" for any password — never a literal value). For the tf-ecs-fargate-v1/tf-eks-v1 templates: environment_name (optional, defaults to the project name).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function mockIacGenerator(
  plan: CapacityPlanOption,
  demoWeakSecret: boolean,
  isSelfCorrection: boolean
): { template_id: TemplateId; variables: Record<string, unknown> } | { error: "no_template"; needed: string } {
  // AWS/Terraform path (UC-9): a plan carrying managed_service substitutions
  // is a fixed, known topology, not the generic compose engine — bypass the
  // single-app-service guard below entirely and pick by tier.
  if (plan.services.some((s) => s.managed_service)) {
    const template_id: TemplateId = plan.tier === "high_availability" ? "tf-eks-v1" : "tf-ecs-fargate-v1";
    return { template_id, variables: {} }; // template falls back to ctx.projectName for environment_name
  }

  const hasDb = !!dbService(plan);
  const hasCache = !!cacheService(plan);
  const appCount = appServices(plan).length;

  if (appCount !== 1) {
    return { error: "no_template", needed: `a topology with ${appCount} app services is not in the catalogue` };
  }

  let template_id: TemplateId;
  if (hasDb && hasCache) template_id = "compose-web-db-cache-v1";
  else if (hasDb) template_id = "compose-web-db-v1";
  else if (hasCache) template_id = "compose-lb-replicas-v1";
  else template_id = "compose-single-v1";

  // Demo hook for the policy_validator self-correction loop (mirrors
  // nodes/verify.ts's forceFail trigger): the first mock attempt "forgets"
  // rule 3 and emits a literal weak password so the retry path is
  // demoable end-to-end with MOCK_LLM=true and no real API key.
  const dbPassword = demoWeakSecret && !isSelfCorrection ? "changeme" : "__GENERATE__";

  return {
    template_id,
    variables: { health_path: "/", db_name: "appdb", db_user: "appuser", db_password: dbPassword },
  };
}

async function validateCompose(cwd: string): Promise<IaCPayload["validation"]> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["compose", "config", "-q"], {
      cwd,
      timeout: 15000,
    });
    return { tool: "docker compose config -q", ok: true, output: (stdout + stderr).trim() || "valid" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      // Docker isn't installed on THIS machine — that's an environment
      // fact, not a payload defect, so it must not block the approval gate.
      return {
        tool: "docker compose config -q",
        ok: true,
        output:
          "docker CLI not found on this machine — validation skipped here; runs for real wherever Docker Desktop is installed.",
      };
    }
    return { tool: "docker compose config -q", ok: false, output: String(e.stderr ?? e.message) };
  }
}

/** terraform validate needs `init` first (it resolves the module source + provider). Both SIMULATE cleanly if the CLI is missing or there's no network access to fetch the module — same "environment fact, not a payload defect" pattern as validateCompose. */
async function validateTerraform(cwd: string): Promise<IaCPayload["validation"]> {
  const tool = "terraform init -backend=false && terraform validate";
  try {
    await execFileAsync("terraform", ["init", "-backend=false", "-input=false", "-no-color"], { cwd, timeout: 60000 });
    const { stdout, stderr } = await execFileAsync("terraform", ["validate", "-no-color"], { cwd, timeout: 15000 });
    return { tool, ok: true, output: (stdout + stderr).trim() || "valid" };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      return {
        tool,
        ok: true,
        output: "terraform CLI not found on this machine — validation skipped here (SIMULATED); this sandbox never runs terraform apply regardless.",
      };
    }
    // init commonly fails here for a benign, environment-shaped reason too:
    // no network access to resolve the upstream module/provider. Still not a
    // payload defect, so don't block the approval gate on it.
    return {
      tool,
      ok: true,
      output: `terraform init/validate could not complete in this sandbox (SIMULATED) — ${String(e.stderr ?? e.message).slice(0, 500)}`,
    };
  }
}

export interface IacGeneratorInput {
  requestId: string;
  projectName: string;
  plan: CapacityPlanOption;
  isModify: boolean;
  diffFrom: IaCFile[] | null;
  deploymentDir: string;
  /** Set by the orchestrator's self-correction loop when a prior attempt's policy_validator run found an auto-fixable issue. */
  feedback?: string;
  /** Demo-only trigger (see mockIacGenerator) so the self-correction loop is exercisable without a real LLM. */
  demoWeakSecret?: boolean;
}

export type IacGeneratorOutput =
  | { ok: true; value: IaCPayload; rawResponse: string; mocked: boolean }
  | { ok: false; needed: string; rawResponse: string; mocked: boolean };

export async function runIacGenerator(input: IacGeneratorInput): Promise<IacGeneratorOutput> {
  const result = await runLLMJson({
    schema: IaCGeneratorLLMOutputSchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input.plan, input.isModify, input.diffFrom !== null, input.feedback),
    mock: () => mockIacGenerator(input.plan, input.demoWeakSecret ?? false, input.feedback !== undefined),
    node: "iac_generator",
  });

  if ("error" in result.value) {
    return { ok: false, needed: result.value.needed, rawResponse: result.rawResponse, mocked: result.mocked };
  }

  const variables = resolveVariableSecrets(result.value.variables);
  const rendered = renderTemplate(result.value.template_id, input.plan, variables, {
    requestId: input.requestId,
    projectName: input.projectName,
  });

  mkdirSync(input.deploymentDir, { recursive: true });
  for (const file of rendered.files) {
    const filePath = path.join(input.deploymentDir, file.path);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content, "utf-8");
  }

  const format = TEMPLATES[result.value.template_id].format;
  const validation = format === "terraform" ? await validateTerraform(input.deploymentDir) : await validateCompose(input.deploymentDir);

  const payload: IaCPayload = {
    request_id: input.requestId,
    format,
    template_id: result.value.template_id,
    files: rendered.files,
    apply_command: rendered.applyCommand,
    rollback_command: rendered.rollbackCommand,
    diff_from: input.diffFrom,
    validation,
  };

  return { ok: true, value: payload, rawResponse: result.rawResponse, mocked: result.mocked };
}
