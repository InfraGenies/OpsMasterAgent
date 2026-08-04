variable "aws_region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Short name used to prefix/tag every resource this stack creates."
  type        = string
  default     = "ops-master-agent"
}

variable "image_tag" {
  description = "Image tag in ECR to deploy (git SHA — set by GitHub Actions on each deploy)."
  type        = string
  default     = "latest"
}

variable "fargate_cpu" {
  description = "Fargate task CPU units (256 = .25 vCPU, 512 = .5 vCPU)."
  type        = number
  default     = 512
}

variable "fargate_memory" {
  description = "Fargate task memory in MB."
  type        = number
  default     = 1024
}

variable "desired_count" {
  description = "ECS service desired task count. Set to 0 to stop paying for the Fargate task between demos (the ALB keeps running)."
  type        = number
  default     = 1
}

variable "github_repo" {
  description = "GitHub repo allowed to assume the deploy role, as org/repo."
  type        = string
  default     = "CybHackathon-2026/Hi-Tech_INFRAGenies"
}

variable "github_deploy_branch" {
  description = "Branch allowed to assume the deploy role via OIDC."
  type        = string
  default     = "main"
}

variable "supabase_url" {
  description = "Supabase project URL (not secret — the service-role key is what's protected, in Secrets Manager)."
  type        = string
}

variable "bedrock_model_id" {
  description = "Region-prefixed Bedrock inference profile ID, e.g. us.anthropic.claude-sonnet-4-5-20250929-v1:0."
  type        = string
  default     = "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
}
