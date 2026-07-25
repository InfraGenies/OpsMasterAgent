import { completeRaw, isMockMode } from "../llm/client.js";
import type { AuditEvent, CapacityPlanOption, PlanRequest, Run, VerifyReport } from "@ops-master/shared";

export interface ReportInput {
  run: Run;
  planRequest?: PlanRequest;
  capacityPlan?: CapacityPlanOption;
  verifyReport?: VerifyReport;
  auditEvents: AuditEvent[];
  refusalReason?: string;
}

function deterministicReport(input: ReportInput): string {
  const lines: string[] = [];
  lines.push(`# Deployment Report — ${input.run.request_id}`);
  lines.push("");
  lines.push(`**Status:** ${input.run.status}`);
  lines.push(`**Request:** ${input.run.raw_text}`);
  lines.push("");

  if (input.refusalReason) {
    lines.push(`## Outcome`);
    lines.push(input.refusalReason);
    lines.push("");
  } else if (input.capacityPlan) {
    lines.push(`## Capacity Plan — ${input.capacityPlan.tier} tier (~$${input.capacityPlan.estimated_cost_usd_monthly}/mo estimated)`);
    lines.push(input.capacityPlan.reasoning);
    lines.push("");
    lines.push("| Service | Image | CPU | Memory | Replicas |");
    lines.push("|---|---|---|---|---|");
    for (const s of input.capacityPlan.services) {
      lines.push(`| ${s.name} | ${s.image} | ${s.cpu} | ${s.memory} | ${s.replicas} |`);
    }
    lines.push("");
  }

  if (input.verifyReport) {
    lines.push(`## Verify — ${input.verifyReport.verdict.toUpperCase()}`);
    lines.push(input.verifyReport.summary);
    lines.push("");
    lines.push(`Endpoints: ${input.verifyReport.endpoints.join(", ") || "none"}`);
    if (input.verifyReport.rolled_back) lines.push("\n**Environment was rolled back.**");
    lines.push("");
  }

  lines.push(`## Audit Timeline (${input.auditEvents.length} events)`);
  for (const e of input.auditEvents) {
    lines.push(`- \`${e.ts}\` **${e.node}** (${e.actor}) — ${e.status}: ${e.detail}`);
  }
  return lines.join("\n");
}

/** 07-audit-store.md: report narrative is the one place an LLM writes prose over already-final facts; falls back to a deterministic markdown build on any LLM failure so the report never blocks on it. */
export async function runReport(input: ReportInput): Promise<string> {
  if (isMockMode()) return deterministicReport(input);
  try {
    return await completeRaw(
      "You write concise, factual infrastructure deployment reports for a human operator. " +
        "Use ONLY the JSON facts given to you — never invent numbers, endpoints, or verdicts. " +
        "Markdown, under 300 words, include a services table if services are present.",
      JSON.stringify(input, null, 2)
    );
  } catch {
    return deterministicReport(input);
  }
}
