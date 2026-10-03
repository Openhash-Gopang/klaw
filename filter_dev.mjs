// filter_dev.mjs — split/dev.csv에서 지정한 id만 뽑아 split/dev_r01_retest.csv로 저장.
// 사용: node filter_dev.mjs
import fs from 'node:fs';

const IDS = ['616497', '617151', '621985', '622917'];
const SRC = 'split/dev.csv';
const DST = 'split/dev_r01_retest.csv';

function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function serializeRow(fields) {
  return fields.map((f) => `"${String(f).replace(/"/g, '""')}"`).join(',');
}

let text = fs.readFileSync(SRC, 'utf8');
const rows = parseCsv(text);
const [header, ...body] = rows;
const idCol = header.findIndex((h) => h.trim().toLowerCase() === 'id');
if (idCol === -1) { console.error('헤더에 id 컬럼이 없습니다:', header); process.exit(1); }

const kept = body.filter((r) => IDS.includes(r[idCol]));
const out = [header, ...kept].map(serializeRow).join('\n') + '\n';
fs.writeFileSync(DST, out, 'utf8');

console.log(`선택된 ${kept.length}/${IDS.length}건 → ${DST}`);
const missing = IDS.filter((id) => !kept.some((r) => r[idCol] === id));
if (missing.length) console.warn('dev.csv에서 찾지 못한 id:', missing.join(', '));
