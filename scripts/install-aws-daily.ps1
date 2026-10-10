$ErrorActionPreference = 'Stop'
$taskWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$taskName = 'AWS Builder Daily Activity'
$taskTimezone = (Get-TimeZone).Id
if ($taskTimezone -ne 'Singapore Standard Time') {
    throw 'This daily task requires the computer timezone to be Singapore Standard Time (UTC+08).'
}
$taskNodePath = (Get-Command node -CommandType Application).Source
$taskPowerShellPath = (Get-Command powershell.exe -CommandType Application).Source
$taskRunnerPath = Join-Path $PSScriptRoot 'run-aws-daily.ps1'
$taskArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -File "' + $taskRunnerPath + '" -NodePath "' + $taskNodePath + '"'
$existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existingTask -and ($existingTask.Actions.Count -ne 1 -or $existingTask.Actions[0].Execute -ne $taskPowerShellPath -or $existingTask.Actions[0].Arguments -ne $taskArguments -or $existingTask.Actions[0].WorkingDirectory -ne $taskWorkspace)) {
    throw 'A task with this name has a different action. It was left unchanged.'
}
$taskAction = New-ScheduledTaskAction -Execute $taskPowerShellPath -Argument $taskArguments -WorkingDirectory $taskWorkspace
$taskTrigger = New-ScheduledTaskTrigger -Daily -At '09:00'
$taskUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$taskPrincipal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
$taskSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $taskAction -Trigger $taskTrigger -Principal $taskPrincipal -Settings $taskSettings -Description 'Once per Singapore date: AWS Home, one new like and relevant comment, then profile badge progress. Uses the private local AWS session.' -Force | Out-Null
$taskInfo = Get-ScheduledTaskInfo -TaskName $taskName
[PSCustomObject]@{ TaskName = $taskName; State = (Get-ScheduledTask -TaskName $taskName).State; NextRun = $taskInfo.NextRunTime; TimeZone = $taskTimezone }
