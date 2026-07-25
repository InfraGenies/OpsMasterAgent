# Managed controls (Enterprise Architecture Advisor): AWS Backup
# Rendered deterministically from architecture_recommendation.managed_controls — never LLM-written.

# AWS Backup — automated, policy-driven backup plan
resource "aws_backup_vault" "this" {
  name = "${var.environment_name}-backup-vault"
}

resource "aws_iam_role" "backup" {
  name = "${var.environment_name}-backup-role"
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
  name = "${var.environment_name}-backup-plan"

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
  name         = "${var.environment_name}-backup-selection"
  plan_id      = aws_backup_plan.this.id
  iam_role_arn = aws_iam_role.backup.arn
  resources    = [aws_db_instance.db.arn]
}
