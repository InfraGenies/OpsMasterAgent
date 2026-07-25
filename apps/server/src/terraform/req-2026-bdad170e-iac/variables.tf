variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to deploy into"
}

variable "environment_name" {
  type        = string
  default     = "req-2026-bdad170e"
  description = "Name of the environment"
}

variable "az_count" {
  type        = number
  default     = 2
  description = "Number of AZs — 1 for solo_ecs_fargate, 2+ for team_ecs_fargate_ha (Multi-AZ)"
}

variable "task_cpu" {
  type        = number
  default     = 512
  description = "Fargate task CPU units (1024 = 1 vCPU) — sized per COMPUTE_SPEC_BY_ARCHETYPE"
}

variable "task_memory" {
  type        = number
  default     = 1024
  description = "Fargate task memory in MB — sized per COMPUTE_SPEC_BY_ARCHETYPE"
}

variable "desired_count" {
  type        = number
  default     = 2
  description = "Desired ECS task count"
}

variable "db_multi_az" {
  type        = bool
  default     = false
  description = "Multi-AZ RDS — true when criticality_band is high or very_high"
}
