import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  IaCGeneratorLLMOutputSchema,
  type CapacityPlanOption,
  type IaCFile,
  type IaCPayload,
  type PlatformArchetype,
} from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { loadSkill } from "../llm/skillLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { renderTemplate, TEMPLATES, templateCatalogSummary } from "../templates/catalog.js";
import { resolveFreeformSecrets, resolveVariableSecrets } from "../templates/secrets.js";
import { appServices, cacheService, dbService } from "../templates/types.js";
import type { TemplateId } from "@ops-master/shared";

const execFileAsync = promisify(execFile);
// The iac_generator can't know in advance whether a request will match the
// catalog or fall through to writing files directly, so both IaC-writing
// skills plus the novel-requirement meta-skill are always appended.
const SYSTEM_PROMPT = [
  loadPrompt("03-iac-generator.md"),
  loadSkill("writing-compose-iac"),
  loadSkill("writing-terraform-iac"),
  loadSkill("novel-requirement-reasoning"),
].join("\n\n");

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
    `Respond with ONLY JSON, one of THREE shapes:\n` +
      `1. Catalog match: { "template_id": "<one of the catalogue ids>", "variables": { ... } }\n` +
      `2. Freeform (nothing in the catalogue fits — see the writing-compose-iac / writing-terraform-iac / ` +
      `novel-requirement-reasoning guidance above): { "format": "compose" | "terraform", "files": ` +
      `[{ "path": "...", "content": "..." }] }\n` +
      `3. Out of scope entirely: { "error": "no_template", "needed": "<describe>" }`,
    `Variables you may set depending on the template: health_path (string, default "/"), db_name, db_user, db_password (use the literal string "__GENERATE__" for any password — never a literal value). For the tf-ecs-fargate-v1/tf-eks-v1 templates: environment_name (optional, defaults to the project name).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function mockIacGenerator(
  plan: CapacityPlanOption,
  demoWeakSecret: boolean,
  isSelfCorrection: boolean,
  enterpriseArchetype?: PlatformArchetype | null
): { template_id: TemplateId; variables: Record<string, unknown> } | { error: "no_template"; needed: string } {
  // Enterprise Architecture Advisor (Phase 1 interim, agent-md-files/02c-compliance-check.md):
  // reuses UC-9's existing Terraform templates as a stand-in for the
  // archetype's compute layer — dedicated compute templates per archetype
  // land in Phase 2 (enterpriseCatalog.ts). solo/team archetypes get the
  // ECS Fargate template; scale_up/enterprise (Kubernetes-based) archetypes
  // get the EKS one.
  if (enterpriseArchetype) {
    const template_id: TemplateId =
      enterpriseArchetype === "scale_up_eks" || enterpriseArchetype === "enterprise_eks_landing_zone"
        ? "tf-eks-v1"
        : "tf-ecs-fargate-v1";
    return { template_id, variables: {} };
  }

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

/**
 * apply_command/rollback_command for freeform output — deliberately NOT
 * derived from anything the LLM said. Copied verbatim from the literal
 * strings every catalog template already produces (catalog.ts,
 * terraformCatalog.ts), which are format-generic, not template-specific —
 * confirmed by commandAllowList.ts's regexes only ever matching on project
 * name, never template identity. Keeping these identical means no change is
 * needed to the allow-list for freeform mode to work.
 */
function genericCommandsFor(format: "compose" | "terraform", projectName: string): { applyCommand: string; rollbackCommand: string } {
  if (format === "compose") {
    return {
      applyCommand: `docker compose -p ${projectName} up -d --wait`,
      rollbackCommand: `docker compose -p ${projectName} down -v`,
    };
  }
  return {
    applyCommand: "terraform init -backend=false -input=false -no-color && terraform plan -input=false -no-color -out=tfplan",
    rollbackCommand: "n/a — plan-only (apply/destroy are not in the allow-list), so nothing is ever applied and there is nothing to roll back",
  };
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
  /** Set when CapacityPlan.architecture_recommendation is present — selects the Phase-1 interim compute template by archetype instead of the generic compose engine. */
  enterpriseArchetype?: PlatformArchetype | null;
}

export type IacGeneratorOutput =
  | { ok: true; value: IaCPayload; rawResponse: string; mocked: boolean }
  | { ok: false; needed: string; rawResponse: string; mocked: boolean };

export async function runIacGenerator(input: IacGeneratorInput): Promise<IacGeneratorOutput> {
  const result = await runLLMJson({
    schema: IaCGeneratorLLMOutputSchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input.plan, input.isModify, input.diffFrom !== null, input.feedback),
    mock: () =>
      mockIacGenerator(input.plan, input.demoWeakSecret ?? false, input.feedback !== undefined, input.enterpriseArchetype),
    node: "iac_generator",
  });

  if ("error" in result.value) {
    return { ok: false, needed: result.value.needed, rawResponse: result.rawResponse, mocked: result.mocked };
  }
  if ("template_id" in result.value && result.value.template_id === "freeform") {
    // The LLM used the catalog shape but named the freeform sentinel as a
    // template_id — never legitimate (the prompt only ever offers "freeform"
    // as an outcome of the {format, files} shape). Treat as a malformed
    // response rather than indexing into a catalogue entry that can't exist.
    return {
      ok: false,
      needed: "model returned template_id \"freeform\" via the catalog shape instead of the {format, files} freeform shape",
      rawResponse: result.rawResponse,
      mocked: result.mocked,
    };
  }

  mkdirSync(input.deploymentDir, { recursive: true });

  let format: IaCPayload["format"];
  let templateId: IaCPayload["template_id"];
  let files: IaCFile[];
  let applyCommand: string;
  let rollbackCommand: string;

  if ("format" in result.value) {
    // Freeform: nothing in the catalogue fit, so the LLM wrote files
    // directly (skills/novel-requirement-reasoning.md). apply_command/
    // rollback_command are still never taken from the LLM — derived
    // generically from format + project name, matching the exact strings
    // commandAllowList.ts already expects.
    files = resolveFreeformSecrets(result.value.files);
    format = result.value.format;
    templateId = "freeform";
    ({ applyCommand, rollbackCommand } = genericCommandsFor(format, input.projectName));
  } else {
    // Guarded above: template_id === "freeform" already returned early, so
    // this is genuinely one of the rendered catalogue ids.
    const catalogTemplateId = result.value.template_id as Exclude<TemplateId, "freeform">;
    const variables = resolveVariableSecrets(result.value.variables);
    const rendered = renderTemplate(catalogTemplateId, input.plan, variables, {
      requestId: input.requestId,
      projectName: input.projectName,
    });
    files = rendered.files;
    format = TEMPLATES[catalogTemplateId].format;
    templateId = catalogTemplateId;
    applyCommand = rendered.applyCommand;
    rollbackCommand = rendered.rollbackCommand;
  }

  for (const file of files) {
    const filePath = path.join(input.deploymentDir, file.path);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content, "utf-8");
  }

  const validation = format === "terraform" ? await validateTerraform(input.deploymentDir) : await validateCompose(input.deploymentDir);

  const payload: IaCPayload = {
    request_id: input.requestId,
    format,
    template_id: templateId,
    files,
    apply_command: applyCommand,
    rollback_command: rollbackCommand,
    diff_from: input.diffFrom,
    validation,
  };

  return { ok: true, value: payload, rawResponse: result.rawResponse, mocked: result.mocked };
}
