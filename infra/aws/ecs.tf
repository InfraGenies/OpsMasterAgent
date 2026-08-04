resource "aws_ecs_cluster" "app" {
  name = "${var.project_name}-cluster"

  setting {
    name  = "containerInsights"
    value = "disabled" # extra CloudWatch cost, not needed for a demo
  }

  tags = { Project = var.project_name }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.project_name}"
  retention_in_days = 14

  tags = { Project = var.project_name }
}

# --- Task execution role: pulls the image from ECR + fetches the Secrets
# Manager values referenced below, on the ECS agent's behalf before the
# container even starts. Distinct from the task role (below), which is what
# the running application code itself would assume. ---
data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${var.project_name}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "task_execution_secrets" {
  statement {
    actions = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.anthropic_api_key.arn,
      aws_secretsmanager_secret.aws_bearer_token_bedrock.arn,
      aws_secretsmanager_secret.supabase_service_role_key.arn,
    ]
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  name   = "${var.project_name}-read-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets.json
}

# --- Task role: what the running app itself would assume. Deliberately
# empty — ALLOW_AWS_APPLY is hardcoded false in this deployment (below), the
# compose deploy track auto-simulates with no docker daemon present, and
# Bedrock auth here uses a bearer token (AWS_BEARER_TOKEN_BEDROCK), not
# SigV4 — so the running container has no need for any AWS IAM permissions
# of its own. Kept as a distinct empty role (not omitted) so a future,
# narrowly-scoped permission can be added here without touching the
# execution role's blast radius. ---
resource "aws_iam_role" "task" {
  name               = "${var.project_name}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_ecs_task_definition" "app" {
  family                   = var.project_name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.fargate_cpu
  memory                   = var.fargate_memory
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name      = "app"
      image     = "${aws_ecr_repository.app.repository_url}:${var.image_tag}"
      essential = true
      portMappings = [
        { containerPort = 4100, protocol = "tcp" }
      ]
      environment = [
        { name = "PORT", value = "4100" },
        { name = "SUPABASE_URL", value = var.supabase_url },
        { name = "LLM_PROVIDER", value = "auto" },
        { name = "AWS_REGION", value = var.aws_region },
        { name = "BEDROCK_MODEL_ID", value = var.bedrock_model_id },
        { name = "DEPLOY_TARGET", value = "compose" },
        { name = "MOCK_DEPLOY", value = "auto" },
        { name = "SKIP_LOAD_TEST", value = "true" },
        # Hardcoded false: this hosted instance must never be able to
        # terraform apply/destroy against the AWS account it runs in.
        { name = "ALLOW_AWS_APPLY", value = "false" },
        { name = "APPROVAL_TIMEOUT_MINUTES", value = "30" },
      ]
      secrets = [
        { name = "ANTHROPIC_API_KEY", valueFrom = aws_secretsmanager_secret.anthropic_api_key.arn },
        { name = "AWS_BEARER_TOKEN_BEDROCK", valueFrom = aws_secretsmanager_secret.aws_bearer_token_bedrock.arn },
        { name = "SUPABASE_SERVICE_ROLE_KEY", valueFrom = aws_secretsmanager_secret.supabase_service_role_key.arn },
      ]
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

  tags = { Project = var.project_name }
}

resource "aws_ecs_service" "app" {
  name            = "${var.project_name}-svc"
  cluster         = aws_ecs_cluster.app.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = data.aws_subnets.default_public.ids
    security_groups  = [aws_security_group.app.id]
    assign_public_ip = true
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 4100
  }

  depends_on = [aws_lb_listener.http]

  tags = { Project = var.project_name }
}
