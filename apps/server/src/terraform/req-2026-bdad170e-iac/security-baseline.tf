# Managed controls (Enterprise Architecture Advisor): Amazon GuardDuty, AWS WAF, AWS KMS, AWS CloudTrail, AWS Config
# Rendered deterministically from architecture_recommendation.managed_controls — never LLM-written.

# Amazon GuardDuty — continuous threat detection
resource "aws_guardduty_detector" "this" {
  enable = true
}

# AWS WAF — web application firewall in front of the internet-facing ALB
resource "aws_wafv2_web_acl" "this" {
  name  = "${var.environment_name}-waf"
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
      metric_name                = "${var.environment_name}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.environment_name}-waf"
    sampled_requests_enabled   = true
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.app.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}

# AWS KMS — customer-managed encryption keys instead of AWS-managed defaults
resource "aws_kms_key" "this" {
  description             = "${var.environment_name} customer-managed key"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_alias" "this" {
  name          = "alias/${var.environment_name}"
  target_key_id = aws_kms_key.this.key_id
}

# AWS CloudTrail — organization-wide audit trail with log-file validation
resource "aws_s3_bucket" "cloudtrail" {
  bucket        = "${var.environment_name}-cloudtrail-logs"
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
        Resource  = "${aws_s3_bucket.cloudtrail.arn}/*"
        Condition = { StringEquals = { "s3:x-amz-acl" = "bucket-owner-full-control" } }
      }
    ]
  })
}

resource "aws_cloudtrail" "this" {
  name                          = "${var.environment_name}-trail"
  s3_bucket_name                = aws_s3_bucket.cloudtrail.id
  include_global_service_events = true
  is_multi_region_trail         = true
  enable_log_file_validation    = true
  depends_on                    = [aws_s3_bucket_policy.cloudtrail]
}

# AWS Config — baseline configuration-compliance monitoring
resource "aws_s3_bucket" "config" {
  bucket        = "${var.environment_name}-config-logs"
  force_destroy = true
}

resource "aws_iam_role" "config" {
  name = "${var.environment_name}-config-role"
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
  name           = "${var.environment_name}-config-channel"
  s3_bucket_name = aws_s3_bucket.config.id
  depends_on     = [aws_config_configuration_recorder.this]
}

resource "aws_config_configuration_recorder" "this" {
  name     = "${var.environment_name}-config-recorder"
  role_arn = aws_iam_role.config.arn
}
