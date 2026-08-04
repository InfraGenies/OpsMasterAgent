# Uses the account's default VPC + its public subnets — no new VPC, no NAT
# Gateway. Nothing here needs a stable private egress path (outbound calls
# to Anthropic/Bedrock/Supabase/ECR all go over the public internet anyway),
# so a NAT Gateway (~$32/mo) would be pure overhead for a single-task demo
# deployment. The Fargate task gets a public IP directly instead.

data "aws_vpc" "default" {
  default = true
}

data "aws_subnets" "default_public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}
