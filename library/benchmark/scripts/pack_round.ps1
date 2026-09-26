# pack_round.ps1  (ASCII only)
# After a round has run: bundle the MISMATCHED cases (actual judgment text + K-Law verdict + overview) into one zip for analysis.
param(
    [int]$Round = 1,
    [string]$Root = "$env:USERPROFILE\klaw-bench"
)
$ErrorActionPreference = "Stop"
Set-Location $Root
$fContent = [regex]::Unescape('\uD310\uB840\uB0B4\uC6A9')
$rd = 'r{0:D2}' -f $Round
$runDir = Join-Path $Root "runs\$rd"
$resCsv = Join-Path $runDir 'results.csv'
if (-not (Test-Path $resCsv)) { throw "No results yet: $resCsv (run klaw_runner.mjs --round=$Round --tag=$rd first)" }
$res = @(Import-Csv $resCsv -Encoding UTF8)
$bad = @($res | Where-Object { $_.correct -eq 'false' })
$stage = Join-Path $Root "pack_$rd"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null
Copy-Item $resCsv (Join-Path $stage 'results_all.csv') -Force

foreach ($r in $bad) {
    $id = [string]$r.id
    $cdir = Join-Path $stage $id
    New-Item -ItemType Directory -Force -Path $cdir | Out-Null
    $devDir = Join-Path $Root ("dev100\{0}\{1}" -f $rd, $id)
    $sup = Join-Path $devDir 'supreme.json'
    if (Test-Path $sup) {
        $t = [string](Get-Content $sup -Raw -Encoding UTF8 | ConvertFrom-Json).PrecService.$fContent
        ($t -replace '<br\s*/?>', "`n") | Set-Content -Path (Join-Path $cdir 'actual_supreme_judgment.txt') -Encoding UTF8
    }
    $vt = Join-Path $runDir "$id.txt"
    if (Test-Path $vt) { Copy-Item $vt (Join-Path $cdir 'klaw_verdict.txt') -Force }
    foreach ($m in 'review','independent') {
        $ov = Join-Path $devDir "overview_$m.txt"
        if (Test-Path $ov) { Copy-Item $ov (Join-Path $cdir "overview_$m.txt") -Force }
    }
    @("id: $id", "actual   : $($r.actual_label) ($($r.actual_binary))", "predicted: $($r.pred_label) ($($r.pred_binary))", "conclusion type: $($r.conclusion_type)",
      "truncated steps: $($r.truncated_steps)", "predicted order: $($r.order)") | Set-Content -Path (Join-Path $cdir 'summary.txt') -Encoding UTF8
}
$zip = Join-Path $Root "pack_$rd.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Write-Host ("Round {0}: {1} cases, {2} mismatched -> {3} ({4:N0} KB)" -f $Round, $res.Count, $bad.Count, $zip, ((Get-Item $zip).Length / 1KB))
Write-Host "Attach this zip to the chat. Mismatched ids: $(($bad | ForEach-Object { $_.id }) -join ', ')"
