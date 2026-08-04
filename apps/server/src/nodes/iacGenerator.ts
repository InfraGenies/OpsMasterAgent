import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  IaCGeneratorLLMOutputSchema,
  type ArchitectureRecommendation,
  type CapacityPlanOption,
  type IaCFile,
  type IaCPayload,
  type PlatformArchetype,
} from "@ops-master/shared";
import { loadPrompt } from "../llm/promptLoader.js";
import { loadSkill } from "../llm/skillLoader.js";
import { runLLMJson } from "../llm/runLLMJson.js";
import { renderTemplate, TEMPLATES, templateCatalogSummary } from "../templates/catalog.js";
import { renderEnterpriseArchetype } from "../templates/enterpriseCatalog.js";
import { generateSecret, resolveFreeformSecrets, resolveVariableSecrets } from "../templates/secrets.js";
import { appServices, cacheService, dbService, hostPortFor } from "../templates/types.js";
import { BUILD_REGISTRY, FRONTEND_API_ROOT_PLACEHOLDER, isBuildSentinel } from "./buildRegistry.js";
import type { TemplateId } from "@ops-master/shared";

/** solo_ecs_fargate/team_ecs_fargate_ha only — the two archetypes with a real Phase-2 renderer (templates/enterpriseCatalog.ts). scale_up_eks/enterprise_eks_landing_zone stay on the tf-eks-v1/UC-9-reuse stand-in (see mockIacGenerator's enterpriseArchetype branch and this file's runIacGenerator override below) — a deliberate, separate follow-up (EKS + ArgoCD + multi-account landing zone is a structurally different, much larger shape). */
function hasEnterpriseCatalogRenderer(archetype: PlatformArchetype | null | undefined): archetype is "solo_ecs_fargate" | "team_ecs_fargate_ha" {
  return archetype === "solo_ecs_fargate" || archetype === "team_ecs_fargate_ha";
}

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

/** True iff the plan carries both halves of the RealWorld build-sentinel pair (nodes/buildRegistry.ts) — the one fixed topology compose-realworld-fullstack-v1 renders. */
function isRealworldFullstackPlan(plan: CapacityPlanOption): boolean {
  const keys = new Set(plan.services.map((s) => isBuildSentinel(s.image)).filter((k): k is string => k !== null));
  return keys.has("realworld-node-express") && keys.has("realworld-react-frontend");
}

function mockIacGenerator(
  plan: CapacityPlanOption,
  demoWeakSecret: boolean,
  isSelfCorrection: boolean,
  enterpriseArchetype?: PlatformArchetype | null
): { template_id: TemplateId; variables: Record<string, unknown> } | { error: "no_template"; needed: string } {
  // Enterprise Architecture Advisor: solo_ecs_fargate/team_ecs_fargate_ha get
  // the real Phase-2 renderer (templates/enterpriseCatalog.ts) — this
  // template_id choice is force-corrected server-side regardless of mock or
  // real-LLM mode (see runIacGenerator's override below), so what's actually
  // returned here barely matters for those two archetypes; kept accurate
  // anyway for a coherent audit trail. scale_up_eks/enterprise_eks_landing_zone
  // (Kubernetes-based) stay on the tf-eks-v1/UC-9-reuse stand-in — a
  // deliberate, separate follow-up (see hasEnterpriseCatalogRenderer's
  // comment).
  if (enterpriseArchetype) {
    const template_id: TemplateId = hasEnterpriseCatalogRenderer(enterpriseArchetype) ? "tf-enterprise-ecs-fargate-v1" : "tf-eks-v1";
    return { template_id, variables: {} };
  }

  // AWS/Terraform path (UC-9): a plan carrying managed_service substitutions
  // is a fixed, known topology, not the generic compose engine — bypass the
  // single-app-service guard below entirely and pick by tier.
  if (plan.services.some((s) => s.managed_service)) {
    const template_id: TemplateId = plan.tier === "high_availability" ? "tf-eks-v1" : "tf-ecs-fargate-v1";
    return { template_id, variables: {} }; // template falls back to ctx.projectName for environment_name
  }

  // RealWorld fullstack pair (nodes/buildRegistry.ts): both build sentinels
  // present is a fixed, known topology, not the generic compose engine —
  // bypass the single-app-service guard below entirely, same pattern as the
  // AWS worked example just above. db_name/db_user/db_password MUST be set
  // here (not left for the template's own defaults) — runIacGenerator reads
  // these same `variables` twice, once to build the migration step's
  // DATABASE_URL and again inside the template's render() for the actual
  // POSTGRES_PASSWORD; leaving db_password unset made each call fall back to
  // its own independent generateSecret(), producing two different passwords
  // and a real prisma migrate "P1000: Authentication failed" — confirmed via
  // a live end-to-end run.
  if (isRealworldFullstackPlan(plan)) {
    return {
      template_id: "compose-realworld-fullstack-v1",
      // !isSelfCorrection matters here: without it, the self-correction
      // retry (policy_validator's weak-password demo) kept re-emitting the
      // same weak password forever instead of fixing it on retry —
      // confirmed via a live run (3 attempts, still failing) before this
      // guard was added, matching the same condition the plain single-app
      // path below already uses.
      variables: {
        db_name: "appdb",
        db_user: "appuser",
        db_password: demoWeakSecret && !isSelfCorrection ? "changeme" : "__GENERATE__",
      },
    };
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
  /** Full CapacityPlan.architecture_recommendation, when present — its `managed_controls` and `criticality_band` drive the real Phase-2 Terraform rendering (templates/enterpriseCatalog.ts) for solo_ecs_fargate/team_ecs_fargate_ha. Kept separate from `enterpriseArchetype` above (a lighter, pre-existing field) rather than replacing it, to avoid touching every other call site that only ever needed the archetype string. */
  architectureRecommendation?: ArchitectureRecommendation | null;
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
  let healthPathMap: Record<string, string> = {};
  let buildSteps: IaCPayload["build_steps"] = null;
  let resolvedImages: IaCPayload["resolved_images"] = null;
  let dockerfileOverrideMap: Record<string, string> = {};

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
    // this is genuinely one of the rendered catalogue ids. The RealWorld
    // fullstack pair is a fixed, known topology (same as UC-9's AWS worked
    // example) — force-correct the model's choice server-side rather than
    // trusting it to have picked compose-realworld-fullstack-v1 itself, same
    // as variables.health_path below is already backend-decided for any
    // build-sentinel service. This is a narrow, one-template exception to
    // "the LLM picks the template" (every other template is still the
    // model's own choice).
    // Same narrow, backend-forced exception as the RealWorld pair above,
    // for the Enterprise Architecture Advisor's two Phase-2 archetypes.
    const catalogTemplateId: Exclude<TemplateId, "freeform"> = isRealworldFullstackPlan(input.plan)
      ? "compose-realworld-fullstack-v1"
      : hasEnterpriseCatalogRenderer(input.enterpriseArchetype)
        ? "tf-enterprise-ecs-fargate-v1"
        : (result.value.template_id as Exclude<TemplateId, "freeform">);
    const variables = resolveVariableSecrets(result.value.variables);

    // Build-sentinel path (nodes/buildRegistry.ts): the LLM/mock planner
    // never emits a real image for a build-sentinel service, only a
    // "__BUILD__:<key>" marker — resolve every such service to its own
    // locally-built tag here, server-side, and construct the combined
    // git-clone/build/docker-build(/migrate) sequence that nodes/build.ts
    // will run before deploy. The template layer below never learns about
    // builds; it just renders normal image strings. Looping (not just
    // resolving the first match) is what lets a plan carry more than one
    // build-sentinel service — e.g. the RealWorld pair's backend + frontend.
    let renderPlan = input.plan;
    const buildServices = input.plan.services.filter((s) => isBuildSentinel(s.image));
    const dbBringupAndMigrateSteps: NonNullable<IaCPayload["build_steps"]> = [];
    const cloneAndBuildSteps: NonNullable<IaCPayload["build_steps"]> = [];
    const resolvedImagesAcc: Record<string, string> = {};

    for (const buildService of buildServices) {
      const key = isBuildSentinel(buildService.image)!;
      const entry = BUILD_REGISTRY[key];
      const cloneDir = `repo-${key}`;
      const localTag = `${input.projectName}-${key}-app:${entry.commitSha.slice(0, 12)}`;
      renderPlan = {
        ...renderPlan,
        services: renderPlan.services.map((s) => (s.name === buildService.name ? { ...s, image: localTag } : s)),
      };
      resolvedImagesAcc[buildService.name] = localTag;
      // Backend-decided, not LLM-decided — every build-sentinel service has
      // a known health endpoint, never something to leave to model variance.
      healthPathMap[buildService.name] = entry.healthPath;

      cloneAndBuildSteps.push(
        { command: `git clone ${entry.repoUrl} ${cloneDir}`, cwd: "deployment" },
        { command: `git checkout ${entry.commitSha}`, cwd: cloneDir }
      );

      // Where the `docker build` step actually runs — the clone dir itself,
      // or that clone dir's dockerfileSubdir when the repo's Dockerfile isn't
      // at its root (today: nginx-hello, whose Dockerfile lives in
      // NGINX-Demos's nginx-hello/ subfolder). build.ts's isKnownCwd() only
      // accepts this exact value, derived from the same closed registry.
      const buildCwd = entry.dockerfileSubdir ? `${cloneDir}/${entry.dockerfileSubdir}` : cloneDir;

      if (entry.needsDatabase) {
        // Primary/backend entry needing a db + host-side build/migrate
        // (today: realworld-node-express only).
        const db = dbService(renderPlan);
        if (!db) {
          return {
            ok: false,
            needed: `build-sentinel service "${buildService.name}" requires a db service in the plan, none found`,
            rawResponse: result.rawResponse,
            mocked: result.mocked,
          };
        }
        // The migration step needs Postgres reachable from the host — the
        // mock planner adds this network.expose entry itself, but a real LLM
        // only reliably follows the "use this sentinel image" instruction,
        // not a second unrelated one about exposing a port (same reliability
        // gap hit earlier with architecture_recommendation.enterprise_context)
        // — so backfill it deterministically here rather than depending on
        // the model to remember. Not checked by readiness_check's
        // port-conflict reassignment (that already ran, at Gate 1, before
        // this port existed in the plan) — a genuine conflict on this port
        // surfaces as a clear build-step failure, not a graceful reassignment.
        let dbExpose = renderPlan.network.expose.find((e) => e.service === db.name);
        if (!dbExpose) {
          dbExpose = { service: db.name, host_port: db.ports[0] ?? 5432 };
          renderPlan = { ...renderPlan, network: { ...renderPlan.network, expose: [...renderPlan.network.expose, dbExpose] } };
        }
        const dbUser = typeof variables.db_user === "string" ? variables.db_user : "appuser";
        const dbName = typeof variables.db_name === "string" ? variables.db_name : "appdb";
        const dbPassword = typeof variables.db_password === "string" ? variables.db_password : generateSecret();
        // Host-side migration step (prisma CLI only exists in the cloned
        // repo's own node_modules) reaches Postgres via its published host
        // port, not the in-network service name/port the app container uses.
        const hostDatabaseUrl = `postgres://${dbUser}:${dbPassword}@localhost:${dbExpose.host_port}/${dbName}`;

        cloneAndBuildSteps.push(
          { command: "npm ci", cwd: cloneDir },
          { command: "npm run build", cwd: cloneDir },
          { command: `docker build -t ${localTag} .`, cwd: buildCwd }
        );
        dbBringupAndMigrateSteps.push(
          { command: `docker compose -p ${input.projectName} up -d --wait ${db.name}`, cwd: "deployment" },
          { command: "npx prisma migrate deploy", cwd: cloneDir, env: { DATABASE_URL: hostDatabaseUrl } }
        );
        if (entry.dockerfileOverride) dockerfileOverrideMap[buildCwd] = entry.dockerfileOverride;
      } else if (entry.pairedWith !== null) {
        // Paired entry (today: realworld-react-frontend) — its own build
        // (npm install + npm run build) happens entirely INSIDE its
        // multi-stage Dockerfile, not as separate host-side steps like the
        // backend above, specifically because this app is fragile enough
        // (2018-era CRA tooling) that depending on whatever Node happens to
        // be installed on the operator's own host machine would be
        // self-defeating — the whole point of building it in a pinned
        // node:16-alpine stage. Resolve the paired backend's actual host
        // port (known at plan-render time, independent of either image
        // having been built yet) and bake it into the API-root placeholder
        // before writing this Dockerfile out.
        const backendEntry = BUILD_REGISTRY[entry.pairedWith];
        const backendService = buildServices.find((s) => isBuildSentinel(s.image) === entry.pairedWith);
        if (!backendService) {
          return {
            ok: false,
            needed: `build-sentinel service "${buildService.name}" is paired with "${entry.pairedWith}", but no service using that sentinel was found in the plan`,
            rawResponse: result.rawResponse,
            mocked: result.mocked,
          };
        }
        const backendHostPort = hostPortFor(renderPlan, backendService.name, backendEntry.containerPort);
        cloneAndBuildSteps.push({ command: `docker build -t ${localTag} .`, cwd: buildCwd });
        if (entry.dockerfileOverride) {
          dockerfileOverrideMap[buildCwd] = entry.dockerfileOverride.replace(
            FRONTEND_API_ROOT_PLACEHOLDER,
            `http://localhost:${backendHostPort}/api`
          );
        }
      } else {
        // Standalone entry (vite-react-frontend, nginx-hello,
        // aws-copilot-sample): no db, no pairing, no host-side build steps —
        // the repo's own Dockerfile is self-sufficient (either a static-file
        // COPY, or, for vite-react-frontend, a build stage that does its own
        // npm install/build inside the image). Just clone + checkout (already
        // pushed above) + docker build.
        cloneAndBuildSteps.push({ command: `docker build -t ${localTag} .`, cwd: buildCwd });
        if (entry.dockerfileOverride) dockerfileOverrideMap[buildCwd] = entry.dockerfileOverride;
      }
    }

    if (buildServices.length > 0) {
      buildSteps = [...cloneAndBuildSteps, ...dbBringupAndMigrateSteps];
      resolvedImages = resolvedImagesAcc;
    }

    let rendered: { files: IaCFile[]; applyCommand: string; rollbackCommand: string };
    if (catalogTemplateId === "tf-enterprise-ecs-fargate-v1") {
      // Bypasses the normal TEMPLATES catalogue entirely — this id isn't a
      // catalog entry, it's rendered directly by templates/enterpriseCatalog.ts
      // (Phase 2 of the Enterprise Architecture Advisor), parameterized from
      // the plan's own illustrative "app"/"db" services (already sized per
      // COMPUTE_SPEC_BY_ARCHETYPE / dbMultiAz by enterpriseRulesEngine.ts's
      // buildEnterpriseOptions) rather than re-deriving that sizing here.
      const appSvc = renderPlan.services.find((s) => s.name === "app");
      const dbSvc = renderPlan.services.find((s) => s.name === "db");
      const archetype = input.enterpriseArchetype as "solo_ecs_fargate" | "team_ecs_fargate_ha";
      const files = renderEnterpriseArchetype({
        archetype,
        managedControls: input.architectureRecommendation?.managed_controls ?? [],
        computeSpec: { cpu: appSvc?.cpu ?? "0.25", memory: appSvc?.memory ?? "512Mi", replicas: appSvc?.replicas ?? 1 },
        dbMultiAz: dbSvc?.multi_az ?? false,
        environmentName: input.projectName,
      });
      rendered = {
        files,
        applyCommand: "terraform init -backend=false -input=false -no-color && terraform plan -input=false -no-color -out=tfplan",
        rollbackCommand:
          "n/a — plan-only (apply/destroy are not in the allow-list), so nothing is ever applied and there is nothing to roll back",
      };
    } else {
      rendered = renderTemplate(catalogTemplateId, renderPlan, variables, {
        requestId: input.requestId,
        projectName: input.projectName,
      });
    }
    files = rendered.files;
    // Surface each resolved Dockerfile override as its own visible, read-only
    // file — reviewable at the approval gate (and downloadable) alongside
    // docker-compose.yml, same bar as every other rendered file. Deliberately
    // NOT placed at "<cwd>/Dockerfile" (e.g. "repo-realworld-node-express/
    // Dockerfile") — that's the exact path nodes/build.ts's own `git clone`
    // step targets, and pre-creating it here via the writeFileSync loop below
    // would make `git clone` fail ("destination path already exists and is
    // not an empty directory"). "dockerfiles/<cwd>.Dockerfile" is a distinct,
    // non-colliding location purely for human review.
    for (const [cwd, content] of Object.entries(dockerfileOverrideMap)) {
      files.push({ path: `dockerfiles/${cwd}.Dockerfile`, content });
    }
    format = catalogTemplateId === "tf-enterprise-ecs-fargate-v1" ? "terraform" : TEMPLATES[catalogTemplateId].format;
    templateId = catalogTemplateId;
    applyCommand = rendered.applyCommand;
    rollbackCommand = rendered.rollbackCommand;
    if (Object.keys(healthPathMap).length === 0) {
      // No build-sentinel service set its own health path above — fall back
      // to the single-app-service convention every other template uses.
      const primaryAppName = appServices(renderPlan)[0]?.name;
      if (primaryAppName) healthPathMap[primaryAppName] = typeof variables.health_path === "string" ? variables.health_path : "/";
    }
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
    build_steps: buildSteps,
    resolved_images: resolvedImages,
    dockerfile_override: Object.keys(dockerfileOverrideMap).length > 0 ? dockerfileOverrideMap : null,
    health_path: healthPathMap,
  };

  return { ok: true, value: payload, rawResponse: result.rawResponse, mocked: result.mocked };
}
