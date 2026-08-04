# Secret *names* only — Terraform creates empty secrets; values are set once,
# manually, after `terraform apply` (see README.md in this directory), and
# never appear in .tf/.tfvars or git. lifecycle.ignore_changes on the version
# stops a later `terraform apply` from wiping out the value you set by hand.

resource "aws_secretsmanager_secret" "anthropic_api_key" {
  name = "${var.project_name}/ANTHROPIC_API_KEY"
}

resource "aws_secretsmanager_secret" "aws_bearer_token_bedrock" {
  name = "${var.project_name}/AWS_BEARER_TOKEN_BEDROCK"
}

resource "aws_secretsmanager_secret" "supabase_service_role_key" {
  name = "${var.project_name}/SUPABASE_SERVICE_ROLE_KEY"
}
