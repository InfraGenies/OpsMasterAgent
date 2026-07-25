import JSZip from "jszip";
import { Router } from "express";
import { DecisionActionSchema } from "@ops-master/shared";
import type {
  CapacityPlan,
  ComplianceReport,
  IaCPayload,
  PlanRequest,
  PolicyReport,
  ReadinessReport,
  VerifyReport,
} from "@ops-master/shared";
import { loadLatestNodeOutput } from "../orchestrator/audit.js";
import { HttpError } from "../orchestrator/errors.js";
import { startRun, submitDecision } from "../orchestrator/pipeline.js";
import { getStore } from "../store/index.js";

export const runsRouter = Router();

runsRouter.post("/", async (req, res, next) => {
  try {
    const rawText = String(req.body?.raw_text ?? "").trim();
    if (!rawText) throw new HttpError(400, "raw_text is required");
    const existingEnvId = typeof req.body?.existing_env_id === "string" ? req.body.existing_env_id : null;
    const planOnly = req.body?.mode === "plan_only";
    const requestId = await startRun(rawText, existingEnvId, planOnly);
    res.status(202).json({ request_id: requestId });
  } catch (err) {
    next(err);
  }
});

runsRouter.get("/", async (_req, res, next) => {
  try {
    res.json(await getStore().listRuns());
  } catch (err) {
    next(err);
  }
});

runsRouter.get("/:id", async (req, res, next) => {
  try {
    const store = getStore();
    const run = await store.getRun(req.params.id);
    if (!run) throw new HttpError(404, "run not found");

    const [planRequest, capacityPlan, readinessReport, complianceReport, iacPayload, policyReport, verifyReport, decision] =
      await Promise.all([
        loadLatestNodeOutput<PlanRequest>(store, run.request_id, "intake"),
        loadLatestNodeOutput<CapacityPlan>(store, run.request_id, "planner"),
        loadLatestNodeOutput<ReadinessReport>(store, run.request_id, "readiness_check"),
        loadLatestNodeOutput<ComplianceReport>(store, run.request_id, "compliance_check"),
        loadLatestNodeOutput<IaCPayload>(store, run.request_id, "iac_generator"),
        loadLatestNodeOutput<PolicyReport>(store, run.request_id, "policy_validator"),
        loadLatestNodeOutput<VerifyReport>(store, run.request_id, "verify"),
        store.getDecision(run.request_id),
      ]);

    res.json({
      run,
      plan_request: planRequest,
      capacity_plan: capacityPlan,
      readiness_report: readinessReport,
      compliance_report: complianceReport,
      iac_payload: iacPayload,
      policy_report: policyReport,
      verify_report: verifyReport,
      decision,
    });
  } catch (err) {
    next(err);
  }
});

/** projectNameFor-shaped sanitization for a filename, not a project name — kept local since it's only used for the zip's own download name. */
function sanitizeFilenameSegment(s: string): string {
  return s.replace(/[^a-z0-9._-]+/gi, "-");
}

runsRouter.get("/:id/iac/download", async (req, res, next) => {
  try {
    const store = getStore();
    const run = await store.getRun(req.params.id);
    if (!run) throw new HttpError(404, "run not found");

    const iacPayload = await loadLatestNodeOutput<IaCPayload>(store, run.request_id, "iac_generator");
    if (!iacPayload || iacPayload.files.length === 0) {
      throw new HttpError(404, "no IaC files generated yet for this run");
    }

    const zip = new JSZip();
    for (const file of iacPayload.files) zip.file(file.path, file.content);
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

    const filename = `${sanitizeFilenameSegment(run.request_id)}-iac.zip`;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

runsRouter.get("/:id/audit", async (req, res, next) => {
  try {
    res.json(await getStore().listAuditEvents(req.params.id));
  } catch (err) {
    next(err);
  }
});

runsRouter.post("/:id/decision", async (req, res, next) => {
  try {
    const actionParsed = DecisionActionSchema.safeParse(req.body?.action);
    if (!actionParsed.success) {
      throw new HttpError(
        400,
        `action must be one of ${DecisionActionSchema.options.join("|")}, got "${req.body?.action}"`
      );
    }
    const action = actionParsed.data;
    const comment = typeof req.body?.comment === "string" ? req.body.comment : null;
    const actor = typeof req.body?.actor === "string" && req.body.actor.trim() ? req.body.actor : "operator";
    const capacityPlanPatch =
      action === "edit" && req.body?.capacity_plan_patch && typeof req.body.capacity_plan_patch === "object"
        ? (req.body.capacity_plan_patch as Record<string, unknown>)
        : undefined;

    await submitDecision(req.params.id, action, comment, actor, capacityPlanPatch);
    res.status(200).json({ ok: true });
  } catch (err) {
    next(err);
  }
});
