import type { ArchitectureRecommendation, ComplianceControlFinding, ComplianceReport, ComplianceTarget } from "@ops-master/shared";

/**
 * Deterministic compliance-framework gap analysis (02c-compliance-check.md)
 * — no LLM, run once pre-flight alongside readiness_check, not a retry loop
 * like policy_validator: every finding here is rooted in
 * ArchitectureRecommendation.managed_controls, a planner-time decision
 * iac_generator has no lever over, so there is nothing an auto-fix retry
 * could change. The control->service mapping below is illustrative — a demo
 * gap-analysis, not audited against PCI-DSS v4/HIPAA Security Rule text
 * verbatim. A real compliance review should replace this table before it's
 * presented as anything more.
 */

interface MandatoryControl {
  control_id: string;
  message: string;
  /** Must exactly match a ManagedControl.name produced by enterpriseRulesEngine.ts. */
  satisfied_if_control: string;
}

const MANDATORY_CONTROLS: Record<Exclude<ComplianceTarget, "none">, MandatoryControl[]> = {
  pci_dss: [
    {
      control_id: "PCI-DSS-2.2",
      message: "Configuration standards must be enforced for all system components.",
      satisfied_if_control: "AWS Config",
    },
    {
      control_id: "PCI-DSS-3.4",
      message: "Cardholder data must be encrypted at rest using strong cryptography.",
      satisfied_if_control: "AWS KMS",
    },
    {
      control_id: "PCI-DSS-6.6",
      message: "Public-facing web applications must sit behind a web application firewall.",
      satisfied_if_control: "AWS WAF",
    },
    {
      control_id: "PCI-DSS-8.2",
      message: "Credentials must be managed and rotated, not hardcoded.",
      satisfied_if_control: "AWS Secrets Manager",
    },
    {
      control_id: "PCI-DSS-10.2",
      message: "Audit logging with log-file validation is required for all system components.",
      satisfied_if_control: "AWS CloudTrail",
    },
  ],
  hipaa: [
    {
      control_id: "HIPAA-164.308(a)(1)",
      message: "Ongoing security-configuration review is required.",
      satisfied_if_control: "AWS Config",
    },
    {
      control_id: "HIPAA-164.308(a)(7)",
      message: "A documented contingency/backup plan is required for ePHI.",
      satisfied_if_control: "AWS Backup",
    },
    {
      control_id: "HIPAA-164.312(a)(1)",
      message: "Unique-user identification and access control is required.",
      satisfied_if_control: "AWS IAM Identity Center",
    },
    {
      control_id: "HIPAA-164.312(a)(2)(iv)",
      message: "ePHI must be encrypted at rest.",
      satisfied_if_control: "AWS KMS",
    },
    {
      control_id: "HIPAA-164.312(b)",
      message: "Audit controls over ePHI access are required.",
      satisfied_if_control: "AWS CloudTrail",
    },
  ],
  soc2: [
    {
      control_id: "SOC2-CC6.1",
      message: "Logical access security controls are required.",
      satisfied_if_control: "AWS IAM Identity Center",
    },
    {
      control_id: "SOC2-CC7.2",
      message: "System monitoring for security anomalies/threats is required.",
      satisfied_if_control: "Amazon GuardDuty",
    },
  ],
};

export function runComplianceCheck(recommendation: ArchitectureRecommendation, requestId: string): ComplianceReport {
  const frameworks = recommendation.compliance_overlay.filter(
    (t): t is Exclude<ComplianceTarget, "none"> => t !== "none"
  );
  const controlNames = new Set(recommendation.managed_controls.map((c) => c.name));

  const findings: ComplianceControlFinding[] = frameworks.flatMap((framework) =>
    MANDATORY_CONTROLS[framework].map((mc): ComplianceControlFinding => {
      const satisfied = controlNames.has(mc.satisfied_if_control);
      return {
        control_id: mc.control_id,
        framework,
        status: satisfied ? "satisfied" : "gap",
        severity: "high",
        message: mc.message,
        satisfied_by: satisfied ? mc.satisfied_if_control : null,
      };
    })
  );

  const gap_count = findings.filter((f) => f.status === "gap").length;
  const passed = !findings.some((f) => f.status === "gap" && (f.severity === "critical" || f.severity === "high"));

  return { request_id: requestId, frameworks, findings, passed, gap_count };
}
