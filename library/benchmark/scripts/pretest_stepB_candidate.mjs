// pretest_stepB_candidate.mjs — 신규 라운드(신규 10건)를 소모하지 않고, 이미 3라운드에서
// 생성해 둔 사건의 STEP 0/A 출력을 그대로 재사용해 STEP B만 후보 방법론 문안으로 다시
// 돌려본다. A-2-2-κ v16.2 후보(library/benchmark/method/dev/klaw_v16_2_candidate.md)가
// 616709·622919·617165 같은 이미 알려진 오판 사례를 실제로 뒤집는지 저비용으로 먼저
// 확인하기 위한 것 — 공식 라운드가 아니므로 rounds/rNN/이나 runs/rNN/에 쓰지 않고
// pretest/<후보태그>/ 아래에 별도로 남긴다. 10라운드 예산 중 남은 라운드를 아끼기 위한
// 사전검증 단계.
//
// 전제: runs/r03/<id>.json (klaw_runner.mjs --round=3 --tag=r03 실행 결과, 로컬 전용,
//       parts.step0·parts.stepA·analysis·config를 담고 있음)이 그대로 남아있어야 한다.
//
// 사용: node library/benchmark/scripts/pretest_stepB_candidate.mjs --round=3 --tag=r03
//       --ids=616709,622919,617165
//       --candidate=library/benchmark/method/dev/klaw_v16_2_candidate.md
//       [--format=가상판결_출력형식_v13_3.txt] [--out=pretest/a22kappa_v16_2]
// 환경변수: DEEPSEEK_API_KEY (klaw_runner.mjs와 동일 계정 — 이미 확정된 STEP 0/A를
//           그대로 이어받는 하류 STEP B 재실행이라 계정 분리 대상 아님)
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ROUND = Number(args.round);
if (!ROUND) { console.error('사용: --round=N --tag=rNN --ids=id1,id2 --candidate=path/to/candidate.md'); process.exit(1); }
const TAG = args.tag || `r${String(ROUND).padStart(2, '0')}`;
const IDS = (args.ids ? String(args.ids).split(',') : []).map((s) => s.trim()).filter(Boolean);
if (!IDS.length) { console.error('--ids=id1,id2,... 를 지정하세요.'); process.exit(1); }
const CANDIDATE = args.candidate;
if (!CANDIDATE || !fs.existsSync(CANDIDATE)) { console.error(`후보 방법론 파일을 찾지 못했습니다: ${CANDIDATE}`); process.exit(1); }
const FORMAT = args.format || '가상판결_출력형식_v13_3.txt';
const OUT = args.out || 'pretest/a22kappa_v16_2';
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const URL = args.url || 'https://api.deepseek.com/chat/completions';
const MODEL = args.model || 'deepseek-flash';
const EFFORT = args.effort || 'high';
const TEMP = args.temperature !== undefined ? Number(args.temperature) : 0.2;
const SCALE = args['budget-scale'] !== undefined ? Number(args['budget-scale']) : 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!KEY) { console.error('DEEPSEEK_API_KEY 환경변수가 없습니다.'); process.exit(1); }

const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };

// ── klaw_runner.mjs와 동일한 채점/추출 규칙 ──
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
function isDeclined(full) { return /【판단\s*불가\s*선언】(?!\s*미발동)/.test(full); }

const P_STEPB_PROMPT = '{{CTX}}\n\nSTEP A가 완료되었습니다. STEP B만 작성하세요.\nB-1~B-7 소항목, 주문+이유 완성, [STEP-B-COMPLETE] 포함.';
const P_SIM = '당신은 K-Law 판결 방법론 {{VER}}을 적용하는 대한민국 법원 판결 AI입니다.\n{{BODY}}위 가상판결 출력형식 v13.3을 반드시 준수하여 판결문을 작성하세요.\n사건번호·심급 등 이번 사건의 구체적인 정보는 이어지는 사용자 메시지에서 확인하세요.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n본 시뮬레이션은 법률 정보 제공 목적이며 법률 자문이 아닙니다.\n가상판결 출력형식 v13.3 | K-Law {{VER}} 적용\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

const methodText = readText(CANDIDATE);
const formatText = readText(FORMAT);
const VERSION = 'v16.2-후보(사전검증)';
const SYSTEM = P_SIM.replace('{{BODY}}', () => '[K-Law 방법론 원문]\n' + methodText + '\n\n---\n\n' + '[가상판결 출력형식 v13.3]\n' + formatText + '\n\n---\n\n').replace(/\{\{VER\}\}/g, () => VERSION);

async function chat(messages, maxTokens) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model: MODEL, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true }, temperature: TEMP, thinking: { type: 'enabled' }, reasoning_effort: EFFORT };
    let r;
    try { r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_200_000) }); }
    catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
      throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder('utf-8');
    let buf = ''; let content = ''; let finish = null;
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim(); if (d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        const ch = j.choices?.[0];
        if (ch) { const dl = ch.delta || {}; if (dl.content) content += dl.content; if (ch.finish_reason) finish = ch.finish_reason; }
      }
    }
    return { content, finish };
  }
  throw new Error('API 재시도 초과');
}

fs.mkdirSync(OUT, { recursive: true });
const report = [];

for (const id of IDS) {
  const jsonPath = path.join('runs', TAG, `${id}.json`);
  if (!fs.existsSync(jsonPath)) { report.push(`${id}: ${jsonPath} 없음 — 건너뜀 (klaw_runner.mjs --round=${ROUND} --tag=${TAG} 로컬 산출물이 있어야 함)`); continue; }
  const rec = JSON.parse(readText(jsonPath));
  const step0 = rec.parts?.step0, stepA = rec.parts?.stepA;
  if (!step0 || !stepA) { report.push(`${id}: parts.step0/stepA 없음 — 건너뜀`); continue; }
  const level = rec.level || '3심';
  const caseNo = rec.caseNo_sim || `SIM-PRETEST-${id}`;
  const baseCtx = '사용자: 사건의 개요:\n' + rec.analysis /* analysis 안에 개요 텍스트가 없으므로 참고용, STEP B는 STEP0/A 출력만으로도 충분 */;
  const prev = [step0, stepA].join('\n\n');
  const ctx = `[사건번호: ${caseNo} | 심급: ${level}]\n\n[이전 STEP 출력]\n${prev}\n\n[사건 정보]\n${baseCtx}`;
  const budget = Math.round(16000 * (rec.config?.budget_scale || SCALE));

  console.log(`[${id}] STEP B 재생성 중 (후보 v16.2)...`);
  let r = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: P_STEPB_PROMPT.replace('{{CTX}}', () => ctx) }], budget);
  if (r.finish === 'length') { const r2 = await chat([{ role: 'system', content: SYSTEM }, { role: 'user', content: P_STEPB_PROMPT.replace('{{CTX}}', () => ctx) }], Math.round(budget * 1.5)); if (r2.content.trim()) r = r2; }
  const newStepB = r.content;
  fs.writeFileSync(path.join(OUT, `${id}_stepB_candidate.txt`), newStepB, 'utf8');

  const fullForDeclined = [step0, stepA, newStepB].join('\n\n');
  const declined = isDeclined(fullForDeclined);
  const orderText = extractOrder(newStepB);
  const [newLabel, newBinary] = declined ? ['판단불가', '유보'] : classify(orderText);

  const oldLabel = rec.predicted?.label; const oldBinary = rec.predicted?.binary;
  const actualLabel = rec.actual?.label; const actualBinary = rec.actual?.binary;
  const flipped = newBinary !== oldBinary;
  const nowCorrect = newBinary === actualBinary;
  const wasCorrect = oldBinary === actualBinary;

  const line = `${id}: 실제=${actualLabel}/${actualBinary} | v16.1(기존)=${oldLabel}/${oldBinary}(정답:${wasCorrect}) → v16.2후보=${newLabel}/${newBinary}(정답:${nowCorrect}) ${flipped ? '[결론 변경]' : '[변화 없음]'}`;
  console.log(line);
  report.push(line);

  fs.writeFileSync(path.join(OUT, `${id}_result.json`), JSON.stringify({ id, actual: rec.actual, before: { label: oldLabel, binary: oldBinary }, after: { label: newLabel, binary: newBinary }, flipped, nowCorrect, orderText }, null, 2), 'utf8');
}

console.log('\n=== 요약 ===');
report.forEach((l) => console.log('- ' + l));
console.log(`\n결과 파일: ${OUT}/ (공식 라운드 데이터가 아니므로 커밋하지 마세요 — 검토용)`);
