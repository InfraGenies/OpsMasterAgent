<#
.SYNOPSIS
  Cost-safety timer for the raw-AWS-CLI Fargate demo paths documented in this folder
  (01-fargate-demo-vite-react-docker.md, 02-fargate-demo-nginx-hello.md,
  03-fargate-demo-aws-copilot-sample-service.md — UC-15/UC-16/UC-14): schedules
  "aws ecs stop-task" (+ optional ECR image cleanup) to run automatically after a delay, so a
  standalone Fargate task started for a demo doesn't keep billing if someone forgets to tear it
  down.

.DESCRIPTION
  Same pattern as templates/terraformCatalog.ts's generated schedule-auto-destroy.ps1 for UC-9's
  Terraform path, applied here to the manual `aws ecs run-task` workflow all three of this
  folder's demo apps use instead (none of them go through Terraform — see each md's "Option B" /
  "Manual AWS CLI" section). One script covers all three since their teardown shape is identical
  (`aws ecs stop-task` + `aws ecr batch-delete-image`), just with different cluster/task/repo
  values already captured in shell variables by the time you reach each md's own Teardown step.

  Run this AFTER `aws ecs run-task` has started the demo task. Registers a ONE-SHOT Windows Task
  Scheduler job (not a foreground sleep loop) so it still fires even if this terminal window is
  closed — but not if this machine is asleep/off/logged-out at the scheduled time; destroy
  manually instead if you might close your laptop before the timer fires.

  If invoking this from a plain terminal (not an already-open PowerShell session) hits
  "running scripts is disabled on this system" (confirmed live on a default-Restricted-policy
  Windows machine), call it via `powershell -ExecutionPolicy Bypass -File .\schedule-ecs-auto-teardown.ps1 ...`
  instead of `.\schedule-ecs-auto-teardown.ps1 ...` directly — that scopes the bypass to just this
  one invocation, no system policy change.

.PARAMETER ClusterName
  ECS cluster the task is running in (matches $CLUSTER / "ops-master-demo" in the md files).

.PARAMETER TaskArn
  Full task ARN or ID to stop (the $TASK_ARN captured after `aws ecs run-task`).

.PARAMETER Region
  AWS region (matches $AWS_REGION in the md files).

.PARAMETER RepositoryName
  ECR repo to clean up alongside the task (matches $APP_NAME in the md files). Required unless
  -SkipEcrCleanup is passed.

.PARAMETER ImageTag
  Tag to delete from the ECR repo. Defaults to "latest" (matches every md file's push step).

.PARAMETER Minutes
  Delay before auto-teardown runs. Defaults to 15 — a bit longer than schedule-auto-destroy.ps1's
  10-minute default for UC-9's Terraform path, since this app's Fargate compute + public-IPv4
  charges round to well under a cent even over 15 minutes (see USE_CASES.md's cost note), so there's
  no real cost pressure to cut the demo window tight.

.PARAMETER SkipEcrCleanup
  Only stop the task; leave the ECR image in place (e.g. nginx-hello's "skip the clone entirely"
  path, section 2, reuses a pushed image you may want to keep for a re-run).

.EXAMPLE
  .\schedule-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN `
    -Region us-east-1 -RepositoryName ops-demo-copilot-sample

.EXAMPLE
  .\schedule-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN `
    -Region us-east-1 -Minutes 30 -SkipEcrCleanup
#>
param(
  [Parameter(Mandatory = $true)][string]$ClusterName,
  [Parameter(Mandatory = $true)][string]$TaskArn,
  [Parameter(Mandatory = $true)][string]$Region,
  [string]$RepositoryName,
  [string]$ImageTag = "latest",
  [int]$Minutes = 15,
  [switch]$SkipEcrCleanup
)

if (-not $SkipEcrCleanup -and -not $RepositoryName) {
  throw "Pass -RepositoryName <ecr repo> (or -SkipEcrCleanup to only stop the task, leaving the image in place)."
}

# Task-name-safe fragment of the task ARN (ARNs contain "/" and ":", neither valid in a scheduled
# task name) — the ARN's own trailing task ID is unique enough per cluster to avoid collisions
# between concurrently-running demo tasks.
$taskIdFragment = $TaskArn.Split("/")[-1]
$taskName = "OpsMasterAgent-AutoStop-$ClusterName-$taskIdFragment"
$runAt = (Get-Date).AddMinutes($Minutes)

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "A task named '$taskName' already exists (from an earlier run) - replacing it."
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

$commands = @("aws ecs stop-task --cluster $ClusterName --task $TaskArn --region $Region")
if (-not $SkipEcrCleanup) {
  $commands += "aws ecr batch-delete-image --repository-name $RepositoryName --region $Region --image-ids imageTag=$ImageTag"
}
# "&" (not "&&") between the two aws calls: stop-task succeeding is not a precondition for
# wanting the ECR cleanup to still run, and this runs unattended with no one watching to retry.
$fullCommand = $commands -join " & "

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $fullCommand"
$trigger = New-ScheduledTaskTrigger -Once -At $runAt
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Description "OpsMasterAgent cost-safety auto-stop for ECS task $TaskArn in cluster $ClusterName" | Out-Null

Write-Host "Scheduled: ECS task in cluster '$ClusterName' will be stopped at $runAt (in $Minutes minutes)."
if (-not $SkipEcrCleanup) {
  Write-Host "ECR image '$RepositoryName`:$ImageTag' in region '$Region' will also be deleted at that time."
}
Write-Host "Changed your mind? Cancel with:"
Write-Host "  .\cancel-ecs-auto-teardown.ps1 -ClusterName $ClusterName -TaskArn $TaskArn"
Write-Host "  (or, if script execution is disabled: powershell -ExecutionPolicy Bypass -File .\cancel-ecs-auto-teardown.ps1 -ClusterName $ClusterName -TaskArn $TaskArn)"
Write-Host "(destroys nothing itself - just unregisters the scheduled task)"
