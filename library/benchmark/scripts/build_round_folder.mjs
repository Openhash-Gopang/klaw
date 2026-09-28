// build_round_folder.mjs — runs/<tag>·overview_txt·prec_* 등 로컬 산출물을 모아
// library/benchmark/rounds/rNN/ 아래 공개용 폴더(actual_*.txt, overview_*.txt, klaw_verdict.txt,
// results.csv, round-meta.json)로 정리한다. rounds.html이 그대로 읽을 수 있는 구조를 만든다.
// 실행 위치: 저장소 루트(klaw/). 이 스크립트는 로컬 데이터(prec_civil/, chain.csv, split/dev.csv,
// runs/, overview_txt/)가 있는 사용자 PC에서만 실행할 수 있다(원문 미공개 원칙, README §2).
//
// 사용: node library/benchmark/scripts/build_round_folder.mjs --round=3 --version=v16.1 [--tag=r03] [--status=...]
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ROUND = Number(args.round);
if (!ROUND) { console.error('사용: node build_round_folder.mjs --round=N --version=vX.Y'); process.exit(1); }
const RD = args.tag || `r${String(ROUND).padStart(2, '0')}`;
const VERSION = args.version || null;
const STATUS = args.status || null;

const ROOT = process.cwd();
const RUNS_DIR = path.join(ROOT, 'runs', RD);
const OV_REVIEW_DIR = path.join(ROOT, 'overview_txt', 'review');
const OV_INDEP_DIR = path.join(ROOT, 'overview_txt', 'independent');
const OUT_DIR = path.join(ROOT, 'library', 'benchmark', 'rounds', RD);

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
  return lines.slice(1).map((l) => Object.fromEntries(parseLine(l).map((v, i) => [header[i], v])));
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); }
function tidy(t) { return String(t ?? '').replace(/<br\s*\/?>/gi, '\n').trim(); }
function bodyText(p) {
  if (!p || !fs.existsSync(p)) return null;
  const j = readJson(p);
  return tidy(j.PrecService?.['판례내용']);
}

const resCsvPath = path.join(RUNS_DIR, 'results.csv');
if (!fs.existsSync(resCsvPath)) throw new Error(`없음: ${resCsvPath} (klaw_runner.mjs --round=${ROUND} --tag=${RD} 먼저 실행하세요)`);
const rows = readCsv(resCsvPath);
const chainById = new Map(readCsv(path.join(ROOT, 'chain.csv')).map((r) => [r.id, r]));
const devById = new Map(readCsv(path.join(ROOT, 'split', 'dev.csv')).map((r) => [r.id, r]));

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(resCsvPath, path.join(OUT_DIR, 'results.csv'));

let n = 0;
for (const row of rows) {
  const id = row.id;
  const cdir = path.join(OUT_DIR, id);
  fs.mkdirSync(cdir, { recursive: true });

  const vt = path.join(RUNS_DIR, `${id}.txt`);
  if (fs.existsSync(vt)) fs.copyFileSync(vt, path.join(cdir, 'klaw_verdict.txt'));

  const orv = path.join(OV_REVIEW_DIR, `${id}.txt`);
  if (fs.existsSync(orv)) fs.copyFileSync(orv, path.join(cdir, 'overview_review.txt'));
  const oin = path.join(OV_INDEP_DIR, `${id}.txt`);
  if (fs.existsSync(oin)) fs.copyFileSync(oin, path.join(cdir, 'overview_independent.txt'));

  const dev = devById.get(id) || {};
  const ch = chainById.get(id) || {};
  const supPath = dev.date ? path.join(ROOT, 'prec_civil', `${dev.date}_${id}.json`) : null;
  const sup = bodyText(supPath);
  if (sup) fs.writeFileSync(path.join(cdir, 'actual_supreme.txt'), sup + '\n', 'utf8');
  if (ch.found2 === 'True' && ch.id2) {
    const sec = bodyText(path.join(ROOT, 'prec_2nd', `${ch.id2}.json`));
    if (sec) fs.writeFileSync(path.join(cdir, 'actual_second.txt'), sec + '\n', 'utf8');
  }
  if (ch.found1 === 'True' && ch.id1) {
    const fst = bodyText(path.join(ROOT, 'prec_1st', `${ch.id1}.json`));
    if (fst) fs.writeFileSync(path.join(cdir, 'actual_first.txt'), fst + '\n', 'utf8');
  }
  n++;
}

const correct = rows.filter((r) => r.correct === 'true').length;
const meta = {
  method_version: VERSION,
  status: STATUS || `${rows.length}/${rows.length} 건 게재`,
};
fs.writeFileSync(path.join(OUT_DIR, 'round-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

console.log(`완료: ${OUT_DIR} 에 ${n}건 정리 (results.csv, round-meta.json 포함). 결론 일치 ${correct}/${rows.length}.`);
console.log('다음: node library/benchmark/scripts/build_rounds_manifest.mjs 실행 후 커밋하세요.');
