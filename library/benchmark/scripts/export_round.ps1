# export_round.ps1  (ASCII only)
# Export ONE round's case-level documents into library/benchmark/rounds/rNN/ for publishing on klaw.hondi.net.
# For each case in that round: actual supreme/2nd/1st judgment (plain text), the two overview modes,
# and the K-Law virtual verdict text. Also copies the round's results.csv. Optionally exports a
# "candidate" methodology run (e.g. a v15.2 draft tested on the same cases) into a subfolder, for the
# round's decision write-up to link to. Copies only -- source folders in klaw-bench are left untouched.
param(
    [Parameter(Mandatory=$true)][int]$Round,
    [string]$Tag,                          # runs\<Tag> = this round's OFFICIAL result (default: r{Round:D2})
    [string]$CandidateTag,                 # optional: runs\<CandidateTag> = a draft-methodology test on the same cases
    [string]$CandidateLabel = 'candidate', # subfolder name under candidate-<label>\
    [string]$Root = "$env:USERPROFILE\klaw-bench",
    [string]$OutRoot = "$env:USERPROFILE\Downloads\klaw\library\benchmark\rounds"
)
$ErrorActionPreference = "Stop"
Set-Location $Root
if (-not $Tag) { $Tag = 'r{0:D2}' -f $Round }
$fContent = [regex]::Unescape('\uD310\uB840\uB0B4\uC6A9')
$rd = 'r{0:D2}' -f $Round
$devDirBase = Join-Path $Root ("dev100\$rd")
$runDir = Join-Path $Root "runs\$Tag"
$outDir = Join-Path $OutRoot $rd
if (-not (Test-Path $devDirBase)) { throw "No dev100 folder for this round: $devDirBase" }
if (-not (Test-Path $runDir)) { throw "No runs folder for tag '$Tag': $runDir (run klaw_runner.mjs --round=$Round --tag=$Tag first)" }
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function Convert-Judgment($jsonPath, $txtPath) {
    if (-not (Test-Path $jsonPath)) { return $false }
    $t = [string](Get-Content $jsonPath -Raw -Encoding UTF8 | ConvertFrom-Json).PrecService.$fContent
    if (-not $t) { return $false }
    ($t -replace '<br\s*/?>', "`n") | Set-Content -Path $txtPath -Encoding UTF8
    return $true
}

$ids = Get-ChildItem $devDirBase -Directory | Select-Object -ExpandProperty Name
$exported = 0
foreach ($id in $ids) {
    $caseDevDir = Join-Path $devDirBase $id
    $vt = Join-Path $runDir "$id.txt"
    if (-not (Test-Path $vt)) { continue }   # this case has no result under $Tag yet -- skip, don't publish partial/fake data
    $cdir = Join-Path $outDir $id
    New-Item -ItemType Directory -Force -Path $cdir | Out-Null
    Convert-Judgment (Join-Path $caseDevDir 'supreme.json') (Join-Path $cdir 'actual_supreme.txt') | Out-Null
    Convert-Judgment (Join-Path $caseDevDir 'second.json')  (Join-Path $cdir 'actual_second.txt')  | Out-Null
    Convert-Judgment (Join-Path $caseDevDir 'first.json')   (Join-Path $cdir 'actual_first.txt')   | Out-Null
    foreach ($m in 'review','independent') {
        $ov = Join-Path $caseDevDir "overview_$m.txt"
        if (Test-Path $ov) { Copy-Item $ov (Join-Path $cdir "overview_$m.txt") -Force }
    }
    Copy-Item $vt (Join-Path $cdir 'klaw_verdict.txt') -Force
    $exported++
}
$resCsv = Join-Path $runDir 'results.csv'
if (Test-Path $resCsv) { Copy-Item $resCsv (Join-Path $outDir 'results.csv') -Force }

Write-Host ("Round {0} [{1}]: exported {2}/{3} cases -> {4}" -f $Round, $Tag, $exported, $ids.Count, $outDir)

if ($CandidateTag) {
    $candRunDir = Join-Path $Root "runs\$CandidateTag"
    if (-not (Test-Path $candRunDir)) { throw "No runs folder for candidate tag '$CandidateTag': $candRunDir" }
    $candOut = Join-Path $outDir "candidate-$CandidateLabel"
    New-Item -ItemType Directory -Force -Path $candOut | Out-Null
    $candExported = 0
    foreach ($id in $ids) {
        $vt = Join-Path $candRunDir "$id.txt"
        if (-not (Test-Path $vt)) { continue }
        $cdir = Join-Path $candOut $id
        New-Item -ItemType Directory -Force -Path $cdir | Out-Null
        Copy-Item $vt (Join-Path $cdir 'klaw_verdict.txt') -Force
        $candExported++
    }
    $candCsv = Join-Path $candRunDir 'results.csv'
    if (Test-Path $candCsv) { Copy-Item $candCsv (Join-Path $candOut 'results.csv') -Force }
    Write-Host ("  candidate [{0}] '{1}': exported {2} case verdicts -> {3}" -f $CandidateTag, $CandidateLabel, $candExported, $candOut)
}
Write-Host "Next: write/update rounds\$rd\decision.md, then run 'node build_rounds_manifest.mjs' and commit library\benchmark\rounds."
