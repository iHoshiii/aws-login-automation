param([Parameter(Mandatory = $true)][string]$NodePath)
$ErrorActionPreference = 'Stop'
$taskWorkspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $taskWorkspace
$dailyDirectory = Join-Path $taskWorkspace '.local/aws-daily'
New-Item -ItemType Directory -Path $dailyDirectory -Force | Out-Null
$dailyOutput = Join-Path $dailyDirectory 'latest-output.log'
$tsxPath = Join-Path $taskWorkspace 'node_modules/tsx/dist/cli.mjs'
$dailyPath = Join-Path $PSScriptRoot 'aws-daily.ts'
$ErrorActionPreference = 'Continue'
& $NodePath $tsxPath $dailyPath --scheduled *> $dailyOutput
$dailyExitCode = $LASTEXITCODE
$ErrorActionPreference = 'Stop'
if ($dailyExitCode -ne 0) {
    Add-Type -AssemblyName PresentationFramework
    [System.Windows.MessageBox]::Show(
        'The AWS daily activity needs attention. Open this project in a terminal and run: npm run aws:daily -- --status. If sign-in expired, run: npm run aws:connect -- --manual-browser. Complete any passkey prompt yourself, and check today''s activity on AWS.',
        'AWS daily activity'
    ) | Out-Null
}
exit $dailyExitCode
