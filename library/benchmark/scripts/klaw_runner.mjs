// klaw_runner.mjs — K-Law 운영 파이프라인(desktop.html 커밋 2742848의 프롬프트·STEP 구조)을 그대로 재현해
// 사건 개요 → 가상 판결(분석 → STEP 0 → A → B → C)을 만들고, 주문을 규칙으로 채점한다. (DeepSeek API, Node 18+)
// 사용:
//   node klaw_runner.mjs --round=1 [--method=klaw_v15_1.md] [--format=가상판결_출력형식_v13_3.txt] [--version=v15.1]
//        [--tag=r01] [--model=deepseek-flash] [--thinking=enabled|disabled] [--effort=high] [--temperature=0.2]
//        [--budget-scale=3] [--self-check=auto] [--dev=split/dev.csv] [--overview=overview] [--out=runs] [--concurrency=3] [--limit=N] [--force] [--dry] [--selftest]
// 환경변수: DEEPSEEK_API_KEY
// 운영과 같은 점: system 프롬프트(방법론+출력형식)는 모든 호출에서 바이트 단위로 동일 → DeepSeek 접두 캐시 적중.
//                STEP 0/A/B/C는 각각 [system, user] 2개 메시지의 독립 호출이며 이전 STEP 출력은 user 메시지에 실린다.
// 자기 검증(--self-check=auto|on|off, 기본 auto): 방법론에 'STEP V – 자기 검증'이 있으면 STEP B 직후 결정론적 점검(lint)을 돌려
//   과도한 파기 패턴이 잡히면 STEP V(자기 검증·재검토)를 강제로 실행하고, V의 '최종 주문'을 결론으로 채택한다. 점검 전 결론도 함께 기록한다.
// 운영과 다른 점(기록 대상): 후속 질문(【추가질문】)에 답하지 않음, 분석 단계 토큰 예산 4000, 사건번호는 SIM-일련번호,
//   STEP 토큰 예산을 --budget-scale(기본 3)배로 키움(시험에서 STEP A가 운영 예산 14000과 1.6배 22400에서 모두 잘림; 추론 토큰이 4천~1만 개로 크게 변동). 그래도 잘리면 1.5배로 한 번 더 재시도.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const METHOD = args.method || 'klaw_v15_1.md';
const FORMAT = args.format || '가상판결_출력형식_v13_3.txt';
const VERSION = args.version || (() => { const m = path.basename(METHOD).match(/klaw_v(\d+)_?(\d*)/); return m ? `v${m[1]}.${m[2] || '0'}` : 'v15.1'; })();
const MODEL = args.model || 'deepseek-flash';
const THINK = (args.thinking || 'enabled') === 'enabled';
const EFFORT = args.effort || 'high';
const TEMP = args.temperature !== undefined ? Number(args.temperature) : 0.2;
const SCALE = args['budget-scale'] !== undefined ? Number(args['budget-scale']) : 3;   // 운영 예산(9000/14000/16000/9000)의 배수. 1이면 운영과 동일
const DEV = args.dev || 'split/dev.csv';
const OVDIR = args.overview || 'overview';
const ROUND = args.round ? Number(args.round) : null;
const TAG = args.tag || (ROUND ? `r${String(ROUND).padStart(2, '0')}` : 'run');
const OUT = path.join(args.out || 'runs', TAG);
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONC = Math.max(1, Number(args.concurrency || 3));
const FORCE = !!args.force; const DRY = !!args.dry;
const KEY = (process.env.DEEPSEEK_API_KEY || '').trim();
const URL = args.url || 'https://api.deepseek.com/chat/completions';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const P = {
 "analyze": "당신은 K-Law AI 판결 분석 시스템입니다.\n사용자가 제출한 사건의 개요를 분석하여 아래 형식으로 정확히 응답하세요.\n\n【심급】1심 / 2심 / 3심 / 헌법재판 중 하나\n【사건분류】민사(본안) / 형사 / 행정 / 가사 / 소액사건 / 노동 중 하나\n【사건종류_상세】사건의 구체적 유형\n【사건명】실제 법원 사건명처럼 핵심 청구를 담은 짧은 한 문구 (예: \"건축인허가 처분 취소 청구\", \"OO시청과 건설사 간 계약 이행 분쟁\"). 날짜·당사자 상세 정보 없이 15자 내외로.\n【사건의 개요】입력된 내용을 바탕으로 명확하게 정리\n【원고의 주장】원고(신청인) 측 주장 정리 (없으면 \"정보 부족\"으로 표기)\n【피고의 주장】피고(상대방) 측 주장 정리 (없으면 \"정보 부족\"으로 표기)\n【다툼이 없는 사실】양측이 동의하는 사실관계 (없으면 \"추가 확인 필요\"로 표기)\n【다툼의 요지】핵심 법적 쟁점 2~3가지\n【추가질문】판결 시뮬레이션에 필요한 정보가 부족한 경우 구체적인 질문 1~3개. 충분하면 \"없음\".\n\n응답은 반드시 위 형식만 사용하세요.",
 "sim": "당신은 K-Law 판결 방법론 {{VER}}을 적용하는 대한민국 법원 판결 AI입니다.\n{{BODY}}위 가상판결 출력형식 v13.3을 반드시 준수하여 판결문을 작성하세요.\n사건번호·심급 등 이번 사건의 구체적인 정보는 이어지는 사용자 메시지에서 확인하세요.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n본 시뮬레이션은 법률 정보 제공 목적이며 법률 자문이 아닙니다.\n가상판결 출력형식 v13.3 | K-Law {{VER}} 적용\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
 "steps": {
  "step0": {
   "maxTokens": 9000,
   "prompt": "{{CTX}}\n\nK-Law 판결 방법론의 STEP 0만 작성하세요.\n[0-α 직관] [0-β 격리] [명제] [STEP-0-COMPLETE] 포함."
  },
  "stepA": {
   "maxTokens": 14000,
   "prompt": "{{CTX}}\n\nSTEP 0이 완료되었습니다. STEP A만 작성하세요.\nA-0~A-5 소항목과 각 완료 태그 포함. 허위 판례 번호 인용 금지."
  },
  "stepB": {
   "maxTokens": 16000,
   "prompt": "{{CTX}}\n\nSTEP A가 완료되었습니다. STEP B만 작성하세요.\nB-1~B-7 소항목, 주문+이유 완성, [STEP-B-COMPLETE] 포함."
  },
  "stepC": {
   "maxTokens": 9000,
   "prompt": "{{CTX}}\n\nSTEP B가 완료되었습니다. STEP C를 작성하고 아래 형식으로 마무리하세요.\n[법리 확신도: X/10] [사실 확신도: Y/10] [종합 확신도: Z/10]\n[사건 복잡도: X/10] [K-Law 대법원 판결 일치도 예상: XX%]\n[결론 유형: 확정적/조건부/판단유보]\n판결 요약: [핵심 2~3문장]\n[STEP-C-COMPLETE]"
  }
 }
};

// ── 채점 규칙(label_civil.ps1과 같은 규칙) ─────────────
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
  // 라벨: 줄 첫머리의 "주 문:", "【주 문】", "이 유:" 등. 본문이 '이유'로 시작하는 문장은 걸리지 않도록 구분자를 요구한다.
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
// ── 자기 검증: STEP B 결과의 결정론적 점검(lint) + STEP V 프롬프트 ──────────
const lastMatch = (t, re) => { let m; let last = null; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = g.exec(t))) last = m; return last ? last[1] : null; };
function lintB(bText, predBinary, overview) {
  if (predBinary !== '파기') return [];          // 이번 점검은 '파기' 결론의 과잉 여부를 겨냥한다
  const out = [];
  const conf = Number(lastMatch(bText, /종합\s*확신도[^\d\n]{0,14}([\d.]+)\s*\/\s*10/g));
  const confKnown = Number.isFinite(conf) && conf > 0;
  if (confKnown && conf <= 5) out.push(`V-1: 종합 확신도 ${conf}/10 이하인데 결론이 파기`);
  if (confKnown && conf < 7 && /방향\s*일치\s*여부[:：]\s*\**\s*불일치/.test(bText)) out.push(`V-1: 원심과 반대 결론인데 종합 확신도 ${conf}/10 (7 미만)`);
  if (/법리\s*오해\s*(가\s*)?(없|인정되지)/.test(bText)) out.push('V-4: 법리오해가 없다고 판정하고도 파기');
  const ovSection = (overview.split('【원심의 판단 요지】')[1] || '');
  if (/판단\s*누락|심리\s*미진/.test(bText) && !/판단하지\s*(아니|않)|심리하지\s*(아니|않)|누락/.test(ovSection)) out.push('V-2: 판단누락·심리미진을 근거로 파기했으나 입력의 원심 요지에는 그런 진술이 없음');
  if (/\[B-6-π:\s*발동\]/.test(bText)) out.push('V-5: 복수 시나리오(B-6-π)가 발동했는데 결론은 파기 하나로 확정');
  if (/배척\s*이유[\s\S]{0,700}?(명시적\s*(판단|설시)[^\n]{0,24}없|입력[^\n]{0,16}없)/.test(bText)) out.push('V-3: 반전 논거를 "명시된 판단이 없다/입력에 없다"는 이유로 배척');
  return out;
}
const STEPV = {
  maxTokens: 14000,
  prompt: (ctx, lint) => `${ctx}\n\nSTEP B가 완료되었습니다. STEP V(자기 검증·재검토 게이트)만 작성하세요.\n자동 점검에서 다음 항목이 발동했습니다. 각 항목은 반드시 '해당'으로 다루고 근거 문장을 인용하세요:\n${lint.map((x) => '- ' + x).join('\n')}\nV-1~V-6 각 항목에 해당/비해당과 근거 문장 인용을 쓰고, 해당 항목이 하나라도 있으면 [V-재판단]을 수행하세요. 마지막 줄은 '최종 주문: (변경 없음 | 주문 문장)'으로 쓰고 [STEP-V-COMPLETE | 점검 6항목 | 해당 N개 | 결론: 유지/변경] 태그로 마무리하세요.`,
};
if (args.selftest) {
  const BT = '| 종합 확신도 | **5/10** |\n방향 일치 여부: **불일치**\n[법리오해 인정 여부] 정당 (법리오해 없음). 판단누락으로 파기사유 인정.\n[B-6-π: 발동]\n> 배척 이유 — 원심 판결문에는 이에 관한 명시적 판단이 없다.';
  console.log('lint(파기):', lintB(BT, '파기', '【원심의 판단 요지】 원심은 원고 청구를 일부 인용하였다.'));
  console.log('lint(유지):', lintB(BT, '유지', ''));
  const B = '[B-5-A]\n주문: 원심판결을 유지한다\n핵심 법리: ...\n[B-7 최종 판결문]\n주 문:\n상고를 기각한다.\n상고비용은 원고가 부담한다.\n\n이 유:\n이유 본문은 다음과 같다.'; console.log('추가 검사:', JSON.stringify(extractOrder('【주 문】\n원심판결을 파기하고, 사건을 수원고등법원에 환송한다.\n\n【이 유】\n이유 없음')));
  const o = extractOrder(B); console.log('주문 =', JSON.stringify(o), '=>', classify(o));
  console.log(classify('원심판결을 파기하고, 사건을 서울고등법원에 환송한다.'), classify('원심판결 중 피고 패소 부분을 파기하고, 이 부분 사건을 서울고등법원에 환송한다.'), classify('원고의 청구를 기각한다'));
  console.log(P.sim.length, Object.keys(P.steps)); process.exit(0);
}
if (!KEY && !DRY && !args['lint-only']) { console.error('DEEPSEEK_API_KEY 환경변수가 없습니다.'); process.exit(1); }
if (KEY && !/^[\x21-\x7E]+$/.test(KEY)) { console.error(`DEEPSEEK_API_KEY에 공백·한글 등 허용되지 않는 문자가 섞여 있습니다(길이 ${KEY.length}). 키만 정확히 복사해 다시 설정하세요. 예: $m = [regex]::Match((Get-Clipboard -Raw), 'sk-ant-[A-Za-z0-9_\\-]+'); $env:DEEPSEEK_API_KEY = $m.Value`); process.exit(1); }

// ── 입력 ─────────────────────────────────────────────
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
const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };
const readCsv = (p) => parseCsv(readText(p));
const methodText = readText(METHOD); const formatText = readText(FORMAT);
const SC_MODE = String(args['self-check'] || 'auto');
const SELFCHECK = SC_MODE === 'on' || (SC_MODE !== 'off' && methodText.includes('STEP V – 자기 검증'));
const SYSTEM = P.sim.replace('{{BODY}}', () => '[K-Law 방법론 원문]\n' + methodText + '\n\n---\n\n' + '[가상판결 출력형식 v13.3]\n' + formatText + '\n\n---\n\n').replace(/\{\{VER\}\}/g, () => VERSION);
// 주의: 운영 코드는 methodBody + formatBody 뒤에 곧바로 "위 가상판결 출력형식…" 문장을 잇는다(P.sim이 그 구조를 그대로 담고 있다).

const dev = readCsv(DEV).filter((r) => (ROUND ? Number(r.round) === ROUND : true));
dev.forEach((r, i) => { r.seq = i + 1; });
fs.mkdirSync(OUT, { recursive: true });

// ── API (스트리밍) ───────────────────────────────────
async function chat(messages, maxTokens, thinking) {
  const opt = { temperature: TEMP, thinking: true };
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model: MODEL, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    if (opt.temperature !== null) body.temperature = opt.temperature;
    if (opt.thinking) { body.thinking = { type: thinking ? 'enabled' : 'disabled' }; if (thinking) body.reasoning_effort = EFFORT; }
    let r;
    try { r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_200_000) }); }
    catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 400 && opt.temperature !== null && /temperature/i.test(txt)) { opt.temperature = null; attempt--; continue; }
      if (r.status === 400 && opt.thinking && /thinking|reasoning_effort/i.test(txt)) { opt.thinking = false; console.error('참고: thinking 관련 필드를 받지 않아 생략합니다(기본 추론 모드).'); attempt--; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
      throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder('utf-8');
    let buf = ''; let content = ''; let reasoningChars = 0; let usage = null; let finish = null; let model = null;
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
          model = j.model || model;
          const ch = j.choices?.[0];
          if (ch) { const dl = ch.delta || {}; if (dl.content) content += dl.content; if (dl.reasoning_content) reasoningChars += dl.reasoning_content.length; if (ch.finish_reason) finish = ch.finish_reason; }
          if (j.usage) usage = j.usage;
        }
      }
    } catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    return { content, usage, finish, model, reasoningChars };
  }
  throw new Error('API 재시도 초과');
}
const tag = (t, name) => { const m = t.match(new RegExp(`【${name}】\\s*([\\s\\S]*?)(?=\\n【|$)`)); return m ? m[1].trim() : ''; };
const usageRow = (step, r) => ({ step, prompt: r.usage?.prompt_tokens ?? null, completion: r.usage?.completion_tokens ?? null,
  cache_hit: r.usage?.prompt_cache_hit_tokens ?? null, cache_miss: r.usage?.prompt_cache_miss_tokens ?? null,
  reasoning: r.usage?.completion_tokens_details?.reasoning_tokens ?? null, finish: r.finish, model: r.model });

// ── 한 사건 실행 ─────────────────────────────────────
async function runCase(row) {
  const jsonPath = path.join(OUT, `${row.id}.json`);
  if (!FORCE && fs.existsSync(jsonPath)) return JSON.parse(readText(jsonPath));
  const ovPath = path.join(OVDIR, `${row.id}.json`);
  if (!fs.existsSync(ovPath)) throw new Error(`개요 없음: ${ovPath}`);
  const overview = JSON.parse(readText(ovPath)).overview_review;
  const caseNo = `SIM-2026-${String(row.seq).padStart(4, '0')}`;
  const t0 = Date.now(); const usages = [];

  // 1) 분석 단계 (운영: system=KLAW_ANALYZE_PROMPT, user='사건의 개요:\n'+입력)
  const aMsgs = [{ role: 'system', content: P.analyze }, { role: 'user', content: '사건의 개요:\n' + overview }];
  let a = await chat(aMsgs, 4000, false); usages.push(usageRow('analysis', a));
  const empty = (t) => !(tag(t, '사건의 개요') || tag(t, '원고의 주장') || tag(t, '피고의 주장'));
  if (empty(a.content)) { a = await chat(aMsgs, 14000, true); usages.push(usageRow('analysis-retry', a)); }
  const analysis = a.content;
  const lv = tag(analysis, '심급').match(/1심|2심|3심|헌법재판/); const level = lv ? lv[0] : '3심';
  const extraQ = tag(analysis, '추가질문');
  const baseCtx = '사용자: ' + aMsgs[1].content + '\n\nK-Law: ' + analysis;

  // 2) STEP 0 → A → B → C
  const parts = {}; const truncated = []; const sc = { enabled: SELFCHECK, triggers: [], ran: false };
  for (const sid of ['step0', 'stepA', 'stepB', 'stepC']) {
    const prev = Object.values(parts).join('\n\n');
    const ctx = `[사건번호: ${caseNo} | 심급: ${level}]\n\n` + (prev ? `[이전 STEP 출력]\n${prev}\n\n[사건 정보]\n${baseCtx}` : `[사건 정보]\n${baseCtx}`);
    const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: P.steps[sid].prompt.replace('{{CTX}}', () => ctx) }];
    const budget = Math.round(P.steps[sid].maxTokens * SCALE);
    let r = await chat(msgs, budget, THINK); usages.push(usageRow(sid, r));
    if (!r.content.trim()) { r = await chat(msgs, budget + 6000, THINK); usages.push(usageRow(sid + '-retry-empty', r)); }
    if (r.finish === 'length') {
      const r2 = await chat(msgs, Math.round(budget * 1.5), THINK); usages.push(usageRow(sid + '-retry-length', r2));
      if (r2.content.trim() && (r2.finish !== 'length' || r2.content.length > r.content.length)) r = r2;
    }
    if (r.finish === 'length') truncated.push(sid);
    parts[sid] = r.content;
    if (sid === 'stepB' && SELFCHECK) {
      const bOrder = extractOrder(r.content); const [bLabel, bBinary] = classify(bOrder);
      sc.order_before = bOrder; sc.label_before = bLabel; sc.binary_before = bBinary;
      sc.triggers = lintB(r.content, bBinary, overview);
      if (sc.triggers.length) {
        const ctxV = `[사건번호: ${caseNo} | 심급: ${level}]\n\n[이전 STEP 출력]\n${Object.values(parts).join('\n\n')}\n\n[사건 정보]\n${baseCtx}`;
        const msgsV = [{ role: 'system', content: SYSTEM }, { role: 'user', content: STEPV.prompt(ctxV, sc.triggers) }];
        const budgetV = Math.round(STEPV.maxTokens * SCALE);
        let rv = await chat(msgsV, budgetV, THINK); usages.push(usageRow('stepV', rv));
        if (!rv.content.trim()) { rv = await chat(msgsV, budgetV + 6000, THINK); usages.push(usageRow('stepV-retry-empty', rv)); }
        if (rv.finish === 'length') { const rv2 = await chat(msgsV, Math.round(budgetV * 1.5), THINK); usages.push(usageRow('stepV-retry-length', rv2)); if (rv2.content.trim()) rv = rv2; }
        if (rv.finish === 'length') truncated.push('stepV');
        parts.stepV = rv.content; sc.ran = true;
        const fin = lastMatch(rv.content, /최종\s*주문\s*[:：]\s*[`*]*([^\n`]+)/g);
        if (fin && !/변경\s*없음/.test(fin)) sc.order_after = fin.replace(/\*+/g, '').trim();
      }
    }
  }
  const full = Object.values(parts).join('\n\n');

  // 3) 결론 추출·채점
  const declined = /【판단\s*불가\s*선언】/.test(full);
  let orderText = extractOrder(parts.stepB || full);
  if (sc.order_after) orderText = sc.order_after;
  const [predLabel, predBinary] = declined ? ['판단불가', '유보'] : classify(orderText);
  sc.binary_after = predBinary; sc.changed = !!(sc.ran && sc.binary_before && sc.binary_before !== predBinary);
  const confC = Number(lastMatch(parts.stepC || '', /종합\s*확신도[^\d\n]{0,14}([\d.]+)\s*\/\s*10/g)); const pctC = Number(lastMatch(full, /일치도\s*예상[^\d\n]{0,10}([\d.]+)\s*%/g));
  sc.display = { confidence: Number.isFinite(confC) ? confC : null, match_pct: Number.isFinite(pctC) ? pctC : null };
  sc.display.mismatch = !!(sc.display.confidence && sc.display.match_pct && sc.display.match_pct > sc.display.confidence * 10 + 15);
  const concl = (parts.stepC.match(/\[결론\s*유형:\s*([^\]]+)\]/) || [])[1]?.trim() || '';
  const hit = usages.reduce((s, u) => s + (u.cache_hit || 0), 0); const miss = usages.reduce((s, u) => s + (u.cache_miss || 0), 0);
  const rec = {
    id: row.id, round: Number(row.round), seq: row.seq, caseNo_sim: caseNo, level,
    actual: { label: row.label, binary: row.binary }, predicted: { label: predLabel, binary: predBinary, order: orderText, conclusion_type: concl, declined },
    correct: predBinary === row.binary, correct_before_sc: sc.binary_before ? sc.binary_before === row.binary : null, self_check: sc, extraQ_present: !!extraQ && extraQ !== '없음',
    truncated_steps: truncated,
    config: { budget_scale: SCALE, model: MODEL, version: VERSION, method: METHOD, format: FORMAT, thinking: THINK, effort: THINK ? EFFORT : null, temperature: TEMP },
    usage: usages, cache_hit_ratio: hit + miss ? hit / (hit + miss) : null, elapsed_s: Math.round((Date.now() - t0) / 1000),
    analysis, parts,
  };
  fs.writeFileSync(jsonPath, JSON.stringify(rec, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${row.id}.txt`), `[분석]\n${analysis}\n\n${full}`, 'utf8');
  return rec;
}

// ── 실행과 보고 ──────────────────────────────────────
const allJobs = dev.slice(0, LIMIT);
const isDone = (r) => !FORCE && fs.existsSync(path.join(OUT, `${r.id}.json`));
const jobs = allJobs.filter((r) => !isDone(r));
const TOTAL = jobs.length;
const fmtT = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s % 60}초` : `${s}초`; };
let finished = 0; const tStart = Date.now();
const progress = () => { finished++; const el = Date.now() - tStart; return `[${finished}/${TOTAL}] 경과 ${fmtT(el)}, 남은 시간 약 ${fmtT((el / finished) * (TOTAL - finished))} |`; };
if (args['lint-only']) {   // API 호출 없이, 이미 만든 결과(runs/<tag>)에 자기 검증 점검 규칙만 적용해 본다
  console.log('사건 | 실제 | STEP B 예측 | 점검 발동');
  for (const row of dev) {
    const jp = path.join(OUT, `${row.id}.json`); if (!fs.existsSync(jp)) continue;
    const rec = JSON.parse(readText(jp)); const bText = rec.parts?.stepB || '';
    const op = path.join(OVDIR, `${row.id}.json`); const ov = fs.existsSync(op) ? JSON.parse(readText(op)).overview_review : '';
    const [, bin] = classify(extractOrder(bText)); const tr = lintB(bText, bin, ov);
    console.log(`${row.id} | ${row.binary} | ${bin} | ${tr.length}건 ${tr.map((x) => x.split(':')[0]).join(',')}`);
  }
  process.exit(0);
}
if (DRY) {
  console.log(`system 프롬프트 ${SYSTEM.length.toLocaleString()}자 | 버전 ${VERSION} | 모델 ${MODEL} | thinking ${THINK ? 'enabled/' + EFFORT : 'disabled'} | 대상 ${jobs.length}건`);
  for (const r of jobs.slice(0, 3)) { const p = path.join(OVDIR, `${r.id}.json`); console.log(`[dry] ${r.id} round=${r.round} 개요 ${fs.existsSync(p) ? JSON.parse(readText(p)).overview_review.length + '자' : '없음'}`); }
  process.exit(0);
}
const results = []; let failed = 0; const queue = [...jobs];
for (const r of allJobs.filter(isDone)) results.push(JSON.parse(readText(path.join(OUT, `${r.id}.json`))));
console.log(`대상 ${allJobs.length}건 중 이미 완료된 ${allJobs.length - jobs.length}건은 건너뛰고 ${TOTAL}건을 실행합니다(동시 ${CONC}건). 사건당 수 분이 걸릴 수 있습니다.`);
await Promise.all(Array.from({ length: CONC }, async () => {
  while (queue.length) {
    const row = queue.shift();
    try {
      const rec = await runCase(row); results.push(rec);
      console.log(`${progress()} ${rec.correct ? '일치  ' : '불일치'} ${row.id} 실제 ${rec.actual.label}(${rec.actual.binary}) / 예측 ${rec.predicted.label}(${rec.predicted.binary}) | 결론유형 ${rec.predicted.conclusion_type || '-'} | ${rec.elapsed_s}s | 캐시 ${rec.cache_hit_ratio === null ? '-' : Math.round(100 * rec.cache_hit_ratio) + '%'}`);
    } catch (e) { failed++; console.error(`${progress()} 실패 ${row.id}: ${e.message}`); }
  }
}));

const n = results.length; const ok = results.filter((r) => r.correct).length;
const of = (b) => results.filter((r) => r.actual.binary === b);
const line = (name, arr) => `  ${name}: ${arr.filter((r) => r.correct).length}/${arr.length}`;
console.log(`\n[${TAG}] 완료 ${n}건 (실패 ${failed}) | 결론 일치 ${ok}/${n}${n ? ` (${(100 * ok / n).toFixed(0)}%)` : ''}`);
console.log(line('실제 유지(기각) 적중', of('유지')) + '\n' + line('실제 파기 적중', of('파기')));
const scRan = results.filter((r) => r.self_check?.ran);
if (SELFCHECK) {
  const fixed = scRan.filter((r) => r.self_check.changed && !r.correct_before_sc && r.correct).length; const broke = scRan.filter((r) => r.self_check.changed && r.correct_before_sc && !r.correct).length;
  console.log(`  자기 검증: 발동 ${scRan.length}건 | 결론 변경 ${scRan.filter((r) => r.self_check.changed).length}건 (오답→정답 ${fixed}, 정답→오답 ${broke}) | 점검 전 결론 기준 일치 ${results.filter((r) => (r.correct_before_sc ?? r.correct)).length}/${n} → 점검 후 ${ok}/${n}`);
}
const dm = results.filter((r) => r.self_check?.display?.mismatch);
console.log(`  표시 수치(일치도 예상)가 종합 확신도×10%를 15%p 넘게 초과한 사건 ${dm.length}건${dm.length ? ': ' + dm.map((r) => r.id).join(', ') : ''}`);
const cut = results.filter((r) => (r.truncated_steps || []).length);
const retriesLen = results.reduce((n, r) => n + r.usage.filter((u) => String(u.step).includes('retry-length')).length, 0);
console.log(`  토큰 예산 배율 ${SCALE} | 그래도 잘린 사건 ${cut.length}건${cut.length ? ': ' + cut.map((r) => r.id + '(' + r.truncated_steps.join('+') + ')').join(', ') : ''} | 길이 재시도 ${retriesLen}회`);
const unclear = results.filter((r) => ['유보', '확인필요'].includes(r.predicted.binary));
if (unclear.length) console.log(`  판단 불가·확인필요(오답 처리): ${unclear.map((r) => r.id).join(', ')}`);
const hit = results.reduce((s, r) => s + r.usage.reduce((x, u) => x + (u.cache_hit || 0), 0), 0);
const miss = results.reduce((s, r) => s + r.usage.reduce((x, u) => x + (u.cache_miss || 0), 0), 0);
console.log(`  캐시 적중 토큰 ${hit.toLocaleString()} / 미적중 ${miss.toLocaleString()}${hit + miss ? ` (적중률 ${(100 * hit / (hit + miss)).toFixed(0)}%)` : ''}`);
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const H = ['id', 'round', 'actual_label', 'actual_binary', 'pred_label', 'pred_binary', 'correct', 'conclusion_type', 'truncated_steps', 'sc_triggers', 'sc_changed', 'binary_before_sc', 'display_mismatch', 'order', 'elapsed_s', 'cache_hit_ratio'];
fs.writeFileSync(path.join(OUT, 'results.csv'), '\uFEFF' + [H.join(','), ...results.map((r) => [r.id, r.round, r.actual.label, r.actual.binary, r.predicted.label, r.predicted.binary, r.correct, r.predicted.conclusion_type, (r.truncated_steps || []).join('+'), (r.self_check?.triggers || []).join(' | '), r.self_check?.changed ?? '', r.self_check?.binary_before ?? '', r.self_check?.display?.mismatch ?? '', r.predicted.order.slice(0, 200), r.elapsed_s, r.cache_hit_ratio].map(q).join(','))].join('\r\n'), 'utf8');
console.log(`  저장: ${OUT}${path.sep}results.csv (+ 사건별 .json/.txt)`);
