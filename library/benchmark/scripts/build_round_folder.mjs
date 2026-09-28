// build_round_folder.mjs — runs/<tag>·overview_txt·prec_* 등 로컬 산출물을 모아
// library/benchmark/rounds/rNN/ 아래 공개용 폴더(actual_*.txt, overview_*.txt, klaw_verdict.txt,
// results.csv, round-meta.json)로 정리한다. rounds.html이 그대로 읽을 수 있는 구조를 만든다.
// 실행 위치: 저장소 루트(klaw/). 이 스크립트는 로컬 데이터(prec_civil/, chain.csv, split/dev.csv,
// runs/, overview_txt/)가 있는 사용자 PC에서만 실행할 수 있다(원문 미공개 원칙, README §2).
//
// 사용(일반 — 채점 완료 후): node library/benchmark/scripts/build_round_folder.mjs --round=3 --version=v16.1 [--tag=r03] [--status=...]
//
// 사용(--docs-only — 채점(klaw_runner.mjs) 전, 원문만 먼저 게시할 때, v1.1 신설):
//   node library/benchmark/scripts/build_round_folder.mjs --round=5 --docs-only
//   runs/<tag>/results.csv가 아직 없어도 된다. 사건 목록은 split/dev.csv의 round 열로 정한다.
//   klaw_verdict.txt·overview_*.txt·results.csv는 만들지 않고(아직 없으므로), actual_supreme.txt·
//   actual_second.txt·actual_first.txt(대법원/2심/1심 원문)만 채운다. round-meta.json에
//   docs_only:true를 남겨 build_rounds_manifest.mjs가 "원문만 게시, 채점 진행 중" 상태로 렌더링하게
//   한다. 이후 채점이 끝나면 --docs-only 없이 다시 실행해 같은 폴더를 덮어써 완전한 상태로 만든다
//   (기존 actual_*.txt는 그대로 재사용되고 klaw_verdict.txt 등이 추가된다).
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ROUND = Number(args.round);
if (!ROUND) { console.error('사용: node build_round_folder.mjs --round=N --version=vX.Y [--docs-only]'); process.exit(1); }
const RD = args.tag || `r${String(ROUND).padStart(2, '0')}`;
const VERSION = args.version || null;
const STATUS = args.status || null;
const DOCS_ONLY = !!args['docs-only'];

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

const chainById = new Map(readCsv(path.join(ROOT, 'chain.csv')).map((r) => [r.id, r]));
const devRows = readCsv(path.join(ROOT, 'split', 'dev.csv'));
const devById = new Map(devRows.map((r) => [r.id, r]));

fs.mkdirSync(OUT_DIR, { recursive: true });

function writeDocsForCase(id) {
  const cdir = path.join(OUT_DIR, id);
  fs.mkdirSync(cdir, { recursive: true });
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
  return cdir;
}

if (DOCS_ONLY) {
  // 채점 전: split/dev.csv의 round 열로만 사건 목록을 정하고, 원문(대법원/2심/1심)만 채운다.
  // klaw_verdict.txt·overview_*.txt·results.csv는 아직 없으므로 만들지 않는다.
  const roundRows = devRows.filter((r) => Number(r.round) === ROUND);
  if (!roundRows.length) throw new Error(`split/dev.csv에 round=${ROUND}인 행이 없습니다.`);
  let n = 0;
  for (const row of roundRows) { writeDocsForCase(row.id); n++; }
  const meta = {
    method_version: VERSION,
    docs_only: true,
    status: STATUS || `원문 ${n}건 게재, K-Law 채점 진행 중`,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'round-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  console.log(`완료(원문만): ${OUT_DIR} 에 ${n}건 (대법원/2심/1심 원문). klaw_verdict.txt·results.csv는 아직 없음.`);
  console.log('채점이 끝나면 --docs-only 없이 다시 실행해 같은 폴더를 완전한 상태로 갱신하세요.');
  console.log('다음: node library/benchmark/scripts/build_rounds_manifest.mjs 실행 후 커밋하세요.');
} else {
  const resCsvPath = path.join(RUNS_DIR, 'results.csv');
  if (!fs.existsSync(resCsvPath)) throw new Error(`없음: ${resCsvPath} (klaw_runner.mjs --round=${ROUND} --tag=${RD} 먼저 실행하거나, 원문만 먼저 게시하려면 --docs-only를 쓰세요)`);
  const rows = readCsv(resCsvPath);
  fs.copyFileSync(resCsvPath, path.join(OUT_DIR, 'results.csv'));

  let n = 0;
  for (const row of rows) {
    const id = row.id;
    const cdir = writeDocsForCase(id);

    const vt = path.join(RUNS_DIR, `${id}.txt`);
    if (fs.existsSync(vt)) fs.copyFileSync(vt, path.join(cdir, 'klaw_verdict.txt'));

    const orv = path.join(OV_REVIEW_DIR, `${id}.txt`);
    if (fs.existsSync(orv)) fs.copyFileSync(orv, path.join(cdir, 'overview_review.txt'));
    const oin = path.join(OV_INDEP_DIR, `${id}.txt`);
    if (fs.existsSync(oin)) fs.copyFileSync(oin, path.join(cdir, 'overview_independent.txt'));
    n++;
  }

  const correct = rows.filter((r) => r.correct === 'true').length;
  const meta = {
    method_version: VERSION,
    docs_only: false,
    status: STATUS || `${rows.length}/${rows.length} 건 게재`,
  };
  fs.writeFileSync(path.join(OUT_DIR, 'round-meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  console.log(`완료: ${OUT_DIR} 에 ${n}건 정리 (results.csv, round-meta.json 포함). 결론 일치 ${correct}/${rows.length}.`);
  console.log('다음: node library/benchmark/scripts/build_rounds_manifest.mjs 실행 후 커밋하세요.');
}
