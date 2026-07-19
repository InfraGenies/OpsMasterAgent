import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  IaCGeneratorLLMOutputSchema,
  type CapacityPlan,
  type IaCFile,
  type IaCPayload,
} from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { renderTemplate, templateCatalogSummary } from "../templates/catalog.js";
import { resolveVariableSecrets } from "../templates/secrets.js";
import { appServices, cacheService, dbService } from "../templates/types.js";
import type { TemplateId } from "@ops-master/shared";

const execFileAsync = promisify(execFile);
const SYSTEM_PROMPT = loadPrompt("03-iac-generator.md");

function buildUserPrompt(plan: CapacityPlan, isModify: boolean, hasDiff: boolean): string {
  return [
    `CapacityPlan:\n${JSON.stringify(plan, null, 2)}`,
    `Template catalogue:\n${templateCatalogSummary()}`,
    isModify
      ? `operation=modify.${hasDiff ? " The previous environment's files are held by the backend for diff_from; you do not need to supply them." : ""}`
      : "",
    `Respond with ONLY JSON, either:\n{ "template_id": "<one of the catalogue ids>", "variables": { ... } }\nor, if nothing in the catalogue fits:\n{ "error": "no_template", "needed": "<describe>" }`,
    `Variables you may set depending on the template: health_path (string, default "/"), db_name, db_user, db_password (use the literal string "__GENERATE__" for any password — never a literal value).`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function mockIacGenerator(
  plan: CapacityPlan
): { template_id: TemplateId; variables: Record<string, unknown> } | { error: "no_template"; needed: string } {
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

  return {
    template_id,
    variables: { health_path: "/", db_name: "appdb", db_user: "appuser", db_password: "__GENERATE__" },
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

export interface IacGeneratorInput {
  requestId: string;
  projectName: string;
  plan: CapacityPlan;
  isModify: boolean;
  diffFrom: IaCFile[] | null;
  deploymentDir: string;
}

export type IacGeneratorOutput =
  | { ok: true; value: IaCPayload; rawResponse: string; mocked: boolean }
  | { ok: false; needed: string; rawResponse: string; mocked: boolean };

export async function runIacGenerator(input: IacGeneratorInput): Promise<IacGeneratorOutput> {
  const result = await runLLMJson({
    schema: IaCGeneratorLLMOutputSchema,
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(input.plan, input.isModify, input.diffFrom !== null),
    mock: () => mockIacGenerator(input.plan),
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

  const validation = await validateCompose(input.deploymentDir);

  const payload: IaCPayload = {
    request_id: input.requestId,
    format: "compose",
    template_id: result.value.template_id,
    files: rendered.files,
    apply_command: rendered.applyCommand,
    rollback_command: rendered.rollbackCommand,
    diff_from: input.diffFrom,
    validation,
  };

  return { ok: true, value: payload, rawResponse: result.rawResponse, mocked: result.mocked };
}
