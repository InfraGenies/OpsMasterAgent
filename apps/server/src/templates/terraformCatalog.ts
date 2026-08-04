import { isAwsApplyEnabled } from "../nodes/commandAllowList.js";
import type { RenderContext, RenderResult, TemplateDefinition } from "./types.js";

/**
 * UC-9 (agent-md-files/USE_CASES.md): fills AWS's own retail-store-sample-app
 * Terraform modules rather than hand-rolling ECS/EKS/RDS/DynamoDB/ElastiCache
 * resources from scratch, matching the "LLM picks a template, backend
 * renders" discipline the compose templates already use, extended to a
 * second IaCPayload.format ("terraform").
 *
 * That repo's terraform/{ecs,eks}/default directories are themselves root
 * configs (versions.tf declares its own bare `provider "aws" {}`, and the
 * README's usage instructions are "cd into that directory and terraform
 * init/plan/apply directly" — they are not published as a reusable child
 * module). Referencing them via a `module` block here is a best-effort
 * composition for demo purposes; by default nothing in this sandbox ever
 * runs `terraform apply` (see commandAllowList.ts) — only
 * `init`/`validate`/`plan`. ALLOW_AWS_APPLY=true (demo-machine-only, see
 * config.ts) is the one gated exception, wired through nodes/deploy.ts —
 * `isAwsApplyEnabled()` below only changes the *descriptive* strings this
 * file renders (comments, applyCommand/rollbackCommand) to stay accurate
 * about which mode produced them; it never itself decides whether apply
 * actually runs.
 */

function tfString(v: string): string {
  return JSON.stringify(v);
}

const APPLY_NOTE = () =>
  isAwsApplyEnabled()
    ? "ALLOW_AWS_APPLY is on for this run — a real `terraform apply` follows a clean plan (see nodes/deploy.ts)."
    : "Never applied in this sandbox, plan-only.";

const tfEcsFargateV1: TemplateDefinition = {
  id: "tf-ecs-fargate-v1",
  format: "terraform",
  description: "AWS ECS Fargate, single-AZ — economy tier for UC-9 (retail-store-sample-app, fills the repo's own terraform/ecs/default module)",
  render(_plan, variables, ctx): RenderResult {
    const environmentName = typeof variables.environment_name === "string" ? variables.environment_name : ctx.projectName;

    const mainTf = `terraform {
  required_version = ">= 1.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region  = var.aws_region
  profile = var.aws_profile
}

# Economy tier (UC-9): fills the upstream retail-store-sample-app's own
# terraform/ecs/default module — see terraformCatalog.ts's module comment for
# the provider-block caveat. ${APPLY_NOTE()}
module "retail_store" {
  source = "github.com/aws-containers/retail-store-sample-app//terraform/ecs/default?ref=main"

  environment_name           = var.environment_name
  container_insights_setting = var.container_insights_setting
  opentelemetry_enabled      = false
  lifecycle_events_enabled   = false
}

output "application_url" {
  description = "URL where the application can be accessed"
  value       = module.retail_store.application_url
}
`;

    const variablesTf = `variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to deploy into"
}

variable "aws_profile" {
  type        = string
  default     = null
  description = <<-EOT
    Named AWS CLI profile to authenticate with (from ~/.aws/credentials, set up via \`aws configure
    --profile <name>\`). Leave null to fall back to the default credential chain (AWS_ACCESS_KEY_ID /
    AWS_SECRET_ACCESS_KEY env vars, an EC2/ECS instance role, etc.). Only consulted at all when this
    run's ALLOW_AWS_APPLY is on — a plan-only run needs no real credentials.
    NEVER put access keys or secrets directly in this file or in terraform.tfvars.
  EOT
}

variable "environment_name" {
  type        = string
  default     = ${tfString(environmentName)}
  description = "Name of the environment (passed through to the upstream module)"
}

variable "container_insights_setting" {
  type        = string
  default     = "disabled"
  description = "\\"disabled\\" keeps the economy tier cheap — no extra Container Insights cost"
}
`;

    const tfvars = `# --- Edit for your own AWS account before a real apply (aws_region / aws_profile) ---
# aws_profile = "my-aws-profile"   # named profile from ~/.aws/credentials, or leave unset for the
#                                  # default credential chain. NEVER put an access key/secret here.
#
# Cost safety: after "terraform apply" succeeds, run .\\schedule-auto-destroy.ps1 (defaults to 10
# minutes, pass -Minutes to change it) so a forgotten demo deployment doesn't keep billing. Run
# .\\cancel-auto-destroy.ps1 to cancel it and keep resources running longer instead.

environment_name           = ${tfString(environmentName)}
container_insights_setting = "disabled"
`;

    const taskName = `OpsMasterAgent-AutoDestroy-${environmentName}`;
    const scheduleAutoDestroyPs1 = `<#
.SYNOPSIS
  Cost-safety timer: schedules "terraform destroy -auto-approve" to run automatically in this
  same folder after a delay, so a real AWS deploy started for a demo doesn't keep billing if
  someone forgets to tear it down.

.DESCRIPTION
  Run this AFTER "terraform apply" has succeeded (ALLOW_AWS_APPLY=true runs). It registers a
  ONE-SHOT Windows Task Scheduler job (not a foreground sleep loop) so it still fires even if this
  terminal window is closed, but it does NOT fire if this machine is asleep/off/logged-out at the
  scheduled time. If you might close your laptop before the timer fires, destroy manually instead.

.PARAMETER Minutes
  Delay before auto-destroy runs. Defaults to 10.

.EXAMPLE
  .\\schedule-auto-destroy.ps1
  .\\schedule-auto-destroy.ps1 -Minutes 60
#>
param(
  [int]$Minutes = 10
)

$deployDir = $PSScriptRoot
$taskName = ${tfString(taskName)}
$runAt = (Get-Date).AddMinutes($Minutes)

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "A task named '$taskName' already exists (from an earlier run) - replacing it."
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "terraform.exe" -Argument "destroy -auto-approve" -WorkingDirectory $deployDir
$trigger = New-ScheduledTaskTrigger -Once -At $runAt
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Description "OpsMasterAgent cost-safety auto-destroy for $deployDir" | Out-Null

Write-Host "Scheduled: 'terraform destroy -auto-approve' will run in $deployDir at $runAt (in $Minutes minutes)."
Write-Host "Changed your mind? Cancel with:"
Write-Host "  Unregister-ScheduledTask -TaskName '$taskName' -Confirm:\`$false"
Write-Host "(or just run .\\cancel-auto-destroy.ps1 from this same folder)"
`;

    const cancelAutoDestroyPs1 = `<#
.SYNOPSIS
  Cancels the auto-destroy timer scheduled by schedule-auto-destroy.ps1 for this deployment,
  without destroying anything - use this if you want to keep the resources running longer.
#>
$taskName = ${tfString(taskName)}
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "No pending auto-destroy task named '$taskName' found (already ran, already cancelled, or never scheduled)."
} else {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Cancelled - 'terraform destroy' will NOT run automatically. Remember to destroy manually when you're done."
}
`;

    return {
      files: [
        { path: "main.tf", content: mainTf },
        { path: "variables.tf", content: variablesTf },
        { path: "terraform.tfvars", content: tfvars },
        { path: "schedule-auto-destroy.ps1", content: scheduleAutoDestroyPs1 },
        { path: "cancel-auto-destroy.ps1", content: cancelAutoDestroyPs1 },
      ],
      applyCommand:
        "terraform init -backend=false -input=false -no-color && terraform plan -input=false -no-color -out=tfplan",
      rollbackCommand: isAwsApplyEnabled()
        ? "terraform destroy -input=false -no-color -auto-approve (real — ALLOW_AWS_APPLY is on for this run)"
        : "n/a — plan-only (ALLOW_AWS_APPLY is off), so nothing is ever applied and there is nothing to roll back",
    };
  },
};

const tfEksV1: TemplateDefinition = {
  id: "tf-eks-v1",
  format: "terraform",
  description: "AWS EKS, Multi-AZ — high_availability tier for UC-9 (retail-store-sample-app, fills the repo's own terraform/eks/default module)",
  render(_plan, variables, ctx): RenderResult {
    const environmentName = typeof variables.environment_name === "string" ? variables.environment_name : ctx.projectName;

    const mainTf = `terraform {
  required_version = ">= 1.0.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

# High-availability tier (UC-9): fills the upstream retail-store-sample-app's
# own terraform/eks/default module — managed control plane + worker nodes
# across multiple AZs, Multi-AZ RDS/ElastiCache. See terraformCatalog.ts's
# module comment for the provider-block caveat. ${APPLY_NOTE()} Note: EKS
# create/destroy each take ~15-20 minutes — the ECS Fargate economy tier
# (tf-ecs-fargate-v1) is the one built out for a short live-apply demo.
module "retail_store" {
  source = "github.com/aws-containers/retail-store-sample-app//terraform/eks/default?ref=main"

  environment_name      = var.environment_name
  istio_enabled         = false
  opentelemetry_enabled = var.opentelemetry_enabled
}

output "configure_kubectl" {
  description = "Command to update kubeconfig for this cluster"
  value       = module.retail_store.configure_kubectl
}

output "retail_app_url" {
  description = "URL to access the retail store application"
  value       = module.retail_store.retail_app_url
}
`;

    const variablesTf = `variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to deploy into"
}

variable "environment_name" {
  type        = string
  default     = ${tfString(environmentName)}
  description = "Name of the environment (passed through to the upstream module)"
}

variable "opentelemetry_enabled" {
  type        = bool
  default     = true
  description = "HA tier enables tracing/observability by default"
}
`;

    const tfvars = `environment_name      = ${tfString(environmentName)}
opentelemetry_enabled = true
`;

    return {
      files: [
        { path: "main.tf", content: mainTf },
        { path: "variables.tf", content: variablesTf },
        { path: "terraform.tfvars", content: tfvars },
      ],
      applyCommand:
        "terraform init -backend=false -input=false -no-color && terraform plan -input=false -no-color -out=tfplan",
      rollbackCommand: isAwsApplyEnabled()
        ? "terraform destroy -input=false -no-color -auto-approve (real — ALLOW_AWS_APPLY is on for this run; expect ~15-20 minutes)"
        : "n/a — plan-only (ALLOW_AWS_APPLY is off), so nothing is ever applied and there is nothing to roll back",
    };
  },
};

export const TERRAFORM_TEMPLATES: Record<"tf-ecs-fargate-v1" | "tf-eks-v1", TemplateDefinition> = {
  "tf-ecs-fargate-v1": tfEcsFargateV1,
  "tf-eks-v1": tfEksV1,
};
