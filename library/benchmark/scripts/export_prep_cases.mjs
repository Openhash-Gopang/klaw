// export_prep_cases.mjs — 시험 전 준비 단계: dev.csv 100건의 원문(대법원·2심·1심)과 사건 개요를
// 저장소 library/benchmark/rounds/rNN/<id>/ 로 내보낸다. 결과(klaw_verdict 등)는 만들지 않는다.
// 기존에 있는 파일은 덮어쓰지 않는다(2라운드 익명화 개요 등 보호). 라운드별 cases.csv(사건 목록)는 매번 새로 쓴다.
// 실행 위치: klaw-bench 폴더(split\dev.csv, dev100\ 가 있는 곳).
// 사용: node export_prep_cases.mjs --repo="C:\Users\주피터\Downloads\klaw" [--round=5] [--dev=split/dev.csv] [--dry]
import fs from 'node:fs'; import path from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const REPO = args.repo; if (!REPO) { console.error('--repo=<저장소 경로> 필요'); process.exit(1); }
const ONLY = args.round ? Number(args.round) : null; const DRY = !!args.dry;
const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };
function parseCsv(text) {
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c; }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const c2 = rows.filter((r) => !(r.length === 1 && r[0] === '')); const [h, ...b] = c2;
  return b.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const dev = parseCsv(readText(args.dev || 'split/dev.csv')).filter((r) => (ONLY ? Number(r.round) === ONLY : true));
const byRound = new Map(); for (const r of dev) { const k = Number(r.round); if (!byRound.has(k)) byRound.set(k, []); byRound.get(k).push(r); }
let nNew = 0, nSkip = 0, nMissing = 0; const missing = [];
for (const [rn, rows] of [...byRound].sort((a, b) => a[0] - b[0])) {
  const rd = `r${String(rn).padStart(2, '0')}`;
  const outRound = path.join(REPO, 'library', 'benchmark', 'rounds', rd);
  for (const row of rows) {
    const src = path.join('dev100', rd, row.id); const dst = path.join(outRound, row.id);
    if (!fs.existsSync(src)) { missing.push(`${rd}/${row.id}: dev100 폴더 없음`); continue; }
    if (!DRY) fs.mkdirSync(dst, { recursive: true });
    const put = (name, content) => { const p = path.join(dst, name); if (fs.existsSync(p)) { nSkip++; return; } if (!DRY) fs.writeFileSync(p, content, 'utf8'); nNew++; };
    for (const [j, outName] of [['supreme.json', 'actual_supreme.txt'], ['second.json', 'actual_second.txt'], ['first.json', 'actual_first.txt']]) {
      const jp = path.join(src, j); if (!fs.existsSync(jp)) continue;
      const t = String(JSON.parse(readText(jp))?.PrecService?.['판례내용'] ?? '');
      if (t) put(outName, t.replace(/<br\s*\/?>/gi, '\n')); else missing.push(`${rd}/${row.id}: ${j} 본문 비어 있음`);
    }
    for (const m of ['independent']) { const op = path.join(src, `overview_${m}.txt`); if (fs.existsSync(op)) put(`overview_${m}.txt`, readText(op)); else missing.push(`${rd}/${row.id}: overview_${m}.txt 없음`); }
  }
  // 사건 목록(결과와 무관) + round-meta(없을 때만)
  const csv = '\uFEFF' + ['id,caseNo,date,actual_label,actual_binary', ...rows.map((r) => [r.id, r.caseNo, r.date, r.label, r.binary].map(q).join(','))].join('\r\n') + '\r\n';
  if (!DRY) { fs.mkdirSync(outRound, { recursive: true }); fs.writeFileSync(path.join(outRound, 'cases.csv'), csv, 'utf8');
    const mp = path.join(outRound, 'round-meta.json');
    if (!fs.existsSync(mp)) fs.writeFileSync(mp, JSON.stringify({ status: `시험 준비 완료 — ${rows.length}건 원문·개요 게재(시험 전)`, method_version: null }, null, 2), 'utf8'); }
  console.log(`${rd}: ${rows.length}건`);
}
console.log(`새 파일 ${nNew}개, 기존 유지 ${nSkip}개${DRY ? ' (dry)' : ''}`);
if (missing.length) { console.log('확인 필요:'); missing.forEach((m) => console.log('  ' + m)); }
