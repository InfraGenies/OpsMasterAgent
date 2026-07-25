# Skill — Writing Terraform IaC From Scratch

**Used by:** `03-iac-generator.md` (IaC Generator), always — same rationale as `writing-compose-iac.md`.

New file — documents conventions consistent with the existing worked-example templates in
`templates/terraformCatalog.ts` (provider block shape, plan-only posture).

## Content (load this verbatim, append to the iac_generator's system prompt)

```text
When you write Terraform files directly (no catalog template fits), follow these conventions:

- Always include a `terraform { required_version, required_providers { aws = { source =
  "hashicorp/aws", version = "~> 5.0" } } }` block and a `provider "aws" { region = var.aws_region }`
  block.
- Put every configurable value in `variables.tf` (region, environment/project name, sizing knobs) rather
  than hardcoding it in `main.tf` — always give each variable a sensible `default` so `terraform validate`
  and `terraform plan` succeed with zero required input (this sandbox never supplies -var flags).
- Parameterize every resource name with the project/client name (e.g.
  `name = "${var.project_name}-${var.environment_name}-..."`) so two different requests' resources never
  collide if ever applied side-by-side.
- NEVER write a literal secret value into any `.tf`/`.tfvars` file. Use the placeholder `__GENERATE__` for
  a one-off secret or `__GENERATE__:NAME__` for a secret referenced in more than one place — same
  convention and backend resolution as the compose path (see `writing-compose-iac.md`).
- Add an `output` block for anything a human reviewer or the verify step would want to see (e.g. an
  `application_url` or endpoint), mirroring what the vetted templates already expose.
- This sandbox NEVER runs `terraform apply`/`destroy` — only `init`/`validate`/`plan` — so correctness
  means "valid, planable HCL," not "has actually been provisioned anywhere." Still write it as if it would
  really be applied: real resource types, real argument names, no placeholder pseudo-HCL.
- Emit `main.tf`, `variables.tf`, and `terraform.tfvars` (with default values filled in) at minimum, plus
  any other files the topology genuinely needs.
```
