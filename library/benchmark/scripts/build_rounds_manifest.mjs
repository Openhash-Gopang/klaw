// build_rounds_manifest.mjs — scans library/benchmark/rounds/rNN/ and writes rounds-manifest.json
// for rounds.html to render. Pure filesystem scan + CSV/JSON read; no network, no API calls.
// Run from the repo root (where library/ lives), or pass --root=<repo root>.
import fs from 'node:fs'; import path from 'node:path';
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const ROOT = args.root || '.';
const BM = path.join(ROOT, 'library', 'benchmark');
const ROUNDS_DIR = path.join(BM, 'rounds');
const OUT = path.join(BM, 'rounds-manifest.json');

function readCsv(p) {
  if (!fs.existsSync(p)) return [];
  const text = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const lines = text.split('\n').filter((l) => l.length);
  if (!lines.length) return [];
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
function readJson(p, dflt) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function exists(p) { return fs.existsSync(p); }
function rel(p) { return path.relative(ROOT, p).split(path.sep).join('/'); }

// expected round size, from the published dev-set split (data/split/dev.csv), if available
const devCsv = readCsv(path.join(BM, 'data', 'split', 'dev.csv'));
const expectedByRound = {};
for (const r of devCsv) { const k = Number(r.round); if (k) expectedByRound[k] = (expectedByRound[k] || 0) + 1; }

function buildCandidate(dir, meta) {
  if (!meta?.candidate?.tag) return null;
  const cdir = path.join(dir, `candidate-${meta.candidate.label || 'candidate'}`);
  const csv = readCsv(path.join(cdir, 'results.csv'));
  return {
    label: meta.candidate.label || 'candidate', tag: meta.candidate.tag,
    note: meta.candidate.note || null,
    results_csv: exists(path.join(cdir, 'results.csv')) ? rel(path.join(cdir, 'results.csv')) : null,
    summary: meta.candidate.summary || (csv.length ? summarize(csv) : null),
    verdicts: fs.existsSync(cdir) ? fs.readdirSync(cdir, { withFileTypes: true }).filter((d) => d.isDirectory())
      .map((d) => ({ id: d.name, verdict: exists(path.join(cdir, d.name, 'klaw_verdict.txt')) ? rel(path.join(cdir, d.name, 'klaw_verdict.txt')) : null })) : [],
  };
}
function summarize(rows) {
  const n = rows.length; const correct = rows.filter((r) => r.correct === 'true' || r.correct === true).length;
  const byBin = (bin) => { const sub = rows.filter((r) => r.actual_binary === bin); return { n: sub.length, correct: sub.filter((r) => r.correct === 'true' || r.correct === true).length }; };
  return { n, correct, keep: byBin('유지'), reverse: byBin('파기') };
}

const rounds = [];
for (let r = 1; r <= 10; r++) {
  const rd = `r${String(r).padStart(2, '0')}`;
  const dir = path.join(ROUNDS_DIR, rd);
  if (!fs.existsSync(dir)) { rounds.push({ round: r, status: '예정' }); continue; }
  const meta = readJson(path.join(dir, 'round-meta.json'), {});
  const rows = readCsv(path.join(dir, 'results.csv'));
  const expected = expectedByRound[r] || null;
  const status = meta.status || (expected ? `${rows.length}/${expected} 건 게재` : `${rows.length}건 게재`);
  const cases = rows.map((row) => {
    const cdir = path.join(dir, row.id);
    const docOrNull = (name) => exists(path.join(cdir, name)) ? rel(path.join(cdir, name)) : null;
    return {
      id: row.id, actual_label: row.actual_label, actual_binary: row.actual_binary,
      pred_label: row.pred_label, pred_binary: row.pred_binary, correct: row.correct === 'true',
      conclusion_type: row.conclusion_type || null,
      docs: {
        supreme: docOrNull('actual_supreme.txt'), second: docOrNull('actual_second.txt'), first: docOrNull('actual_first.txt'),
        overview_review: docOrNull('overview_review.txt'), overview_independent: docOrNull('overview_independent.txt'),
        verdict: docOrNull('klaw_verdict.txt'),
      },
    };
  });
  rounds.push({
    round: r, status, method_version: meta.method_version || null,
    decision_doc: exists(path.join(dir, 'decision.md')) ? rel(path.join(dir, 'decision.md')) : null,
    results_csv: exists(path.join(dir, 'results.csv')) ? rel(path.join(dir, 'results.csv')) : null,
    summary: rows.length ? summarize(rows) : null,
    candidate: buildCandidate(dir, meta),
    cases,
  });
}

fs.mkdirSync(BM, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), rounds }, null, 2), 'utf8');
console.log(`작성: ${OUT}`);
for (const r of rounds) console.log(`  라운드 ${r.round}: ${r.status}${r.method_version ? ' | ' + r.method_version : ''}`);
