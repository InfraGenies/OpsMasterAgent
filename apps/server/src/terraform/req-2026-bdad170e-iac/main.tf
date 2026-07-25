terraform {
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

# team_ecs_fargate_ha base compute layer (Enterprise Architecture Advisor, Phase 2) — an
# illustrative workload sized per the recommended archetype (see ARCHETYPE_REASONING in
# enterpriseRulesEngine.ts), not a specific application: no concrete service topology was
# described in the business-context request this plan came from. Wraps the well-known
# terraform-aws-modules registry modules for VPC/ECS rather than hand-rolling every primitive —
# see this file's module comment.
module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "${var.environment_name}-vpc"
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

  cluster_name = "${var.environment_name}-cluster"

  fargate_capacity_providers = {
    FARGATE = {}
  }
}

resource "aws_cloudwatch_log_group" "app" {
  name              = "/ecs/${var.environment_name}-app"
  retention_in_days = 14
}

resource "aws_iam_role" "ecs_execution" {
  name = "${var.environment_name}-ecs-execution"
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
  family                   = "${var.environment_name}-app"
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
  name   = "${var.environment_name}-alb-sg"
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
  name   = "${var.environment_name}-app-sg"
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
  name               = "${var.environment_name}-alb"
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = module.vpc.public_subnets
}

resource "aws_lb_target_group" "app" {
  name        = "${var.environment_name}-tg"
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
  name            = "${var.environment_name}-app"
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
  name       = "${var.environment_name}-db-subnets"
  subnet_ids = module.vpc.private_subnets
}

resource "aws_security_group" "db" {
  name   = "${var.environment_name}-db-sg"
  vpc_id = module.vpc.vpc_id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }
}

resource "aws_db_instance" "db" {
  identifier                  = "${var.environment_name}-db"
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
