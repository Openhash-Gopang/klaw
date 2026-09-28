// explainer_writer.mjs — 부속설명자료(원고 최강 논거·피고 최강 논거·판결 논리 확장·쉬운 설명)를
// 이미 확정된 K-Law 판결문을 대상으로 DeepSeek에게 작성시킨다. (DeepSeek API, Node 18+)
// 절대 규칙(부속설명자료_출력형식 최신본 원칙 1): 섹션 1~3은 이미 확정된 K-Law 결론을
// 뒤집지 않는다 — 새 결론을 만들지 않고, 그 결론을 설명·재구성만 한다. 원칙 5: 4개
// 섹션을 독립 호출·독립 파일로 처리한다. 원칙 6(v1.1): 쟁점이 여럿인 사건의 결론을
// 단일 교훈으로 뭉개는 것 금지.
//
// v1.2 안전장치(원칙 1·2·7 — 섹션 4 한정 예외): results.csv의 correct 열이 false인
// "불일치 사건"(K-Law 예측 ≠ 대법원 실제 결론)에서는 섹션 4(쉬운 설명)만 K-Law의
// 판결문이 아니라 그 사건 폴더의 actual_supreme.txt(대법원 실제 판결문)를 전제로
// 작성하도록 별도 컨텍스트를 주입하고, misjudgment_diagnosis.md(사람이 미리 작성해
// 둔 오판 원인 진단 노트, 있는 경우에 한함)를 함께 넘겨 "K-Law가 놓친 이유와 그
// 이후" 항목을 쓰게 한다. 진단 노트가 없으면 원인을 지어내지 않고 "조사 중"이라고
// 쓰도록 지시한다. 섹션 1~3은 이 예외와 무관하게 기존 규칙을 그대로 따른다.
//
// v1.1 안전장치: --format을 지정하지 않으면 저장소 루트에서
// 부속설명자료_출력형식_v[0-9_]+\.txt 패턴의 파일을 스캔해 버전이 가장 높은 파일을
// 자동으로 쓴다(klaw_runner.mjs의 resolveLatestMethod()와 동일한 방식). 이 파일을
// 개정할 때는 새 버전명으로 파일명을 바꾸기만 하면 되고, 이 스크립트를 고칠 필요가 없다.
//
// 사용:
//   node explainer_writer.mjs --round=1 [--ids=621985,620463] [--force]
//        [--format=부속설명자료_출력형식_v1_1.txt] [--model=deepseek-flash]
//        [--thinking=enabled|disabled] [--effort=high] [--temperature=0.2] [--max-tokens=16000]
//        [--root=.] [--concurrency=2] [--dry] [--selftest]
// 환경변수: DEEPSEEK_API_KEY (klaw_runner.mjs 판결 생성과 같은 계정 — 이미 확정된 판결문·개요를
//           재료로만 쓰는 하류 작업이라 별도 계정 분리 대상이 아님)
// 저장 위치: library/benchmark/rounds/r{RR}/{사건ID}/ 아래
//   plaintiff_theory.md, defendant_theory.md, judgment_logic.md, easy_explain.md
// 실행 후: build_rounds_manifest.mjs를 다시 돌려 rounds-manifest.json을 갱신해야
//         rounds.html의 "분석 자료" 버튼에 반영된다.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const ROOT = args.root || '.';

function resolveLatestFormat(root) {
  const files = fs.readdirSync(root).filter((n) => /^부속설명자료_출력형식_v[\d_]+\.txt$/i.test(n));
  if (!files.length) throw new Error('저장소 루트에 부속설명자료_출력형식_v*.txt 파일이 없습니다.');
  const parseVer = (name) => {
    const m = name.match(/부속설명자료_출력형식_v(\d+)_?(\d*)\.txt/i);
    return m ? parseFloat(`${m[1]}.${m[2] || '0'}`) : 0;
  };
  files.sort((a, b) => parseVer(b) - parseVer(a));
  return files[0];
}
const FORMAT = args.format || resolveLatestFormat(ROOT);
const ROUND = Number(args.round || 1);
const RTAG = `r${String(ROUND).padStart(2, '0')}`;
const ROUND_DIR = path.join(ROOT, 'library', 'benchmark', 'rounds', RTAG);
const MODEL = args.model || 'deepseek-flash';
const THINK = (args.thinking || 'enabled') === 'enabled';
const EFFORT = args.effort || 'high';
const TEMP = args.temperature !== undefined ? Number(args.temperature) : 0.2;
const MAXTOK = Number(args['max-tokens'] || 16000);
const CONC = Math.max(1, Number(args.concurrency || 2));
const FORCE = !!args.force;
const DRY = !!args.dry;
const IDS_FILTER = args.ids ? String(args.ids).split(',').map((s) => s.trim()).filter(Boolean) : null;
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const URL = args.url || 'https://api.deepseek.com/chat/completions';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; } else f += c;
  }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const c2 = rows.filter((r) => !(r.length === 1 && r[0] === '')); const [h, ...b] = c2;
  return b.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}

// ── 출력형식 스펙에서 섹션별 출력 구조 블록만 추출 (단일 출처 유지: 스펙이 바뀌면 자동 반영) ──
const formatText = readText(path.join(ROOT, FORMAT));
function extractSection(label) {
  const re = new RegExp(`## \\[섹션 \\d+\\] ${label}[\\s\\S]*?\\n\`\`\`[\\s\\S]*?\`\`\``, 'm');
  const m = formatText.match(re);
  if (!m) throw new Error(`출력형식 문서에서 "${label}" 섹션을 찾지 못했습니다 — 스펙이 바뀌었을 수 있습니다.`);
  return m[0];
}
const SEC = {
  plaintiff: { file: 'plaintiff_theory.md', label: '원고 최강 논거', order: 1 },
  defendant: { file: 'defendant_theory.md', label: '피고 최강 논거', order: 2 },
  judgment: { file: 'judgment_logic.md', label: '판결 논리 확장', order: 3 },
  easy: { file: 'easy_explain.md', label: '쉬운 설명', order: 4 },
};
for (const k of Object.keys(SEC)) SEC[k].spec = extractSection(SEC[k].label);

const COMMON_PRINCIPLES = (formatText.match(/## 공통 원칙 \(강제\)[\s\S]*?(?=\n---)/) || [''])[0];
if (!COMMON_PRINCIPLES.trim()) throw new Error('출력형식 문서에서 "공통 원칙" 절을 찾지 못했습니다.');

const SYSTEM = `당신은 K-Law 부속설명자료 작성 시스템입니다. 아래는 이 작업의 강제 이행 형식(부속설명자료 출력형식 v1.0) 중 공통 원칙입니다. 반드시 준수하십시오.\n\n${COMMON_PRINCIPLES}\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n본 자료는 법률 정보 제공 목적이며 법률 자문이 아닙니다. 이미 확정된 K-Law 판결의 결론을 전제로 하며, 그 결론을 뒤집는 논증을 구성하지 않습니다.\n부속설명자료 출력형식 v1.0\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

if (args.selftest) {
  console.log('SYSTEM 길이:', SYSTEM.length, '| 섹션 4개 추출 성공:', Object.keys(SEC).every((k) => SEC[k].spec.length > 0));
  process.exit(0);
}
if (!KEY && !DRY) { console.error('DEEPSEEK_API_KEY 환경변수가 없습니다.'); process.exit(1); }
if (KEY && !/^[\x21-\x7E]+$/.test(KEY)) { console.error(`DEEPSEEK_API_KEY에 공백·한글 등 허용되지 않는 문자가 섞여 있습니다(길이 ${KEY.length}).`); process.exit(1); }

// ── 대상 사건: results.csv에서 읽는다(이미 채점까지 끝난 사건만 대상 — 발동 조건 1) ──
const resultsCsv = path.join(ROUND_DIR, 'results.csv');
if (!fs.existsSync(resultsCsv)) { console.error(`없음: ${resultsCsv} — 이 라운드는 아직 채점이 끝나지 않았습니다.`); process.exit(1); }
const resultRows = parseCsv(readText(resultsCsv));
const resultById = Object.fromEntries(resultRows.map((r) => [r.id, r]));
let cases = resultRows.map((r) => r.id);
if (IDS_FILTER) cases = cases.filter((id) => IDS_FILTER.includes(id));
if (!cases.length) { console.error('대상 사건이 없습니다.'); process.exit(1); }

// ── API (스트리밍, klaw_runner.mjs와 동일 방식) ──────
async function chat(messages, maxTokens) {
  const opt = { temperature: TEMP, thinking: true };
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model: MODEL, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    if (opt.temperature !== null) body.temperature = opt.temperature;
    if (opt.thinking) { body.thinking = { type: THINK ? 'enabled' : 'disabled' }; if (THINK) body.reasoning_effort = EFFORT; }
    let r;
    try { r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_200_000) }); }
    catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 400 && opt.temperature !== null && /temperature/i.test(txt)) { opt.temperature = null; attempt--; continue; }
      if (r.status === 400 && opt.thinking && /thinking|reasoning_effort/i.test(txt)) { opt.thinking = false; console.error('참고: thinking 관련 필드를 받지 않아 생략합니다.'); attempt--; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
      throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder('utf-8');
    let buf = ''; let content = ''; let finish = null;
    try {
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
    } catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    return { content, finish };
  }
  throw new Error('API 재시도 초과');
}

// ── 한 사건의 4개 섹션 생성 ──────────────────────────
async function runCase(id) {
  const cdir = path.join(ROUND_DIR, id);
  const verdictPath = path.join(cdir, 'klaw_verdict.txt');
  if (!fs.existsSync(verdictPath)) throw new Error(`판결문 없음: ${verdictPath}`);
  const verdict = readText(verdictPath);
  const ovPath = fs.existsSync(path.join(cdir, 'overview_review.txt'))
    ? path.join(cdir, 'overview_review.txt')
    : path.join(cdir, 'overview_independent.txt');
  const overview = fs.existsSync(ovPath) ? readText(ovPath) : '(개요 파일을 찾지 못함)';
  const hasGamma = /\[B-4-γ\s*결정적\s*판단\s*근거\]/.test(verdict);
  const gammaNote = hasGamma
    ? '이 판결문에는 [B-4-γ 결정적 판단 근거] 블록이 있습니다. 그 내용을 그대로 이어받아 사용하십시오.'
    : '이 판결문은 [B-4-γ 결정적 판단 근거] 블록이 신설되기 이전 방법론(v15.1)으로 생성되어 그 블록이 없습니다. 판결문의 실제 이유 설시에서 결정적 근거에 해당하는 부분을 직접 찾아 같은 형식(조건→분기점→결정적 근거)으로 재구성하십시오. 판결문에 없는 근거를 새로 창작하지 마십시오.';

  const baseCtx = `[사건ID: ${id}]\n\n[사건 개요]\n${overview}\n\n[확정된 K-Law 판결문 전문]\n${verdict}\n\n[참고] ${gammaNote}`;

  // ── 불일치 사건 판정 (원칙 1·2·7 — 섹션 4 한정 예외) ──
  const row = resultById[id];
  const isMismatch = row && String(row.correct).trim().toLowerCase() === 'false';
  let mismatchCtx = '';
  if (isMismatch) {
    const actualPath = path.join(cdir, 'actual_supreme.txt');
    const diagPath = path.join(cdir, 'misjudgment_diagnosis.md');
    const actualText = fs.existsSync(actualPath) ? readText(actualPath) : null;
    const diagText = fs.existsSync(diagPath) ? readText(diagPath) : null;
    if (!actualText) console.error(`참고: ${id}는 불일치 사건인데 actual_supreme.txt를 찾지 못했습니다 — 섹션 4를 실제 결론 없이 생성할 수 없으니 별도 확인이 필요합니다.`);
    mismatchCtx = `\n\n[불일치 사건 안내 — 섹션 4(쉬운 설명) 전용, 원칙 1·2·7]\n`
      + `이 사건은 K-Law의 예측(${row.pred_label}/${row.pred_binary})이 대법원 실제 결론(${row.actual_label}/${row.actual_binary})과 다른 "불일치 사건"입니다.\n`
      + `섹션 4(쉬운 설명)만 다음을 따르십시오 — 섹션 1~3은 이 안내와 무관하게 기존 규칙(K-Law 판결문 전제)을 그대로 따릅니다:\n`
      + `- 본문·"진짜 다툼이 된 것"·"핵심 교훈"은 위 [확정된 K-Law 판결문 전문]이 아니라, 아래 [대법원 실제 판결문]을 전제로 작성하십시오.\n`
      + `- 마지막에 "### K-Law가 놓친 이유와 그 이후" 항목을 추가하십시오. 원인은 아래 [오판 원인 진단 노트]가 있을 때만 그 내용을 쉬운 말로 옮기고, 없으면 "원인을 조사하는 중입니다"라고만 쓰십시오(추론으로 채우지 마십시오). 방법론 갱신 내용도 진단 노트에 확정 패치가 적혀 있을 때만 그것을 쓰고, 없으면 "아직 지켜보는 단계"라고 쓰십시오.\n`
      + (actualText ? `\n[대법원 실제 판결문]\n${actualText}\n` : '\n[대법원 실제 판결문] (찾지 못함 — 실제 결론 레이블만으로 신중하게 작성)\n')
      + (diagText ? `\n[오판 원인 진단 노트]\n${diagText}\n` : '\n[오판 원인 진단 노트] (없음 — "원인을 조사하는 중입니다"라고만 쓸 것)\n');
  }

  const written = {};
  for (const key of ['plaintiff', 'defendant', 'judgment', 'easy']) {
    const s = SEC[key];
    const outPath = path.join(cdir, s.file);
    if (!FORCE && fs.existsSync(outPath)) { written[key] = 'skip'; continue; }
    const prevRefs = (key === 'judgment')
      ? `\n\n[참고 — 앞서 작성한 원고/피고 최강 논거]\n[원고]\n${written._plaintiffText || '(없음)'}\n\n[피고]\n${written._defendantText || '(없음)'}`
      : '';
    const extra = (key === 'easy') ? mismatchCtx : '';
    const userMsg = `${baseCtx}${prevRefs}${extra}\n\n이번에는 아래 [섹션] "${s.label}"만 작성하십시오. 이 섹션의 출력 구조를 그대로 따르되, 굵게 표시된 부분은 실제 내용으로 채우십시오.\n\n${s.spec}`;
    const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }];
    let r = await chat(msgs, MAXTOK);
    if (!r.content.trim()) r = await chat(msgs, MAXTOK + 6000);
    if (r.finish === 'length') { const r2 = await chat(msgs, Math.round(MAXTOK * 1.5)); if (r2.content.trim()) r = r2; }
    if (!r.content.trim()) throw new Error(`${id} / ${key}: 빈 응답(재시도 후에도)`);
    fs.writeFileSync(outPath, r.content.trim() + '\n', 'utf8');
    written[key] = 'ok';
    if (key === 'plaintiff') written._plaintiffText = r.content.trim();
    if (key === 'defendant') written._defendantText = r.content.trim();
  }
  return written;
}

// ── 실행과 보고 ──────────────────────────────────────
if (DRY) {
  console.log(`대상 라운드 ${RTAG}, 사건 ${cases.length}건: ${cases.join(', ')}`);
  console.log(`모델 ${MODEL} | thinking ${THINK ? 'enabled/' + EFFORT : 'disabled'} | max-tokens ${MAXTOK}`);
  process.exit(0);
}
const fmtT = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const m = Math.floor(s / 60); return m ? `${m}분 ${s % 60}초` : `${s}초`; };
let finished = 0; const tStart = Date.now();
const progress = (n) => { finished++; const el = Date.now() - tStart; return `[${finished}/${n}] 경과 ${fmtT(el)}, 남은 시간 약 ${fmtT((el / finished) * (n - finished))} |`; };

console.log(`대상 라운드 ${RTAG}, 사건 ${cases.length}건 (동시 ${CONC}건). --force 없으면 이미 있는 섹션은 건너뜁니다.`);
const queue = [...cases]; let failed = 0;
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const id = queue.shift();
    try {
      const w = await runCase(id);
      const summary = Object.entries(w).filter(([k]) => !k.startsWith('_')).map(([k, v]) => `${k}:${v}`).join(' ');
      console.log(`${progress(cases.length)} ${id} — ${summary}`);
    } catch (e) { failed++; console.error(`${progress(cases.length)} 실패 ${id}: ${e.message}`); }
  }
}));
console.log(`완료. 실패 ${failed}건. 이제 build_rounds_manifest.mjs를 다시 실행해 rounds-manifest.json을 갱신하세요.`);
