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
 * composition for demo purposes; the important, load-bearing fact is that
 * nothing in this sandbox ever runs `terraform apply` regardless (see
 * commandAllowList.ts) — only `init`/`validate`/`plan`, so a real `terraform`
 * CLI + network access is exercised only as far as producing a plan, never
 * touching a real AWS account.
 */

function tfString(v: string): string {
  return JSON.stringify(v);
}

const tfEcsFargateV1: TemplateDefinition = {
  id: "tf-ecs-fargate-v1",
  format: "terraform",
  description: "AWS ECS Fargate, single-AZ — economy tier for UC-9 (retail-store-sample-app, fills the repo's own terraform/ecs/default module)",
  render(_plan, variables, ctx): RenderResult {
    const environmentName = typeof variables.environment_name === "string" ? variables.environment_name : ctx.projectName;
    const logRetentionDays = typeof variables.log_group_retention_days === "number" ? variables.log_group_retention_days : 7;

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

# Economy tier (UC-9): fills the upstream retail-store-sample-app's own
# terraform/ecs/default module — see terraformCatalog.ts's module comment for
# the provider-block caveat. Never applied in this sandbox, plan-only.
module "retail_store" {
  source = "github.com/aws-containers/retail-store-sample-app//terraform/ecs/default?ref=main"

  environment_name           = var.environment_name
  container_insights_setting = var.container_insights_setting
  opentelemetry_enabled      = false
  lifecycle_events_enabled   = false
  log_group_retention_days   = var.log_group_retention_days
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

variable "log_group_retention_days" {
  type        = number
  default     = ${logRetentionDays}
  description = "CloudWatch log retention — short for the economy tier"
}
`;

    const tfvars = `environment_name           = ${tfString(environmentName)}
container_insights_setting = "disabled"
log_group_retention_days   = ${logRetentionDays}
`;

    return {
      files: [
        { path: "main.tf", content: mainTf },
        { path: "variables.tf", content: variablesTf },
        { path: "terraform.tfvars", content: tfvars },
      ],
      applyCommand:
        "terraform init -backend=false -input=false -no-color && terraform plan -input=false -no-color -out=tfplan",
      rollbackCommand: "n/a — plan-only (apply/destroy are not in the allow-list), so nothing is ever applied and there is nothing to roll back",
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
# module comment for the provider-block caveat. Never applied in this
# sandbox, plan-only.
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
      rollbackCommand: "n/a — plan-only (apply/destroy are not in the allow-list), so nothing is ever applied and there is nothing to roll back",
    };
  },
};

export const TERRAFORM_TEMPLATES: Record<"tf-ecs-fargate-v1" | "tf-eks-v1", TemplateDefinition> = {
  "tf-ecs-fargate-v1": tfEcsFargateV1,
  "tf-eks-v1": tfEksV1,
};
