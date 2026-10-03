// build_overview_r03_batch4.mjs — 3라운드 미평가 2건(620451·622919)의 overview_independent.txt를
// klaw_runner.mjs가 읽는 overview/<id>.json 형식으로 변환한다. 저장소 루트(klaw/)에서 실행.
import fs from 'node:fs';
import path from 'node:path';

const ids = ['620451', '622919'];
fs.mkdirSync('overview', { recursive: true });
for (const id of ids) {
  const src = path.join('library/benchmark/rounds/r03', id, 'overview_independent.txt');
  const text = fs.readFileSync(src, 'utf8');
  fs.writeFileSync(path.join('overview', `${id}.json`), JSON.stringify({ overview_independent: text }, null, 1));
  console.log('작성:', `overview/${id}.json`, `(${text.length}자)`);
}
