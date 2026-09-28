// rescore_declined.mjs — 게시된 rounds/rNN/results.csv + klaw_verdict.txt만으로
// "[판단불가선언]" 오탐 정규식 버그를 수정된 규칙으로 재채점한다. 로컬 전용 데이터
// (chain.csv, prec_*, split/dev.csv)나 API 키가 필요 없다 — 이미 저장된 klaw_verdict.txt
// (STEP 0~C 전문)를 결정론적 규칙으로 다시 훑을 뿐이다.
//
// 배경: klaw_runner.mjs의 원래 declined 정규식
//   /【판단\s*불가\s*선언】/
// 은 STEP A의 안전장치 점검 문구("→【판단 불가 선언】 미발동. STEP B 진입 허용.")까지
// 매치되어, 실제로는 정상 판결인 사건이 "판단불가/유보"로 오채점되는 사례가 있었다
// (3라운드 619429). 수정 규칙은 "…미발동"이 뒤따르는 매치를 제외한다.
//
// 자기검증(STEP V)이 결론을 바꾼 행(sc_changed=true)은 안전하게 건너뛴다 — 그 경우
// 최종 주문이 klaw_verdict.txt의 "주 문/이 유" 라벨이 아니라 STEP V의 "최종 주문:"
// 한 줄에서 나오므로, 이 스크립트의 단순 재추출로는 재현할 수 없다(수동 확인 필요).
//
// 사용: node library/benchmark/scripts/rescore_declined.mjs --round=3 [--ids=619429,...] [--dry]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ROUND = Number(args.round);
if (!ROUND) { console.error('사용: node rescore_declined.mjs --round=N [--ids=id1,id2] [--dry]'); process.exit(1); }
const RD = args.tag || `r${String(ROUND).padStart(2, '0')}`;
const ONLY_IDS = args.ids ? String(args.ids).split(',').map((s) => s.trim()) : null;
const DRY = !!args.dry;

const ROOT = process.cwd();
const DIR = path.join(ROOT, 'library', 'benchmark', 'rounds', RD);
const csvPath = path.join(DIR, 'results.csv');
if (!fs.existsSync(csvPath)) throw new Error(`없음: ${csvPath}`);

// ── klaw_runner.mjs와 동일한 채점 규칙 (declined 정규식만 수정) ──
function classify(o) {
  if (!/파기/.test(o)) {
    if (/상고를\s*(모두\s*)?각하/.test(o)) return ['상고각하', '유지'];
    if (/상고를\s*(모두\s*)?기각/.test(o)) return ['상고기각', '유지'];
    return ['확인필요', '확인필요'];
  }
  if (/이송한다/.test(o)) return ['파기이송', '파기'];
  if (/환송한다/.test(o)) {
    if (/^(1\.\s*)?원심판결을\s*파기하고,?\s*(이\s*)?사건을/.test(o) && !/상고를\s*(모두\s*)?기각/.test(o)) return ['전부파기환송', '파기'];
    return ['일부파기환송', '파기'];
  }
  return ['파기자판', '파기'];
}
function extractOrder(text) {
  const t = text.replace(/\*\*/g, '');
  const re = /(?:^|\n)[ \t#*【\[]*(주\s*문|이\s*유)[ \t]*(?:[】\]]+[ \t]*[:：]?|[:：]|(?=[ \t]*(?:\n|$)))/g;
  const labels = []; let m;
  while ((m = re.exec(t))) labels.push({ kind: m[1].replace(/\s+/g, ''), idx: m.index, end: m.index + m[0].length });
  for (let i = labels.length - 1; i >= 0; i--) {
    if (labels[i].kind !== '주문') continue;
    const next = labels.slice(i + 1).find((l) => l.kind === '이유');
    if (next) return t.slice(labels[i].end, next.idx).replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  const last = [...labels].reverse().find((l) => l.kind === '주문');
  return last ? t.slice(last.end, last.end + 600).replace(/\s+/g, ' ').trim() : '';
}
// [수정] "…미발동"으로 이어지는 문구는 실제 선언이 아니라 부정 확인이므로 제외한다.
function isDeclined(full) {
  return /【판단\s*불가\s*선언】(?!\s*미발동)/.test(full);
}

function readCsv(p) {
  const text = fs.readFileSync(p, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.length);
  const parseLine = (line) => {
    const out = []; let cur = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur); return out;
  };
  const header = parseLine(lines[0]);
  return { header, rows: lines.slice(1).map((l) => parseLine(l)) };
}
const qcsv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

const { header, rows } = readCsv(csvPath);
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const k of ['id', 'actual_binary', 'pred_label', 'pred_binary', 'correct', 'sc_changed', 'order']) {
  if (!(k in idx)) throw new Error(`results.csv에 예상한 컬럼이 없습니다: ${k}`);
}

let changed = 0; let checked = 0; const report = [];

for (const row of rows) {
  const id = row[idx.id];
  if (ONLY_IDS && !ONLY_IDS.includes(id)) continue;
  if (row[idx.sc_changed] === 'true') { report.push(`${id}: 자기검증(STEP V)이 결론을 바꾼 행이라 건드리지 않음(수동 확인 필요)`); continue; }
  const vtPath = path.join(DIR, id, 'klaw_verdict.txt');
  if (!fs.existsSync(vtPath)) { report.push(`${id}: klaw_verdict.txt 없음, 건너뜀`); continue; }
  const full = fs.readFileSync(vtPath, 'utf8');
  checked++;

  const wasDeclined = row[idx.pred_label] === '판단불가';
  const nowDeclined = isDeclined(full);
  const orderText = extractOrder(full);
  let predLabel, predBinary;
  if (nowDeclined) { predLabel = '판단불가'; predBinary = '유보'; }
  else { [predLabel, predBinary] = classify(orderText); }

  if (predLabel === row[idx.pred_label] && predBinary === row[idx.pred_binary]) continue; // 변화 없음

  const actualBinary = row[idx.actual_binary];
  const correct = String(predBinary === actualBinary);
  report.push(
    `${id}: ${row[idx.pred_label]}/${row[idx.pred_binary]} (correct=${row[idx.correct]}) → ` +
    `${predLabel}/${predBinary} (correct=${correct})  [오탐 "…미발동" 오매칭 수정]`
  );
  row[idx.pred_label] = predLabel;
  row[idx.pred_binary] = predBinary;
  row[idx.correct] = correct;
  row[idx.order] = orderText.slice(0, 200);
  changed++;
}

console.log(`검사 ${checked}건 중 ${changed}건 변경.`);
report.forEach((l) => console.log('- ' + l));

if (changed && !DRY) {
  const out = [header.join(','), ...rows.map((r) => r.map(qcsv).join(','))].join('\r\n');
  fs.writeFileSync(csvPath, '﻿' + out, 'utf8');
  console.log(`갱신: ${csvPath}`);
} else if (DRY) {
  console.log('(--dry: 파일 변경 없음)');
} else {
  console.log('변경 사항 없음 — 파일을 건드리지 않았습니다.');
}
