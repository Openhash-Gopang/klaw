const fs = require('fs'), path = require('path');
const { W, SRC, CHK, AN } = process.env;
const rd = (p) => { let t = fs.readFileSync(p, 'utf8'); return t.charCodeAt(0) === 0xFEFF ? t.slice(1) : t; };
const ids = ['SIM-2026-0004', 'SIM-2026-0005'];
for (const d of ['runs/c3', 'runs/c3-check', 'overview']) fs.mkdirSync(path.join(W, d), { recursive: true });
for (const id of ids) {
  const gen = rd(path.join(SRC, `${id}_generated.txt`));
  const ov = rd(path.join(SRC, `case_overview_${id}.txt`));
  const chk = rd(path.join(CHK, `${id}_check.txt`));
  const an = rd(path.join(AN, `analysis_${id}.txt`));
  // 합본 안의 [최종 판결문 시작]…[끝] 블록(STEP V-공통점검이 새로 쓴 것) — 줄 단독 표지만 인정, 마지막 쌍 사용
  const re = /^[ \t*]*\[최종\s*판결문\s*시작\][ \t*]*$([\s\S]*?)^[ \t*]*\[최종\s*판결문\s*끝\][ \t*]*$/gm;
  let last = null, m; while ((m = re.exec(gen)) !== null) last = m[1];
  const finalText = last ? last.trim() : '';
  let order = '';
  if (finalText) { const a = finalText.indexOf('주 문'); const b = finalText.indexOf('이 유'); if (a >= 0 && b > a) order = finalText.slice(a + 4, b).replace(/^[:：\s]+/, '').trim(); }
  const rec = {
    id, caseNo_sim: id, level: '3심', analysis: an,
    config: { version: 'v17.1', method: 'klaw_v17_1.md', format: '가상판결_출력형식_v13_3.txt', model: 'deepseek-flash' },
    parts: { step0: gen },   // 합본 전체(STEP 0·A·B·V-공통점검·C)를 한 덩어리로 전달
    predicted: { order },
    self_check: finalText ? { final_text: finalText, final_source: 'STEPVSC(합본 내 [최종 판결문] 블록)' } : undefined,
  };
  fs.writeFileSync(path.join(W, 'runs/c3', `${id}.json`), JSON.stringify(rec), 'utf8');
  fs.writeFileSync(path.join(W, 'runs/c3-check', `${id}.json`), JSON.stringify({ id, report: chk }), 'utf8');
  fs.writeFileSync(path.join(W, 'overview', `${id}.json`), JSON.stringify({ overview_independent: ov }), 'utf8');
  console.log(id, '합본', gen.length, '자 / 검수보고서', chk.length, '자 / 개요', ov.length, '자 / 최종 블록', finalText.length, '자 / 주문', order.slice(0, 40));
}
