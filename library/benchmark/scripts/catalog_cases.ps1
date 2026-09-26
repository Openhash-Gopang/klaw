# catalog_cases.ps1  (ASCII only)
# Tag EVERY collected case (dev, remaining pool, excluded non-judgments) and store them in a browsable layout.
# Non-destructive: bodies are copied into cases\..., the source folders stay as they are. Safe to re-run.
param([string]$Root = "$env:USERPROFILE\klaw-bench")
$ErrorActionPreference = "Stop"
Set-Location $Root

# Korean literals as unicode escapes
$fContent = [regex]::Unescape('\uD310\uB840\uB0B4\uC6A9')
$lGigak = [regex]::Unescape('\uC0C1\uACE0\uAE30\uAC01')
$lGakha = [regex]::Unescape('\uC0C1\uACE0\uAC01\uD558')
$lFull = [regex]::Unescape('\uC804\uBD80\uD30C\uAE30\uD658\uC1A1')
$lPart = [regex]::Unescape('\uC77C\uBD80\uD30C\uAE30\uD658\uC1A1')
$lTransfer = [regex]::Unescape('\uD30C\uAE30\uC774\uC1A1')
$lSelf = [regex]::Unescape('\uD30C\uAE30\uC790\uD310')
$bKeep = [regex]::Unescape('\uC720\uC9C0')
$bRev = [regex]::Unescape('\uD30C\uAE30')
$kHigh1 = [regex]::Unescape('\uACE0\uB4F1')
$kHigh2 = [regex]::Unescape('\uACE0\uBC95')
$kPanel = [regex]::Unescape('\uAC00\uD569')
$kSingle = [regex]::Unescape('\uAC00\uB2E8')
$kSmall = [regex]::Unescape('\uAC00\uC18C')

function Get-Chars([string]$path) {
    if ($path -and (Test-Path $path)) { return ([string](Get-Content $path -Raw -Encoding UTF8 | ConvertFrom-Json).PrecService.$fContent).Length }
    return 0
}
function Get-Recency([string]$d) {
    if ($d -ge '20260301') { return 'R1' }
    if ($d -ge '20260101') { return 'R2' }
    if ($d -ge '20251201') { return 'R3' }
    return 'R4'
}
$labelTag = @{}
$labelTag[$lGigak] = 'label:dismissed'; $labelTag[$lGakha] = 'label:rejected'; $labelTag[$lFull] = 'label:full_remand'
$labelTag[$lPart] = 'label:partial_remand'; $labelTag[$lTransfer] = 'label:transfer'; $labelTag[$lSelf] = 'label:self_judgment'

$labels = @(Import-Csv .\labels.csv -Encoding UTF8)
$chainById = @{}; foreach ($cr in @(Import-Csv .\chain.csv -Encoding UTF8)) { $chainById[[string]$cr.id] = $cr }
$devRound = @{}; foreach ($dr in @(Import-Csv .\split\dev.csv -Encoding UTF8)) { $devRound[[string]$dr.id] = [int]$dr.round }

$rows = New-Object System.Collections.Generic.List[object]
$tagCount = @{}
function Add-Row($row, $tags) {
    $row | Add-Member -NotePropertyName tags -NotePropertyValue ($tags -join ';') -Force
    $rows.Add($row)
    foreach ($t in $tags) { $tagCount[$t] = 1 + [int]$tagCount[$t] }
}
function Save-Bundle([string]$dir, [hashtable]$files, $meta) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    foreach ($k in $files.Keys) { if ($files[$k] -and (Test-Path $files[$k])) { Copy-Item $files[$k] (Join-Path $dir $k) -Force } }
    $meta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $dir 'meta.json') -Encoding UTF8
}

# --- A) the 300 collected judgments ---
foreach ($l in $labels) {
    $id = [string]$l.id
    $ch = $chainById[$id]
    $isDev = $devRound.ContainsKey($id)
    $has2 = [bool]($ch -and $ch.found2 -eq 'True'); $has1 = [bool]($ch -and $ch.found1 -eq 'True')
    $pSup = Join-Path $Root ("prec_civil\{0}_{1}.json" -f $l.date, $id)
    $pSec = ''; $pFst = ''; $note = ''
    if ($ch) {
        if ($has2 -and $ch.id2) { $pSec = Join-Path $Root ("prec_2nd\{0}.json" -f $ch.id2) }
        if ($has1 -and $ch.id1) { $pFst = Join-Path $Root ("prec_1st\{0}.json" -f $ch.id1) }
        $note = [string]$ch.note
    }
    $cSup = Get-Chars $pSup; $cSec = Get-Chars $pSec; $cFst = Get-Chars $pFst

    $tags = New-Object System.Collections.Generic.List[string]
    if ($isDev) { $tags.Add('split:dev'); $tags.Add(('round:r{0:D2}' -f $devRound[$id])); $tags.Add('role:dev') }
    else {
        $tags.Add('split:pool')
        if ($has2) { $tags.Add('role:supp_test_2nd') } else { $tags.Add('role:supp_test_concl_only') }
    }
    if ($l.binary -eq $bKeep) { $tags.Add('outcome:keep') } elseif ($l.binary -eq $bRev) { $tags.Add('outcome:reverse') }
    if ($labelTag.ContainsKey([string]$l.label)) { $tags.Add($labelTag[[string]$l.label]) }
    if ($has1 -and $has2) { $tags.Add('chain:full') } elseif ($has2) { $tags.Add('chain:second_only') } else { $tags.Add('chain:supreme_only') }
    $tags.Add('recency:' + (Get-Recency ([string]$l.date))); $tags.Add('month:' + ([string]$l.date).Substring(0,6))
    if ($l.hasRemandPrior -eq 'True') { $tags.Add('flag:prior_remand') }
    if ($note -match '^1st:(.+)$') { $tags.Add('gap1:' + ($Matches[1] -replace '-', '_')) }
    elseif ($note -match '^2nd:(.+)$') { $tags.Add('gap2:' + ($Matches[1] -replace '-', '_')) }
    elseif ($note -match '^no-(1st|2nd)-ref$') { $tags.Add('gap' + $Matches[1].Substring(0,1) + ':no_ref') }
    if ($ch -and $has2) {
        if ([string]$ch.court2 -match ($kHigh1 + '|' + $kHigh2)) { $tags.Add('appeal_court:high') } else { $tags.Add('appeal_court:district') }
    }
    if ($ch -and $has1) {
        $n1 = [string]$ch.no1
        if ($n1 -match $kPanel) { $tags.Add('first_type:panel') } elseif ($n1 -match $kSingle) { $tags.Add('first_type:single') } elseif ($n1 -match $kSmall) { $tags.Add('first_type:small_claims') } else { $tags.Add('first_type:other') }
    }
    $split = $(if ($isDev) { 'dev' } else { 'pool' })
    $row = [pscustomobject]@{
        id = $id; caseNo = [string]$l.caseNo; date = [string]$l.date; month = ([string]$l.date).Substring(0,6); recency = (Get-Recency ([string]$l.date))
        split = $split; round = $(if ($isDev) { $devRound[$id] } else { '' }); label = [string]$l.label; binary = [string]$l.binary
        has_2nd = $has2; has_1st = $has1; supreme_chars = $cSup; second_chars = $cSec; first_chars = $cFst; total_chars = ($cSup + $cSec + $cFst)
    }
    Add-Row $row $tags
    $meta = [ordered]@{ id = $id; caseNo = [string]$l.caseNo; date = [string]$l.date; split = $split; round = $row.round; label = [string]$l.label; binary = [string]$l.binary; tags = @($tags) }
    if ($isDev) {
        $devDir = Join-Path $Root ("dev100\r{0:D2}\{1}" -f $devRound[$id], $id)
        if (Test-Path $devDir) { $meta | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $devDir 'meta.json') -Encoding UTF8 }
    } else {
        $side = $(if ($l.binary -eq $bKeep) { 'keep' } else { 'reverse' })
        Save-Bundle (Join-Path $Root ("cases\pool\{0}\{1}" -f $side, $id)) @{ 'supreme.json' = $pSup; 'second.json' = $pSec; 'first.json' = $pFst } $meta
    }
}

# --- B) excluded non-judgments (decisions etc.) ---
$exclCsv = Join-Path $Root 'prec_civil\index_excluded.csv'
if (Test-Path $exclCsv) {
    foreach ($e in @(Import-Csv $exclCsv -Encoding UTF8)) {
        $id = [string]$e.id
        $pEx = Join-Path $Root ("prec_civil\_excluded\{0}_{1}.json" -f $e.date, $id)
        $code = ''; $m = [regex]::Match([string]$e.caseNo, '\d{4}([\uAC00-\uD7A3]+)\d'); if ($m.Success) { $code = $m.Groups[1].Value }
        $tags = @('split:excluded', 'role:excluded', 'excluded:non_judgment', 'outcome:n_a', ('recency:' + (Get-Recency ([string]$e.date))), ('month:' + ([string]$e.date).Substring(0,6)))
        $row = [pscustomobject]@{ id = $id; caseNo = [string]$e.caseNo; date = [string]$e.date; month = ([string]$e.date).Substring(0,6); recency = (Get-Recency ([string]$e.date))
            split = 'excluded'; round = ''; label = ''; binary = ''; has_2nd = ''; has_1st = ''; supreme_chars = (Get-Chars $pEx); second_chars = ''; first_chars = ''; total_chars = '' }
        Add-Row $row $tags
        Save-Bundle (Join-Path $Root ("cases\excluded\{0}" -f $id)) @{ 'supreme.json' = $pEx } ([ordered]@{ id = $id; caseNo = [string]$e.caseNo; case_code = $code; date = [string]$e.date; split = 'excluded'; tags = @($tags) })
    }
}

# --- C) catalog + tag reference ---
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'catalog') | Out-Null
$rows | Export-Csv (Join-Path $Root 'catalog\catalog.csv') -NoTypeInformation -Encoding UTF8
$tagCount.GetEnumerator() | Sort-Object Name | ForEach-Object { [pscustomobject]@{ tag = $_.Name; count = $_.Value } } | Export-Csv (Join-Path $Root 'catalog\tag_counts.csv') -NoTypeInformation -Encoding UTF8
Set-Content -Path (Join-Path $Root 'catalog\tags_reference.txt') -Encoding UTF8 -Value @(
'split:dev|pool|excluded      dev = 100 tuning cases (10 rounds); pool = remaining 200 judgments; excluded = non-judgment decisions',
'round:r01..r10               dev round',
'role:dev | supp_test_2nd | supp_test_concl_only | excluded   supp_test_2nd = pool case with 2nd-instance text (can be used for lower-court comparison)',
'outcome:keep|reverse|n_a     Supreme Court result: appeal dismissed / any reversal / not applicable',
'label:dismissed|rejected|full_remand|partial_remand|transfer|self_judgment',
'chain:full|second_only|supreme_only   which judgments are available (1st+2nd / 2nd / Supreme only)',
'recency:R1..R4               decided 2026-03+ / 2026-01..02 / 2025-12 / up to 2025-11 (contamination-risk tiers; DeepSeek cutoff is undisclosed)',
'month:YYYYMM                 decision month',
'flag:prior_remand            re-appeal after an earlier remand',
'gap1:*, gap2:*              why the 1st / 2nd instance judgment is missing (not_in_db, court_mismatch, no_ref)',
'appeal_court:high|district  court level of the 2nd-instance judgment',
'first_type:panel|single|small_claims|other   1st-instance case type (panel / single judge / small claims)')

# --- D) report ---
$judg = @($rows | Where-Object { $_.split -ne 'excluded' })
Write-Host ("Cataloged {0} rows ({1} judgments + {2} excluded) -> catalog\catalog.csv" -f $rows.Count, $judg.Count, @($rows | Where-Object { $_.split -eq 'excluded' }).Count)
Write-Host "By split / outcome:"
$judg | Group-Object split, binary | Sort-Object Name | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Name, $_.Count) }
Write-Host "Pool by recency tier (R1 newest .. R4 oldest) / outcome:"
$judg | Where-Object { $_.split -eq 'pool' } | Group-Object recency, binary | Sort-Object Name | ForEach-Object { Write-Host ("  {0}: {1}" -f $_.Name, $_.Count) }
Write-Host "Pool with 2nd-instance text (usable for lower-court comparison), by outcome:"
$judg | Where-Object { $_.split -eq 'pool' -and $_.has_2nd } | Group-Object binary | ForEach-Object { Write-Host ("  {0}: {1} (with 1st also: {2})" -f $_.Name, $_.Count, @($_.Group | Where-Object { $_.has_1st }).Count) }
Write-Host "Tag counts: catalog\tag_counts.csv | tag vocabulary: catalog\tags_reference.txt | bundles: cases\pool\keep, cases\pool\reverse, cases\excluded"
