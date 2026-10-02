# klaw_intake_task.ps1  (ASCII only) -- wrapper run by Windows Task Scheduler. Polls new Supreme Court civil judgments;
# when 10 new cases have queued, builds the next round (overview -> repo-ready files -> DeepSeek half).
# Required USER environment variables: LAW_OC, DEEPSEEK_OVERVIEW_API_KEY, DEEPSEEK_API_KEY  (set once with setx)
param(
    [string]$Bench = "$env:USERPROFILE\klaw-bench",
    [string]$Repo  = "$env:USERPROFILE\Downloads\klaw",
    [switch]$NoRunDeepseek      # build rounds only; do not spend DeepSeek credits on the 5-case verdict run
)
$ErrorActionPreference = "Stop"
Set-Location $Bench
New-Item -ItemType Directory -Force -Path "$Bench\live" | Out-Null
$log = "$Bench\live\task_log.txt"
"=== $(Get-Date -Format s) start ===" | Out-File $log -Append -Encoding utf8
$a = @("$Repo\library\benchmark\scripts\klaw_intake.mjs", "poll", "--auto", "--repo=$Repo")
if (-not $NoRunDeepseek) { $a += "--run-deepseek" }
& node @a 2>&1 | Out-File $log -Append -Encoding utf8
"=== $(Get-Date -Format s) exit $LASTEXITCODE ===" | Out-File $log -Append -Encoding utf8
$ready = Get-ChildItem "$Bench\live" -Filter "ROUND_READY_*.txt" -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-30) }
if ($ready) { msg $env:USERNAME "K-Law: new round is ready ($($ready.Name -join ', ')). Open klaw-bench\live." 2>$null }
