import type { IaCFile, ManagedControl, PlatformArchetype } from "@ops-master/shared";

/**
 * Phase 2 of the Enterprise Architecture Advisor (see contracts.ts's
 * `terraform_bundle_template_id` doc comment and iacGenerator.ts's
 * mockIacGenerator, which called this "Phase 1 interim... land in Phase 2
 * (enterpriseCatalog.ts)"). Renders REAL, reviewable `.tf` files that
 * actually reflect the chosen archetype + the specific managed controls
 * `enterpriseRulesEngine.ts` recommended — replacing the previous behavior of
 * reusing UC-9's unrelated retail-store-sample-app Terraform template as a
 * stand-in regardless of what controls were actually recommended.
 *
 * Scope: `solo_ecs_fargate` and `team_ecs_fargate_ha` only — the two
 * archetypes every enterprise-mode example exercised so far actually
 * produces (a 2-developer MVP -> solo; a HIPAA startup -> team).
 * `scale_up_eks`/`enterprise_eks_landing_zone` need a structurally different
 * (EKS + ArgoCD GitOps + multi-account landing zone) shape, an order of
 * magnitude larger to build correctly, and are deliberately left on the
 * existing tf-eks-v1/UC-9-reuse stand-in as a separate follow-up — see
 * iacGenerator.ts's enterpriseArchetype branch.
 *
 * Deterministic and entirely backend-rendered, no LLM involved — same
 * discipline as templates/catalog.ts's compose templates.
 */

function tfString(v: string): string {
  return JSON.stringify(v);
}

/** "0.25" vCPU -> 256 Fargate CPU units (1024 units = 1 vCPU). */
function fargateCpuUnits(cpu: string): number {
  return Math.round(parseFloat(cpu) * 1024);
}

/** "512Mi" / "1Gi" -> Fargate task memory in MB. */
function fargateMemoryMb(memory: string): number {
  const m = /^(\d+(?:\.\d+)?)(Mi|Gi)$/.exec(memory);
  if (!m) return 512;
  const value = parseFloat(m[1]);
  return m[2] === "Gi" ? Math.round(value * 1024) : Math.round(value);
}

export interface EnterpriseComputeSpec {
  cpu: string;
  memory: string;
  replicas: number;
}

export interface RenderEnterpriseArchetypeInput {
  archetype: Extract<PlatformArchetype, "solo_ecs_fargate" | "team_ecs_fargate_ha">;
  managedControls: ManagedControl[];
  computeSpec: EnterpriseComputeSpec;
  dbMultiAz: boolean;
  environmentName: string;
}

// ---------------------------------------------------------------------------
// Base compute layer: VPC + ECS Fargate service + ALB + RDS, wrapping the
// well-known terraform-aws-modules registry modules for VPC/ECS rather than
// hand-rolling every primitive — same "wrap a vetted registry module, best
// effort composition for demo purposes" strategy terraformCatalog.ts's own
// UC-9 templates already use, applied to a generic illustrative workload
// instead of the retail-store-sample-app (this archetype's `app` service is
// already explicitly labeled illustrative — see enterpriseRulesEngine.ts's
// buildEnterpriseOptions — there is no concrete application to represent).
// ---------------------------------------------------------------------------

function baseComputeFiles(input: RenderEnterpriseArchetypeInput): IaCFile[] {
  const azCount = input.archetype === "team_ecs_fargate_ha" ? 2 : 1;
  const azs = Array.from({ length: azCount }, (_, i) => `\${data.aws_availability_zones.available.names[${i}]}`);
  const taskCpu = fargateCpuUnits(input.computeSpec.cpu);
  const taskMemory = fargateMemoryMb(input.computeSpec.memory);

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

data "aws_availability_zones" "available" {
  state = "available"
}

# ${input.archetype} base compute layer (Enterprise Architecture Advisor, Phase 2) — an
# illustrative workload sized per the recommended archetype (see ARCHETYPE_REASONING in
# enterpriseRulesEngine.ts), not a specific application: no concrete service topology was
# described in the business-context request this plan came from. Wraps the well-known
# terraform-aws-modules registry modules for VPC/ECS rather than hand-rolling every primitive —
# see this file's module comment.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "\${var.environment_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = slice(data.aws_availability_zones.available.names, 0, var.az_count)
  private_subnets = [for i in range(var.az_count) : cidrsubnet("10.0.0.0/16", 8, i)]
  public_subnets  = [for i in range(var.az_count) : cidrsubnet("10.0.0.0/16", 8, i + 100)]

  enable_nat_gateway = true
  single_nat_gateway  = var.az_count == 1
}

module "ecs_cluster" {
  source  = "terraform-aws-modules/ecs/aws"
  version = "~> 5.0"

  cluster_name = "\${var.environment_name}-cluster"

  fargate_capacity_providers = {
    FARGATE = {}
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/\${var.environment_name}-app"
  retention_in_days = 14
}

resource "aws_iam_role" "ecs_execution" {
  name = "\${var.environment_name}-ecs-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "app" {
  family                   = "\${var.environment_name}-app"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.task_cpu
  memory                   = var.task_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      # Illustrative placeholder — no concrete application was described in the request that
      # produced this plan (see enterpriseRulesEngine.ts's buildEnterpriseOptions); a real
      # engagement would replace this with the client's actual container image.
      image     = "public.ecr.aws/nginx/nginx:latest"
      essential = true
      portMappings = [{ containerPort = 80, protocol = "tcp" }]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.app.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "app"
        }
      }
    }
  ])
}

resource "aws_security_group" "alb" {
  name   = "\${var.environment_name}-alb-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name   = "\${var.environment_name}-app-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "app" {
  name               = "\${var.environment_name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets
}

resource "aws_lb_target_group" "app" {
  name        = "\${var.environment_name}-tg"
  port        = 80
  protocol    = "HTTP"
  vpc_id      = module.vpc.vpc_id
  target_type = "ip"

  health_check {
    path = "/"
  }
}

resource "aws_lb_listener" "app" {
  load_balancer_arn = aws_lb.app.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_service" "app" {
  name            = "\${var.environment_name}-app"
  cluster         = module.ecs_cluster.cluster_id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = module.vpc.private_subnets
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name    = "app"
    container_port    = 80
  }

  depends_on = [aws_lb_listener.app]
}

# Primary data store — every real business workload needs one (see
# enterpriseRulesEngine.ts's buildEnterpriseOptions comment); Multi-AZ if criticality_band is
# high/very_high, single-AZ otherwise.
resource "aws_db_subnet_group" "db" {
  name       = "\${var.environment_name}-db-subnets"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "db" {
  name   = "\${var.environment_name}-db-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_db_instance" "db" {
  identifier                  = "\${var.environment_name}-db"
  engine                       = "postgres"
  engine_version               = "16"
  instance_class                = "db.t4g.micro"
  allocated_storage             = 20
  db_subnet_group_name          = aws_db_subnet_group.db.name
  vpc_security_group_ids        = [aws_security_group.db.id]
  multi_az                      = var.db_multi_az
  username                       = "appuser"
  manage_master_user_password   = true
  skip_final_snapshot            = true
}

output "alb_dns_name" {
  description = "Public URL of the illustrative workload"
  value       = aws_lb.app.dns_name
}
`;

  const variablesTf = `variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "AWS region to deploy into"
}

variable "environment_name" {
  type        = string
  default     = ${tfString(input.environmentName)}
  description = "Name of the environment"
}

variable "az_count" {
  type        = number
  default     = ${azCount}
  description = "Number of AZs — 1 for solo_ecs_fargate, 2+ for team_ecs_fargate_ha (Multi-AZ)"
}

variable "task_cpu" {
  type        = number
  default     = ${taskCpu}
  description = "Fargate task CPU units (1024 = 1 vCPU) — sized per COMPUTE_SPEC_BY_ARCHETYPE"
}

variable "task_memory" {
  type        = number
  default     = ${taskMemory}
  description = "Fargate task memory in MB — sized per COMPUTE_SPEC_BY_ARCHETYPE"
}

variable "desired_count" {
  type        = number
  default     = ${input.computeSpec.replicas}
  description = "Desired ECS task count"
}

variable "db_multi_az" {
  type        = bool
  default     = ${input.dbMultiAz}
  description = "Multi-AZ RDS — true when criticality_band is high or very_high"
}
`;

  const tfvars = `environment_name = ${tfString(input.environmentName)}
az_count         = ${azCount}
task_cpu         = ${taskCpu}
task_memory      = ${taskMemory}
desired_count    = ${input.computeSpec.replicas}
db_multi_az      = ${input.dbMultiAz}
`;

  void azs; // reserved for a future per-AZ resource split; az_count alone drives the module inputs today
  return [
    { path: "main.tf", content: mainTf },
    { path: "variables.tf", content: variablesTf },
    { path: "terraform.tfvars", content: tfvars },
  ];
}

// ---------------------------------------------------------------------------
// Per-control-name Terraform snippets. Keyed by the exact literal `name`
// string enterpriseRulesEngine.ts's `control()`/`archetypeControl()`/
// `criticalityControl()`/`complianceControl()` helpers emit (a closed,
// enumerable set of 15 names) — NOT by terraform_bundle_template_id, since
// one bundle id (e.g. "tf-security-baseline-v1") covers several distinct
// control names across different trigger contexts. Bundle id only decides
// which OUTPUT FILE a control's snippet lands in (see BUNDLE_FILE_NAME +
// renderEnterpriseArchetype below).
// ---------------------------------------------------------------------------

const CONTROL_SNIPPETS: Record<string, () => string> = {
  "AWS Config": () => `# AWS Config — baseline configuration-compliance monitoring
resource "aws_s3_bucket" "config" {
  bucket        = "\${var.environment_name}-config-logs"
  force_destroy = true
}

resource "aws_iam_role" "config" {
  name = "\${var.environment_name}-config-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "config.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "config" {
  role       = aws_iam_role.config.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWS_ConfigRole"
}

resource "aws_config_delivery_channel" "this" {
  name           = "\${var.environment_name}-config-channel"
  s3_bucket_name = aws_s3_bucket.config.id
  depends_on     = [aws_config_configuration_recorder.this]
}

resource "aws_config_configuration_recorder" "this" {
  name     = "\${var.environment_name}-config-recorder"
  role_arn = aws_iam_role.config.arn
}`,

  "AWS Organizations": () => `# AWS Organizations — multi-account governance baseline, control-plane only, no incremental charge
resource "aws_organizations_organization" "this" {
  aws_service_access_principals = [
    "cloudtrail.amazonaws.com",
    "config.amazonaws.com",
    "sso.amazonaws.com",
  ]
  feature_set = "ALL"
}`,

  "AWS Control Tower": () => `# AWS Control Tower — automates landing-zone guardrails (SCPs, account vending) across the
# organization. Illustrative: real Control Tower setup is largely a one-time console/API
# workflow layered on top of the Organization above.
resource "aws_controltower_landing_zone" "this" {
  manifest_json = jsonencode({
    governedRegions = [var.aws_region]
    organizationStructure = {
      security = { name = "Security" }
      sandbox  = { name = "Sandbox" }
    }
  })
  version = "3.3"
}`,

  "AWS IAM Identity Center": () => `# AWS IAM Identity Center — federated single sign-on across every account instead of
# per-account IAM users. Illustrative: the instance itself is typically enabled once via the
# console/Organizations, referenced here as a data source rather than a resource.
data "aws_ssoadmin_instances" "this" {}`,

  "AWS Transit Gateway": () => `# AWS Transit Gateway — central hub for inter-account/VPC networking
resource "aws_ec2_transit_gateway" "this" {
  description                     = "\${var.environment_name} inter-account/VPC transit gateway"
  auto_accept_shared_attachments   = "enable"
  default_route_table_association = "enable"
  default_route_table_propagation = "enable"
}`,

  "AWS Backup": () => `# AWS Backup — automated, policy-driven backup plan
resource "aws_backup_vault" "this" {
  name = "\${var.environment_name}-backup-vault"
}

resource "aws_iam_role" "backup" {
  name = "\${var.environment_name}-backup-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "backup.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "backup" {
  role       = aws_iam_role.backup.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup"
}

resource "aws_backup_plan" "this" {
  name = "\${var.environment_name}-backup-plan"

  rule {
    rule_name         = "daily"
    target_vault_name = aws_backup_vault.this.name
    schedule          = "cron(0 5 * * ? *)"

    lifecycle {
      delete_after = 35
    }
  }
}

resource "aws_backup_selection" "this" {
  name         = "\${var.environment_name}-backup-selection"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.db.arn]
}`,

  "Amazon GuardDuty": () => `# Amazon GuardDuty — continuous threat detection
resource "aws_guardduty_detector" "this" {
  enable = true
}`,

  "AWS WAF": () => `# AWS WAF — web application firewall in front of the internet-facing ALB
resource "aws_wafv2_web_acl" "this" {
  name  = "\${var.environment_name}-waf"
  scope = "REGIONAL"

  default_action {
    allow {}
  }

  rule {
    name     = "aws-managed-common-rules"
    priority = 1

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "\${var.environment_name}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "\${var.environment_name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.app.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}`,

  "AWS Security Hub": () => `# AWS Security Hub — centralized security-findings aggregation
resource "aws_securityhub_account" "this" {}`,

  "AWS CloudTrail": () => `# AWS CloudTrail — organization-wide audit trail with log-file validation
resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "\${var.environment_name}-cloudtrail-logs"
  force_destroy = true
}

resource "aws_s3_bucket_policy" "cloudtrail" {
  bucket = aws_s3_bucket.cloudtrail.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AWSCloudTrailAclCheck"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:GetBucketAcl"
        Resource  = aws_s3_bucket.cloudtrail.arn
      },
      {
        Sid       = "AWSCloudTrailWrite"
        Effect    = "Allow"
        Principal = { Service = "cloudtrail.amazonaws.com" }
        Action    = "s3:PutObject"
        Resource  = "\${aws_s3_bucket.cloudtrail.arn}/*"
        Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } }
      }
    ]
  })
}

resource "aws_cloudtrail" "this" {
  name                          = "\${var.environment_name}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.cloudtrail]
}`,

  "AWS KMS": () => `# AWS KMS — customer-managed encryption keys instead of AWS-managed defaults
resource "aws_kms_key" "this" {
  description             = "\${var.environment_name} customer-managed key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "this" {
  name          = "alias/\${var.environment_name}"
  target_key_id = aws_kms_key.this.key_id
}`,

  "AWS Secrets Manager": () => `# AWS Secrets Manager — rotated, audited secret storage instead of hardcoded credentials
resource "aws_secretsmanager_secret" "db" {
  name = "\${var.environment_name}-db-credentials"
}`,

  "AWS Shield Advanced": () => `# AWS Shield Advanced — advanced DDoS protection beyond the Shield Standard default,
# protecting the internet-facing ALB
resource "aws_shield_protection" "this" {
  name         = "\${var.environment_name}-shield"
  resource_arn = aws_lb.app.arn
}`,

  "Aurora Global Database": () => `# Aurora Global Database — cross-region-replicated primary data store for very_high
# criticality with tight RPO/RTO. Illustrative: shown alongside the base module's single-region
# aws_db_instance for review — a real deployment replaces that instance with this Aurora
# cluster rather than running both.
resource "aws_rds_global_cluster" "this" {
  global_cluster_identifier = "\${var.environment_name}-global"
  engine                    = "aurora-postgresql"
  engine_version            = "15.4"
  database_name             = "appdb"
  storage_encrypted         = true
}

resource "aws_rds_cluster" "primary" {
  cluster_identifier           = "\${var.environment_name}-aurora-primary"
  engine                       = aws_rds_global_cluster.this.engine
  engine_version               = aws_rds_global_cluster.this.engine_version
  global_cluster_identifier    = aws_rds_global_cluster.this.id
  master_username              = "appuser"
  manage_master_user_password  = true
  db_subnet_group_name         = aws_db_subnet_group.db.name
  skip_final_snapshot          = true
}`,

  "Amazon Route 53 (health-check failover)": () => `# Amazon Route 53 health-check failover routing — automated regional failover
variable "dns_zone_name" {
  type        = string
  default     = "example.com"
  description = "Existing Route 53 hosted zone to add the failover record to — replace with the real domain before use"
}

data "aws_route53_zone" "this" {
  name = var.dns_zone_name
}

resource "aws_route53_health_check" "primary" {
  fqdn              = aws_lb.app.dns_name
  port              = 80
  type              = "HTTP"
  resource_path     = "/"
  request_interval  = 30
  failure_threshold = 3
}

resource "aws_route53_record" "primary" {
  zone_id = data.aws_route53_zone.this.zone_id
  name    = "\${var.environment_name}.\${var.dns_zone_name}"
  type    = "A"

  failover_routing_policy {
    type = "PRIMARY"
  }
  set_identifier  = "primary"
  health_check_id = aws_route53_health_check.primary.id

  alias {
    name                   = aws_lb.app.dns_name
    zone_id                = aws_lb.app.zone_id
    evaluate_target_health = true
  }
}`,
};

/** Which output .tf file a bundle's controls land in — grouping only, the resource content itself comes from CONTROL_SNIPPETS above. */
const BUNDLE_FILE_NAME: Record<string, string> = {
  "tf-security-baseline-v1": "security-baseline.tf",
  "tf-landing-zone-v1": "landing-zone.tf",
  "tf-network-transit-gateway-v1": "network-transit-gateway.tf",
  "tf-backup-v1": "backup.tf",
  "tf-shield-advanced-v1": "shield-advanced.tf",
  "tf-data-aurora-global-v1": "aurora-global.tf",
  "tf-dns-failover-v1": "dns-failover.tf",
};

/**
 * Entirely deterministic (no LLM), mirroring templates/catalog.ts's compose
 * templates. Groups `managedControls` by `terraform_bundle_template_id` into
 * separate output files; controls with a null bundle id (e.g. IAM Identity
 * Center under the HIPAA-only overlay — see enterpriseRulesEngine.ts's
 * complianceOverlayControls, "deliberately no bundle") render nothing, by
 * design, not by omission.
 */
export function renderEnterpriseArchetype(input: RenderEnterpriseArchetypeInput): IaCFile[] {
  const files: IaCFile[] = [...baseComputeFiles(input)];

  const namesByBundle = new Map<string, string[]>();
  for (const control of input.managedControls) {
    if (!control.terraform_bundle_template_id) continue;
    const names = namesByBundle.get(control.terraform_bundle_template_id) ?? [];
    if (!names.includes(control.name)) names.push(control.name);
    namesByBundle.set(control.terraform_bundle_template_id, names);
  }

  for (const [bundleId, names] of namesByBundle) {
    const snippets = names.map((name) => CONTROL_SNIPPETS[name]?.()).filter((s): s is string => !!s);
    if (!snippets.length) continue;
    files.push({
      path: BUNDLE_FILE_NAME[bundleId] ?? `${bundleId}.tf`,
      content:
        `# Managed controls (Enterprise Architecture Advisor): ${names.join(", ")}\n` +
        `# Rendered deterministically from architecture_recommendation.managed_controls — never LLM-written.\n\n` +
        snippets.join("\n\n") +
        "\n",
    });
  }

  return files;
}
