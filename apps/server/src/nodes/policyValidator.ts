import type { CapacityPlanOption, IaCPayload, PlanRequest, PolicyFinding, PolicyReport } from "@ops-master/shared";

/**
 * Deterministic policy/security scan of a rendered IaCPayload — no LLM.
 * Runs after every iac_generator attempt (03b-policy-validator.md). Most of
 * these checks can't actually fire today: compose structure (images, ports,
 * privileged/network_mode) comes from fixed template code in
 * templates/catalog.ts driven by the CapacityPlan, which the iac_generator
 * LLM never touches — it only picks a template_id and fills a small
 * variable bag. They exist anyway as regression guards against future
 * template or model drift; weak_default_secret is the one finding the LLM
 * can actually cause and fix today.
 */

const WEAK_SECRETS = new Set(["password", "admin", "changeme", "root", "123456", "secret"]);

function scanFiles(
  payload: IaCPayload,
  regex: RegExp,
  ruleId: string,
  severity: PolicyFinding["severity"],
  message: string,
  autoFixable: boolean
): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  for (const file of payload.files) {
    if (regex.test(file.content)) {
      findings.push({ rule_id: ruleId, severity, message, file: file.path, auto_fixable: autoFixable });
    }
  }
  return findings;
}

function checkStructural(payload: IaCPayload): PolicyFinding[] {
  if (payload.validation.ok) return [];
  return [
    {
      rule_id: "structural_invalid",
      severity: "critical",
      message: `${payload.validation.tool} rejected the rendered files: ${payload.validation.output}`,
      file: null,
      auto_fixable: false,
    },
  ];
}

function checkWeakSecrets(payload: IaCPayload): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const linePattern = /([A-Za-z0-9_]*(?:PASSWORD|SECRET)[A-Za-z0-9_]*)\s*[:=]\s*['"]?([^'"\n]+?)['"]?\s*$/gim;
  for (const file of payload.files) {
    for (const match of file.content.matchAll(linePattern)) {
      const value = match[2].trim();
      if (WEAK_SECRETS.has(value.toLowerCase())) {
        findings.push({
          rule_id: "weak_default_secret",
          severity: "high",
          message: `${match[1]} in ${file.path} is set to a common default value ("${value}") instead of a generated secret`,
          file: file.path,
          auto_fixable: true,
        });
      }
    }
  }
  return findings;
}

function checkUnpinnedImages(payload: IaCPayload): PolicyFinding[] {
  const findings: PolicyFinding[] = [];
  const imagePattern = /image:\s*([^\s#]+)/g;
  for (const file of payload.files) {
    for (const match of file.content.matchAll(imagePattern)) {
      const image = match[1].trim();
      const tag = image.includes(":") ? image.split(":").pop()! : null;
      if (tag === null || tag === "latest") {
        findings.push({
          rule_id: "unpinned_image_tag",
          severity: "high",
          message: `image "${image}" in ${file.path} is not pinned to an explicit version tag`,
          file: file.path,
          auto_fixable: false,
        });
      }
    }
  }
  return findings;
}

function checkUnexpectedPorts(payload: IaCPayload, plan: CapacityPlanOption): PolicyFinding[] {
  // Terraform/AWS plans never populate network.expose (AWS networking is
  // ALB/VPC-based, not host port mapping) — a compose-shaped "host:container
  // port" regex has nothing meaningful to check against for this format and
  // would only ever false-positive, so skip it entirely.
  if (payload.format === "terraform") return [];
  const allowed = new Set(plan.network.expose.map((e) => e.host_port));
  const findings: PolicyFinding[] = [];
  const portPattern = /-\s*['"]?(\d+):(\d+)['"]?/g;
  for (const file of payload.files) {
    for (const match of file.content.matchAll(portPattern)) {
      const hostPort = Number(match[1]);
      if (!allowed.has(hostPort)) {
        findings.push({
          rule_id: "unexpected_published_port",
          severity: "medium",
          message: `host port ${hostPort} is published in ${file.path} but is not declared in the approved plan's network.expose`,
          file: file.path,
          auto_fixable: false,
        });
      }
    }
  }
  return findings;
}

function checkProdReplicas(plan: CapacityPlanOption, planRequest: PlanRequest): PolicyFinding[] {
  if (!/prod/i.test(planRequest.environment)) return [];
  const findings: PolicyFinding[] = [];
  const exposedNames = new Set(plan.network.expose.map((e) => e.service));
  for (const svc of plan.services) {
    if (exposedNames.has(svc.name) && svc.replicas < 2) {
      findings.push({
        rule_id: "prod_single_replica",
        severity: "medium",
        message: `service "${svc.name}" is internet-facing in a production environment but has only ${svc.replicas} replica — no failover if the container restarts`,
        file: null,
        auto_fixable: false,
      });
    }
  }
  return findings;
}

export function runPolicyValidator(
  payload: IaCPayload,
  plan: CapacityPlanOption,
  planRequest: PlanRequest,
  attempts: number
): PolicyReport {
  const findings: PolicyFinding[] = [
    ...checkStructural(payload),
    ...scanFiles(payload, /privileged:\s*true/i, "privileged_container", "critical", "a service runs in privileged mode", false),
    ...scanFiles(
      payload,
      /network_mode:\s*["']?host/i,
      "host_network",
      "critical",
      "a service uses host networking, bypassing container network isolation",
      false
    ),
    ...scanFiles(
      payload,
      /\/var\/run\/docker\.sock/i,
      "docker_socket_mount",
      "critical",
      "a service mounts the host Docker socket, granting it host-level control",
      false
    ),
    ...checkWeakSecrets(payload),
    ...checkUnpinnedImages(payload),
    ...checkUnexpectedPorts(payload, plan),
    ...checkProdReplicas(plan, planRequest),
  ];

  const passed = findings.every((f) => f.severity !== "critical" && f.severity !== "high");
  return { request_id: payload.request_id, findings, passed, attempts };
}
