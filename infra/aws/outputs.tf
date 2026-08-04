output "app_url" {
  description = "Public URL of the deployed app (HTTP, no custom domain)."
  value       = "http://${aws_lb.app.dns_name}"
}

output "ecr_repository_url" {
  description = "Push images here (GitHub Actions does this automatically on deploy)."
  value       = aws_ecr_repository.app.repository_url
}

output "github_deploy_role_arn" {
  description = "Set this as the AWS_DEPLOY_ROLE_ARN repo variable in GitHub (Settings -> Secrets and variables -> Actions -> Variables)."
  value       = aws_iam_role.github_deploy.arn
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.app.name
}

output "ecs_service_name" {
  value = aws_ecs_service.app.name
}
