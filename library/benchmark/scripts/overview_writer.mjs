// overview_writer.mjs — 대법원 판결문(+2심·1심)에서 사건 개요를 작성한다 (Node 18+).
// --provider=anthropic(기본, Claude Sonnet 5) | deepseek(비용 절감용 대체 경로)
// 2026-09-25 — Anthropic 콘솔 크레딧이 반복적으로 소진되어, 결손분 개요를 DeepSeek로도 작성할 수 있게 했다.
//   이 DeepSeek 계정은 가상 판결 생성(klaw_runner.mjs)에 쓰는 계정과 별개다. 같은 모델 계열(DeepSeek)이
//   개요 작성과 가상 판결 예측을 모두 맡게 되므로, 두 세션 사이에 실시간 정보 공유는 없지만(별도 API 세션·
//   별도 계정) 공급자가 API 로그를 향후 모델 재학습에 쓸 경우에 한해 장기적 오염 가능성이 이론상 남는다 —
//   그 지연은 모델 재학습 주기 단위로, 상당히 길 것으로 본다. 이 한계를 README·논문 초안에 명시했고,
//   각 개요 파일의 generator 필드에 작성 모델과 계정 구분을 기록해 사후에 어떤 개요가 어느 경로로
//   작성됐는지 추적할 수 있게 했다.
// 사용: node overview_writer.mjs [--dev=split/dev.csv] [--chain=chain.csv] [--out=overview]
//        [--provider=anthropic|deepseek] [--model=...] [--round=1] [--ids=id1,id2] [--limit=N] [--concurrency=2] [--force] [--dry] [--show]
// 환경변수: ANTHROPIC_API_KEY (provider=anthropic) 또는 DEEPSEEK_OVERVIEW_API_KEY (provider=deepseek). 채팅에 붙여 넣지 말 것
// 이 개요는 실명·상호·지명·정확한 날짜 등 식별정보를 일반화한다(유추 근거 제거). 완전한 익명화는 보장하지 않는다.
// 출력: overview/<판례일련번호>.json  (전체 기록: 두 개요, 검사 결과, 수정 횟수, 토큰 사용량)
//       overview_txt/review/<id>.txt, overview_txt/independent/<id>.txt  (개요 본문만, 사건별 별도 파일)
//       dev100/rNN/<id>/overview_review.txt, overview_independent.txt  (사건 묶음 폴더가 있으면 함께 저장)
//       overview/index.csv  (사건별 요약표)
// --export-only : API 호출 없이 이미 만든 JSON에서 txt 파일과 index.csv만 다시 만든다.
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const DEV = args.dev || 'split/dev.csv';
const CHAIN = args.chain || 'chain.csv';
const OUT = args.out || 'overview';
const PROVIDER = (args.provider || 'anthropic').toLowerCase();
if (!['anthropic', 'deepseek'].includes(PROVIDER)) { console.error(`알 수 없는 --provider: ${PROVIDER} (anthropic 또는 deepseek)`); process.exit(1); }
const MODEL = args.model || (PROVIDER === 'deepseek' ? 'deepseek-flash' : 'claude-sonnet-5');
// DeepSeek(deepseek-flash)은 thinking 모드에서 추론 토큰이 사건마다 크게 변동한다(klaw_runner.mjs에서도 관찰됨).
// 예산이 모자라면 추론만 하다 실제 답변(JSON)을 한 글자도 못 쓰고 끝날 수 있어, 기본값을 넉넉히 잡는다.
const DS_MAXTOK = Number(args['ds-max-tokens'] || 32000);
const ROUND = args.round ? Number(args.round) : null;
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const CONC = Math.max(1, Number(args.concurrency || 2));
const FORCE = !!args.force;
const DRY = !!args.dry;
const EXPORT_ONLY = !!args['export-only'];
const SHOW = !!args.show;
const API_URL = args.url || (PROVIDER === 'deepseek' ? 'https://api.deepseek.com/chat/completions' : 'https://api.anthropic.com/v1/messages');
const KEY_ENV = PROVIDER === 'deepseek' ? 'DEEPSEEK_OVERVIEW_API_KEY' : 'ANTHROPIC_API_KEY';
const KEY = (process.env[KEY_ENV] || '').trim();
if (!KEY && !DRY && !EXPORT_ONLY) { console.error(`${KEY_ENV} 환경변수가 없습니다.`); process.exit(1); }
if (KEY && !/^[\x21-\x7E]+$/.test(KEY)) { const ex = PROVIDER === 'deepseek' ? "sk-[A-Za-z0-9]+" : "sk-ant-[A-Za-z0-9_\\-]+"; console.error(`${KEY_ENV}에 공백·한글 등 허용되지 않는 문자가 섞여 있습니다(길이 ${KEY.length}). 키만 정확히 복사해 다시 설정하세요. 예: $m = [regex]::Match((Get-Clipboard -Raw), '${ex}'); $env:${KEY_ENV} = $m.Value`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 입력 읽기 ────────────────────────────────────────
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const rows = []; let row = []; let f = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f.length || row.length) { row.push(f.replace(/\r$/, '')); rows.push(row); }
  const clean = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  const [h, ...b] = clean;
  return b.map((r) => Object.fromEntries(h.map((k, i) => [k, r[i] ?? ''])));
}
const readCsv = (p) => parseCsv(fs.readFileSync(p, 'utf8'));
function readJson(p) {
  let t = fs.readFileSync(p, 'utf8');
  if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
  return JSON.parse(t);
}
const tidy = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/[ \t\u00A0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
const MAXCH = 70000;
function bodyText(p) {
  if (!p || !fs.existsSync(p)) return null;
  const j = readJson(p);
  let t = tidy(j.PrecService?.['판례내용']);
  if (t.length > MAXCH) t = t.slice(0, MAXCH) + '\n(이하 분량 제한으로 생략)';
  return t;
}

// ── 프롬프트 ─────────────────────────────────────────
const SYSTEM = `당신은 법원 판결문에서 '사건 개요'를 만드는 편집자입니다.

[목적]
이 개요는 다른 AI 모델이 개요만 읽고 대법원의 결론을 예측하는 시험에 쓰입니다. 개요에 결론이나 그 힌트가 조금이라도 들어 있으면 시험이 무효가 됩니다. 반대로 사실관계와 당사자의 주장이 부실하면 예측이 불가능해 시험이 무의미합니다. 두 가지를 모두 지켜 주세요.

[입력]
사용자 메시지에 대법원 판결문 전문이 있고, 있으면 2심(원심) 판결문과 1심 판결문이 함께 들어 있습니다.

[출력]
아래 JSON 객체 하나만 출력하십시오. 설명, 마크다운, 코드펜스는 쓰지 않습니다.
{"overview_review": "...", "overview_independent": "...", "self_check": {"removed": ["제거한 결론 암시 표현의 유형"], "generalized": ["일반화한 식별정보의 유형"], "uncertain": ["결론 힌트이거나 사건을 알아볼 단서일 수 있어 판단이 어려웠던 부분"]}}

[overview_review 작성 규칙 — 상고심 검토용]
다음 소제목 구조로 씁니다: 【당사자】 【사건의 경위】 【청구와 주장】 【원심의 판단 요지】
- 【당사자】: 원고/피고(반소가 있으면 원고(반소피고)/피고(반소원고)), 각자의 지위와 관계. 상고한 쪽을 명시합니다. 판결문의 익명 표기는 그대로 둡니다.
- 【사건의 경위】: 시간 순서로, 계약 내용·금액·기간·행위·처분 등 결론에 필요한 사실을 빠짐없이 씁니다. 판결문이 사실로 인정했거나 다툼 없는 사실로 서술한 것만 씁니다. 날짜는 필요할 때 연·월 수준으로만 씁니다.
- 【청구와 주장】: 원고의 청구취지와 청구원인, 피고의 답변과 항변, 반소, 1심과 2심에서 당사자가 다툰 쟁점. 하급심 판결문이 있으면 그 판결문의 청구취지·항소취지·당사자 주장에서 가져와 상세히 씁니다.
- 【원심의 판단 요지】: 상고심 직전 심급(원심)의 결론과 핵심 논거를 3~5줄로 씁니다. 결론은 원고 청구의 전부 인용, 일부 인용, 기각, 각하 중 무엇인지 분명히 씁니다.

[overview_independent 작성 규칙 — 독립 예측용]
【당사자】 【사건의 경위】 【청구와 주장】만 씁니다. 1심·2심·대법원의 판단과 결론은 어느 것도 쓰지 않으며, 몇 심까지 갔는지와 누가 항소·상고했는지도 쓰지 않습니다. 당사자의 지위(원고/피고)와 청구, 주장만 씁니다.

[두 개요 모두에 적용되는 금지 사항]
1. 대법원의 판단, 결론, 주문, 판시사항, 판결요지, 대법원이 제시한 법리 설시. "파기", "환송", "상고 기각·인용·각하", "정당하다", "잘못이 있다", "법리를 오해" 같은 평가와 결과 표현.
2. 상고이유의 내용. 대법원이 어떤 상고이유를 다루었는지가 결과의 힌트가 될 수 있으므로 쓰지 않습니다. 쟁점은 하급심 판결문에서 당사자가 다툰 것으로만 씁니다.
3. 사건번호, 선고일, 재판부, 법원명(원심과 1심의 법원 포함), 대법관.
4. 법령은 당사자가 근거로 든 조문명 수준까지만 쓰고, 그 조문의 해석 결론은 쓰지 않습니다.
5. 환송 후 재상고 사건은 검토용 개요에만 "이전에 대법원에서 환송된 사건"이라고 한 줄만 쓰고, 환송판결의 이유는 쓰지 않습니다.
6. 판결문에 없는 사실을 추가하지 않습니다. 추측하지 않습니다.
7. 결론을 유도하는 강조나 순서 배치를 피합니다. 양쪽 주장을 같은 비중과 어조로 씁니다.

[식별정보 제거 규칙 — 실제 사건을 알아볼 단서를 없앱니다]
- 개인 이름, 회사·단체·학교·병원 등의 상호, 상표·제품명·프로젝트명은 모두 일반화한 표기로 바꿉니다. 당사자는 원고/피고, 제3자는 "소외 갑", "소외 을"처럼, 회사는 "A 회사", "B 회사"처럼 씁니다. 판결문의 ○○○ 같은 익명 표기도 이 방식으로 통일합니다.
- 국가기관·지방자치단체·공공기관은 법령상 지위가 쟁점일 때만 그 유형(예: "광역지방자치단체", "건강보험 관리 공단")으로 씁니다. 고유한 기관 명칭은 쓰지 않습니다.
- 주소, 지번, 건물명, 지명은 일반화합니다(예: "수도권 소재 아파트"). 관할이나 소재지가 법적으로 쟁점이면 그 성격만 씁니다.
- 날짜는 연도까지만 쓰고(법령 시제 판단에 필요) 월·일은 쓰지 않습니다. 기간 계산이 필요하면 "계약 체결 2년 3개월 뒤"처럼 간격으로 씁니다.
- 금액, 면적, 수량, 비율 등 법적 판단에 필요한 수치는 그대로 씁니다. 임의로 바꾸지 않습니다.
- 변호사, 법무법인, 재판부, 소송대리인의 이름과 소속은 쓰지 않습니다.
- 계약서·문서의 고유한 제목이나 번호, 차량·계좌·등기 번호도 쓰지 않습니다.
- 언론이 붙인 별칭이나 사건 명칭처럼 사건 자체를 알아볼 수 있는 특징도 일반화합니다.
- 이 사건과 관련된 다른 수사·재판(형사사건 등)의 배경은 이 사건의 법적 판단에 필요한 만큼만 쓰고, 사건의 종류·금품의 성격·사회적 파장처럼 유명한 사건이나 인물·단체를 떠올리게 하는 묘사는 "수사 중이던 형사사건"처럼 일반화합니다.
- 당사자의 직업·직함·경력은 법적 쟁점이 아니면 "전문직 종사자", "회사 임원"처럼 일반 표현으로 씁니다.
- 외국의 지명·기관(주, 카운티, 도시, 공관 등)은 쟁점이 되는 제도의 성격(예: "미국 주법원", "재외공관")만 남기고 구체 명칭은 쓰지 않습니다.
- 월·일은 어떤 형태로도 쓰지 않습니다("2022년 9월", "10월과 11월", "당일 오전"의 날짜 표시 포함). 연도 이후의 시간 관계는 "같은 해", "그 1개월 뒤", "이듬해"처럼 상대적으로 씁니다.
- 공항·항만·도시·건물 등 구체적 장소명은 쓰지 않습니다("공항"은 "출국 지점"처럼 일반화).
- 언론 보도, 사회적 관심, 사건이 알려진 정도, 사건이 벌어진 연도 범위처럼 사건을 알아볼 수 있는 서술은 쓰지 않습니다(보도 자체가 쟁점인 사건은 제외).
- 분량을 채우려고 식별 가능한 세부 묘사를 더 가져오지 마세요. 분량보다 익명성이 우선합니다.

[분량]
각 개요는 한국어 약 1,800~2,300자, 최대 2,500자입니다. 사실관계를 충분히 쓰되 판단은 넣지 않습니다.

[판단 기준]
어떤 문장이 결론 힌트인지 애매하면 넣지 말고 self_check.uncertain에 적으세요.`;

function userMessage(sup, sec, fst) {
  return `# 대법원 판결문 (전문)\n${sup}\n\n# 2심(원심) 판결문\n${sec ?? '(없음)'}\n\n# 1심 판결문\n${fst ?? '(없음)'}`;
}

// ── 1단계 누출 검사(키워드·정규식). 걸리면 사람이 확인한다 ──
const LEAK = [
  [/파기/, '파기'], [/환송/, '환송'], [/상고(를|가|은|이)?\s*(기각|각하|인용|받아들)/, '상고 결과 표현'],
  [/상고\s*이유/, '상고이유'], [/이유\s*(가\s*)?(있|없)/, '이유 있다/없다'], [/정당하/, '정당하다'],
  [/법리(를)?\s*오해/, '법리 오해'], [/대법원/, '대법원'], [/판시/, '판시'], [/주문/, '주문'], [/대법관/, '대법관'],
  [/\d{4}(?!년)[가-힣]{1,3}\d{3,}/, '사건번호 형식'], [/(고등|지방|가정|행정|회생)법원|지법|고법/, '법원명'],
];
const scan = (t) => LEAK.filter(([re]) => re.test(t)).map(([, n]) => n);
// 잔존 식별정보 검사: 걸리면 사람이 확인한다(오탐 가능).
const IDENT = [
  [/(주식회사|유한회사|합자회사|재단법인|사단법인|학교법인|의료법인|농업회사법인)\s*(?![A-Z]\s|[A-Z]$|○|△|◇|◎)[가-힣A-Za-z]{2,}/, '법인 상호'],
  [/[가-힣]{2,4}\s*(씨|님)(?![가-힣])/, '개인 호칭'],
  [/\d{4}\s*\.\s*\d{1,2}\s*\.\s*\d{1,2}|\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/, '전체 날짜'],
  [/\d+\s*번지|[가-힣0-9]+(로|길)\s*\d+(-\d+)?/, '주소·지번'],
  [/\d{2,3}-\d{3,4}-\d{4}|\d{6}-\d{7}/, '전화·주민번호 형식'],
  [/법무법인|소송대리인|담당변호사/, '대리인'],
];
// 검토용 개요의 【원심의 판단 요지】에는 원심의 결론·평가 표현이 정당하게 들어가므로, 그 구간은 대법원 관련 표현만 검사한다.
const LEAK_ORIGIN = [[/대법원/, '대법원'], [/파기/, '파기'], [/환송/, '환송'], [/상고(를|가|은|이)?\s*(기각|각하|인용|받아들)/, '상고 결과 표현'], [/상고\s*이유/, '상고이유']];
const scanReview = (t) => {
  const i = t.indexOf('【원심의 판단 요지】');
  if (i < 0) return scan(t);
  return [...new Set([...scan(t.slice(0, i)), ...LEAK_ORIGIN.filter(([re]) => re.test(t.slice(i))).map(([, n]) => n)])];
};
// 자동 수정 요청을 일으키는 '강한 위반' — 결론 힌트와 식별정보 가운데 기계적으로 확실한 것만.
const HARD_IDENT = [
  [/\d{4}\s*(?:년|\.)\s*\d{1,2}\s*(?:월|\.)/, '월 단위 이하 날짜'],
  [/(?<!\d)\d{1,2}\s*월(?!\s*(?:간|분))/, '월 표기'],
  [/(인천|김포|김해|제주|대구|청주)\s*(국제)?공항/, '공항명'],
  [/카운티|로스앤젤레스|캘리포니아|뉴욕|텍사스|플로리다|도쿄|오사카|런던|파리|베이징|상하이|샌프란시스코|시카고|보스턴/, '외국 도시·주 이름'],
  [/언론|보도|널리\s*알려/, '보도·알려진 정도 서술'],
  [/\d{4}(?!년)[가-힣]{1,3}\d{3,}/, '사건번호 형식'],
  [/법무법인|소송대리인|담당변호사/, '대리인'],
];
const HARD_LEAK = new Set(['파기', '환송', '상고 결과 표현', '상고이유', '대법원', '판시', '주문', '대법관', '정당하다', '법리 오해']);
function hardViolations(parsed) {
  const out = [];
  for (const [name, text, isReview] of [['검토용', parsed.overview_review || '', true], ['독립용', parsed.overview_independent || '', false]]) {
    for (const [re, label] of HARD_IDENT) { const m = text.match(re); if (m) out.push(`${name} 개요에 ${label}: "${m[0]}"`); }
    const leaks = (isReview ? scanReview(text) : scan(text)).filter((n) => HARD_LEAK.has(n));
    if (leaks.length) out.push(`${name} 개요에 결론 관련 표현(${leaks.join(', ')})`);
  }
  return out;
}
const scanIdent = (t) => IDENT.filter(([re]) => re.test(t)).map(([, n]) => n);

// ── API ──────────────────────────────────────────────
async function callDeepSeek(messages, maxTokens = DS_MAXTOK) {
  // DeepSeek(OpenAI 호환 API)은 Anthropic의 별도 system 필드가 없다 — messages 맨 앞에
  // system 역할 메시지로 직접 넣어야 한다. 이걸 빠뜨리면 지시문(SYSTEM) 없이 판결문만
  // 전달되어, 모델이 전혀 다른 작업(일반 해설)으로 응답한다.
  const withSystem = [{ role: 'system', content: SYSTEM }, ...messages];
  const body = JSON.stringify({ model: MODEL, messages: withSystem, temperature: 0, max_tokens: maxTokens });
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body });
    const txt = await r.text();
    if (r.ok) {
      const j = JSON.parse(txt); const choice = j.choices?.[0];
      return { content: [{ type: 'text', text: choice?.message?.content || '' }], usage: { input_tokens: j.usage?.prompt_tokens || 0, output_tokens: j.usage?.completion_tokens || 0 }, stop_reason: choice?.finish_reason };
    }
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error('API 재시도 초과');
}
async function callModel(messages, maxTokens) { return PROVIDER === 'deepseek' ? callDeepSeek(messages, maxTokens) : callClaude(messages); }
async function callClaude(messages) {
  const base = { model: MODEL, max_tokens: 8000, system: SYSTEM, messages };
  let useTemp = true;
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = JSON.stringify(useTemp ? { ...base, temperature: 0 } : base);
    const r = await fetch(API_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body,
    });
    const txt = await r.text();
    if (r.ok) return JSON.parse(txt);
    if (r.status === 400 && useTemp && /temperature/i.test(txt)) { useTemp = false; attempt--; continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(2000 * 2 ** attempt); continue; }
    throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
  }
  throw new Error('API 재시도 초과');
}
function parseJsonBlock(t) {
  // 1) ```json ... ``` 또는 ``` ... ``` 코드펜스가 있으면 그 안을 우선 시도(모델이 흔히 이렇게 감싼다)
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = fence ? [fence[1], t] : [t];
  for (const c of candidates) {
    const a = c.indexOf('{');
    if (a < 0) continue;
    // 2) 첫 '{'부터 중괄호 깊이를 세어 짝이 맞는 지점까지만 자른다(문자열 안의 '{','}'와 이스케이프는 건너뜀).
    //    마지막 '}'만 찾는 방식은 JSON 뒤에 설명 문장이 더 붙거나 문장 속에 '}'가 섞이면 깨진다.
    let depth = 0; let inStr = false; let esc = false; let end = -1;
    for (let i = a; i < c.length; i++) {
      const ch = c[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end < 0) continue;
    try { return JSON.parse(c.slice(a, end + 1)); } catch { continue; }
  }
  throw new Error('JSON 없음');
}

// ── 사건별 파일 내보내기 ─────────────────────────────
function exportRec(rec) {
  const pairs = [['review', rec.overview_review], ['independent', rec.overview_independent]];
  for (const [mode, body] of pairs) {
    const dir = path.join('overview_txt', mode); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${rec.id}.txt`), String(body ?? '') + '\n', 'utf8');
  }
  const devDir = path.join('dev100', `r${String(rec.round).padStart(2, '0')}`, String(rec.id));
  if (fs.existsSync(devDir)) for (const [mode, body] of pairs) fs.writeFileSync(path.join(devDir, `overview_${mode}.txt`), String(body ?? '') + '\n', 'utf8');
}
function exportIndex() {
  if (!fs.existsSync(OUT)) return 0;
  const recs = fs.readdirSync(OUT).filter((f) => /^\d+\.json$/.test(f)).map((f) => readJson(path.join(OUT, f)))
    .sort((a, b) => (a.round - b.round) || String(a.id).localeCompare(String(b.id)));
  const H = ['id', 'round', 'generator', 'review_chars', 'independent_chars', 'has_2nd', 'has_1st', 'auto_revisions', 'hard_remaining', 'soft_flags', 'input_tokens', 'output_tokens'];
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = recs.map((r) => [r.id, r.round, r.generator ?? '', r.chars?.review, r.chars?.independent, r.sources?.second, r.sources?.first, r.revisions ?? 0,
    (r.hard_remaining || []).join(' / '), [...new Set([...(r.flags?.review || []), ...(r.flags?.independent || []), ...(r.flags?.identifiers || [])])].join(','),
    r.usage?.input_tokens, r.usage?.output_tokens]);
  fs.writeFileSync(path.join(OUT, 'index.csv'), '\uFEFF' + [H.join(','), ...rows.map((r) => r.map(q).join(','))].join('\r\n'), 'utf8');
  return recs.length;
}
if (EXPORT_ONLY) {
  let n = 0;
  if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT).filter((x) => /^\d+\.json$/.test(x))) { exportRec(readJson(path.join(OUT, f))); n++; }
  const total = exportIndex();
  console.log(`내보내기 완료: 사건 ${n}건 -> overview_txt\\review, overview_txt\\independent, dev100\\rNN\\<id>\\overview_*.txt, ${OUT}\\index.csv (표 ${total}행)`);
  process.exit(0);
}

// ── 실행 ─────────────────────────────────────────────
const dev = readCsv(DEV).filter((r) => (ROUND ? Number(r.round) === ROUND : true));
const chainById = new Map(readCsv(CHAIN).map((r) => [r.id, r]));
fs.mkdirSync(OUT, { recursive: true });
const IDS = args.ids ? String(args.ids).split(',').map((s) => s.trim()).filter(Boolean) : null;
const allJobs = (IDS ? dev.filter((r) => IDS.includes(String(r.id))) : dev).slice(0, LIMIT);
const jobs = allJobs.filter((r) => FORCE || !fs.existsSync(path.join(OUT, `${r.id}.json`)));
const TOTAL = jobs.length;
const fmtT = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return h ? `${h}시간 ${m}분` : m ? `${m}분 ${s % 60}초` : `${s}초`; };
let finished = 0; const tStart = Date.now();
const progress = () => { finished++; const el = Date.now() - tStart; return `[${finished}/${TOTAL}] 경과 ${fmtT(el)}, 남은 시간 약 ${fmtT((el / finished) * (TOTAL - finished))} |`; };
console.log(`대상 ${allJobs.length}건 중 이미 완료된 ${allJobs.length - jobs.length}건은 건너뛰고 ${TOTAL}건을 실행합니다(동시 ${CONC}건).`);
let done = 0; let skipped = allJobs.length - jobs.length; let failed = 0; let revised = 0; const unresolved = []; const flagged = []; const chars = [];
let shown = 0;

async function work(row) {
  const outPath = path.join(OUT, `${row.id}.json`);
  if (!FORCE && fs.existsSync(outPath)) { skipped++; return; }
  const ch = chainById.get(row.id) || {};
  const sup = bodyText(path.join('prec_civil', `${row.date}_${row.id}.json`));
  const sec = ch.found2 === 'True' ? bodyText(path.join('prec_2nd', `${ch.id2}.json`)) : null;
  const fst = ch.found1 === 'True' ? bodyText(path.join('prec_1st', `${ch.id1}.json`)) : null;
  if (!sup) { console.error(`본문 없음: ${row.id}`); failed++; return; }
  const user = userMessage(sup, sec, fst);
  if (DRY) { console.log(`[dry] ${row.id} round=${row.round} 입력 ${user.length}자 (2심 ${sec ? 'O' : 'X'}, 1심 ${fst ? 'O' : 'X'})`); done++; return; }
  try {
    let data; let parsed; let text; let viol = []; let revisions = 0; const usageSum = { input_tokens: 0, output_tokens: 0 };
    let messages = [{ role: 'user', content: user }];
    for (let rnd = 0; rnd <= 2; rnd++) {
      for (let t = 0; t < 2; t++) {
        data = await callModel(messages, DS_MAXTOK);
        usageSum.input_tokens += data.usage?.input_tokens || 0; usageSum.output_tokens += data.usage?.output_tokens || 0;
        text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        if (!text.trim() && PROVIDER === 'deepseek' && data.stop_reason === 'length') {
          // 추론만 하다 예산이 다 떨어진 경우 — 예산을 늘려 한 번 더 시도(같은 시도 횟수 안에서)
          data = await callModel(messages, DS_MAXTOK * 2);
          usageSum.input_tokens += data.usage?.input_tokens || 0; usageSum.output_tokens += data.usage?.output_tokens || 0;
          text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
        }
        try { parsed = parseJsonBlock(text); break; } catch (e) {
        const dbgDir = path.join(OUT, '_debug'); fs.mkdirSync(dbgDir, { recursive: true });
        fs.writeFileSync(path.join(dbgDir, `${row.id}_attempt${t}.txt`), text, 'utf8');
        if (t === 1) throw e;
      }
      }
      viol = hardViolations(parsed);
      if (!viol.length || rnd === 2) break;
      revisions++;
      messages = [...messages, { role: 'assistant', content: text }, { role: 'user', content: `방금 작성한 개요에서 다음 위반이 발견되었습니다.\n- ${viol.join('\n- ')}\n위반을 모두 고쳐서 두 개요를 다시 작성하고, 같은 JSON 형식으로만 출력하십시오. 규칙은 그대로입니다.` }];
    }
    const rec = {
      id: row.id, round: Number(row.round), caseNo: row.caseNo, date: row.date, label: row.label, binary: row.binary,
      model: data.model || MODEL, created: new Date().toISOString(),
      sources: { supreme: true, second: !!sec, first: !!fst },
      overview_review: parsed.overview_review, overview_independent: parsed.overview_independent,
      chars: { review: parsed.overview_review?.length ?? 0, independent: parsed.overview_independent?.length ?? 0 },
      flags: { review: scanReview(parsed.overview_review || ''), independent: scan(parsed.overview_independent || ''), identifiers: [...new Set([...scanIdent(parsed.overview_review || ''), ...scanIdent(parsed.overview_independent || '')])] },
      self_check: parsed.self_check, stop_reason: data.stop_reason, usage: usageSum, revisions, hard_remaining: viol,
      generator: `${PROVIDER}:${MODEL}`, generator_note: PROVIDER === 'deepseek' ? 'DeepSeek 계정(개요 전용, klaw_runner.mjs의 가상 판결 생성 계정과 다름)' : null,
    };
    fs.writeFileSync(outPath, JSON.stringify(rec, null, 2), 'utf8');
    exportRec(rec);
    chars.push(rec.chars.review);
    if (rec.flags.review.length || rec.flags.independent.length || rec.flags.identifiers.length) flagged.push(row.id);
    if (rec.revisions) revised++;
    if (rec.hard_remaining.length) unresolved.push(row.id);
    done++;
    console.log(`${progress()} 완료 ${row.id} (라운드 ${row.round}) 검토 ${rec.chars.review}자 / 독립 ${rec.chars.independent}자 / 표시 ${[...new Set([...rec.flags.review, ...rec.flags.independent, ...rec.flags.identifiers])].join(',') || '없음'} | 자동수정 ${rec.revisions}회`);
    if (SHOW && shown < 2) { shown++; console.log('\n──── 검토용 ────\n' + rec.overview_review + '\n──── 독립용 ────\n' + rec.overview_independent + '\n'); }
  } catch (e) { failed++; console.error(`${progress()} 실패 ${row.id}: ${e.message}`); }
}

const queue = [...jobs];
await Promise.all(Array.from({ length: CONC }, async () => { while (queue.length) await work(queue.shift()); }));
console.log(`\n요약: 대상 ${allJobs.length} | 완료 ${done} | 건너뜀 ${skipped} | 실패 ${failed} | 표시된 사건 ${flagged.length}`);
exportIndex();
console.log(`자동 수정을 거친 사건 ${revised}건 | 수정 후에도 강한 위반이 남은 사건 ${unresolved.length}건${unresolved.length ? ': ' + unresolved.join(', ') : ''}`);
if (chars.length) console.log(`검토용 평균 ${Math.round(chars.reduce((a, b) => a + b, 0) / chars.length)}자`);
if (flagged.length) console.log(`1단계 검사(결론 힌트·식별정보)에 걸린 사건(사람 확인 필요): ${flagged.join(', ')}`);
