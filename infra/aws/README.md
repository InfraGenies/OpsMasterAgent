# AWS infra for hosting Ops Master Agent itself

Terraform for **self-hosting this app** (ECS Fargate + ALB + ECR + Secrets Manager + a GitHub OIDC
deploy role) — not to be confused with `apps/server/src/templates/terraformCatalog.ts`, which is IaC
*this product generates for end users* who ask it to deploy something else to AWS. Those two are
deliberately kept separate.

Architecture, cost estimate, and the credentials/config plan are documented in the root
[`README.md`](../../README.md#deploying-to-aws) — this file is just the step-by-step bootstrap runbook.

## One-time bootstrap

1. **Prerequisites**: [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.5, an AWS
   account/profile with permission to create the resources below (`aws configure --profile ops-master-demo`
   or similar — this repo's own `.env.example` already documents the named-profile convention for UC-9).

2. **Configure variables**:
   ```bash
   cd infra/aws
   cp terraform.tfvars.example terraform.tfvars   # gitignored — fill in supabase_url etc.
   ```

3. **Review before creating anything real** (this is the point where real AWS billing starts):
   ```bash
   terraform init
   terraform plan
   ```
   Read the plan. It creates: an ECR repo, an ALB + target group + 2 security groups, an ECS cluster +
   task definition + service (1 Fargate task by default), 2 IAM roles + inline policies, 3 empty Secrets
   Manager entries, and a GitHub OIDC provider + deploy role. Nothing outside this list.

4. **Apply**:
   ```bash
   terraform apply
   ```
   The task definition references an image tag that doesn't exist in ECR yet — the ECS service will sit
   with 0 running tasks (failing to pull) until step 6 pushes a real image. That's expected.

5. **Populate the 3 secrets** (values only ever go here, never into `.tf`/`.tfvars`/git):
   ```bash
   aws secretsmanager put-secret-value --secret-id ops-master-agent/ANTHROPIC_API_KEY \
     --secret-string "sk-ant-..."
   aws secretsmanager put-secret-value --secret-id ops-master-agent/AWS_BEARER_TOKEN_BEDROCK \
     --secret-string "bedrock-api-key-..."
   aws secretsmanager put-secret-value --secret-id ops-master-agent/SUPABASE_SERVICE_ROLE_KEY \
     --secret-string "sb_secret_..."
   ```
   (Only one of the first two is required — whichever LLM provider you're using; `LLM_PROVIDER=auto`
   picks the first configured one, same as local dev.)

6. **Wire up GitHub Actions**: take the `github_deploy_role_arn` output and set it as a repo **variable**
   (not secret — an IAM role ARN isn't sensitive on its own) named `AWS_DEPLOY_ROLE_ARN` under
   Settings -> Secrets and variables -> Actions -> Variables. Also set `AWS_REGION` and
   `ECR_REPOSITORY`/`ECS_CLUSTER`/`ECS_SERVICE` the same way (values from `terraform output`). From here,
   pushing to `main` runs `.github/workflows/deploy.yml` and rolls out automatically.

7. **First deploy**: either push to `main`, or manually trigger the `deploy` workflow from the GitHub
   Actions tab (`workflow_dispatch`). Once it finishes, `terraform output app_url` is the live URL.

## Cost control between demos

- **Cheapest pause** (keeps everything else intact): `terraform apply -var desired_count=0` — stops the
  Fargate task (~$18/mo saved), leaves the ALB running (~$20/mo). Set back to `1` (or re-run without the
  override) to resume.
- **Full teardown**: `terraform destroy` — removes everything in this stack, $0 afterward. Re-running
  `terraform apply` + a fresh `deploy.yml` run rebuilds it from scratch in a few minutes.
