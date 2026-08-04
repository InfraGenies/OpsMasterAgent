<#
.SYNOPSIS
  Cancels the auto-stop timer scheduled by schedule-ecs-auto-teardown.ps1 for a given ECS task,
  without stopping anything - use if you want to keep the demo running longer.

.PARAMETER ClusterName
  Same value passed to schedule-ecs-auto-teardown.ps1.

.PARAMETER TaskArn
  Same value passed to schedule-ecs-auto-teardown.ps1.

.EXAMPLE
  .\cancel-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN

.EXAMPLE
  # If script execution is disabled ("running scripts is disabled on this system"):
  powershell -ExecutionPolicy Bypass -File .\cancel-ecs-auto-teardown.ps1 -ClusterName ops-master-demo -TaskArn $TASK_ARN
#>
param(
  [Parameter(Mandatory = $true)][string]$ClusterName,
  [Parameter(Mandatory = $true)][string]$TaskArn
)

$taskIdFragment = $TaskArn.Split("/")[-1]
$taskName = "OpsMasterAgent-AutoStop-$ClusterName-$taskIdFragment"

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
  Write-Host "No pending auto-stop task named '$taskName' found (already ran, already cancelled, or never scheduled)."
} else {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
  Write-Host "Cancelled - the ECS task will NOT be stopped automatically. Remember to tear it down manually when you're done:"
  Write-Host "  aws ecs stop-task --cluster $ClusterName --task $TaskArn"
}
