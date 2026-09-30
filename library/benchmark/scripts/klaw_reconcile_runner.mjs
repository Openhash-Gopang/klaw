// klaw_reconcile_runner.mjs — K-Law-Check(klaw_check_runner.mjs)가 찾아낸 지적사항을
// K-Law 생성 모델 자신에게 되돌려, 기존 STEP V(자기 검증) 경로와 동일한 방식으로
// "해당/비해당 판정 + 근거 인용 + 필요시 재판단"을 강제하는 재검토(reconciliation) 단계.
// (OpenAI 호환 chat completions API, Node 18+)
//
// 파이프라인 위치:
//   klaw_runner.mjs (생성, --tag=T)
//     → klaw_check_runner.mjs (독립 검수, runs/T-check/<id>.json 생성)
//       → klaw_reconcile_runner.mjs (본 스크립트, runs/T-reconcile/<id>.json 생성)
//
// 설계 메모:
// - STEP V는 klaw_runner.mjs 안에서 lintB()가 만든 내부 결정론적 트리거(V-1~V-7)만
//   입력으로 받는다. 본 스크립트는 그 트리거 대신 외부 독립 검수(K-Law-Check) 보고서
//   원문을 입력으로 삼아 "같은 SYSTEM(같은 방법론)"으로 K-Law 자신에게 재검토를
//   요청한다 — 검수는 독립성을 위해 다른 모델/키를 쓰지만(klaw_check_runner.mjs 상단
//   설계 메모 참조), 재검토는 저자 본인의 방법론 일관성을 위해 원 생성 모델(기본
//   DEEPSEEK_API_KEY)로 수행하는 것을 기본값으로 한다.
// - 검수 보고서는 모듈(M-1/M-2/M-3)별 자유서술형 markdown이라 매 실행마다 문구가
//   달라질 수 있으므로, 정규식으로 파싱해 트리거 배열로 변환하지 않고 원문 전체를
//   그대로 프롬프트에 넣는다. 대신 "인용·근거 없는 판정은 무효"라는 조항으로 형식적
//   통과 의례가 되는 것을 막는다.
// - 검수가 스스로 오인지했을 가능성이 있으므로 지적을 자동으로 사실로 취급하지 않고,
//   K-Law가 각 항목을 [수용]/[반박]으로 직접 판정하게 하며, 그 결과([STEP-RECONCILE-
//   COMPLETE | 지적 N건 | 수용 A건 | 반박 B건 | 결론: 유지/변경])를 그대로 기록해
//   추후 사람이나 별도 심사로 감사할 수 있게 한다.
//
// 사용:
//   node klaw_reconcile_runner.mjs --tag=r01_retest_v17_0_5 [--check=<tag>-check]
//        [--overview=overview] [--runs=runs] [--out=<tag>-reconcile]
//        [--model=<원 실행에 쓰인 모델 자동 사용>] [--effort=high] [--max-tokens=24000]
//        [--concurrency=2] [--limit=N] [--force] [--dry]
//        [--url=https://api.deepseek.com/chat/completions] [--key-env=DEEPSEEK_API_KEY]
// 환경변수: DEEPSEEK_API_KEY (기본. --key-env로 다른 이름 지정 가능 — 예: 재검토를
//   검수와 같은 모델로 실험해보고 싶다면 --key-env=KLAW_CHECK_API_KEY 등)

import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const TAG = args.tag;
if (!TAG) { console.error('사용: node klaw_reconcile_runner.mjs --tag=<klaw_runner.mjs 실행 시 사용한 --tag>'); process.exit(1); }
const RUNS = args.runs || 'runs';
const IN = path.join(RUNS, TAG);
const CHECK_TAG = args.check || `${TAG}-check`;
const CHECK_DIR = path.join(RUNS, CHECK_TAG);
const OVDIR = args.overview || 'overview';
const OUT = args.out || path.join(RUNS, `${TAG}-reconcile`);
const EFFORT = args.effort || 'high';
const MAXTOK = Number(args['max-tokens'] || 24000);
const CONC = Math.max(1, Number(args.concurrency || 2));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FORCE = !!args.force;
const DRY = !!args.dry;
const URL = args.url || 'https://api.deepseek.com/chat/completions';
const KEY_ENV = args['key-env'] || 'DEEPSEEK_API_KEY';
const KEY = process.env[KEY_ENV];
const TEMP = args.temperature !== undefined ? Number(args.temperature) : 0.2;

if (!fs.existsSync(IN)) { console.error(`생성 결과 폴더가 없습니다: ${IN} (먼저 klaw_runner.mjs --tag=${TAG} 를 돌렸는지 확인하세요)`); process.exit(1); }
if (!fs.existsSync(CHECK_DIR)) { console.error(`검수 결과 폴더가 없습니다: ${CHECK_DIR} (먼저 klaw_check_runner.mjs --tag=${TAG} 를 돌렸는지 확인하세요)`); process.exit(1); }
if (!KEY && !DRY) { console.error(`${KEY_ENV} 환경변수가 없습니다.`); process.exit(1); }

const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT, { recursive: true });

// ── klaw_runner.mjs와 동일한 SYSTEM 프롬프트 템플릿·주문 분류기 (재검토도 같은
//    방법론·같은 판정 규칙으로 채점되어야 하므로 그대로 복제한다) ──
const SIM_TEMPLATE = "당신은 K-Law 판결 방법론 {{VER}}을 적용하는 대한민국 법원 판결 AI입니다.\n{{BODY}}위 가상판결 출력형식 v13.3을 반드시 준수하여 판결문을 작성하세요.\n사건번호·심급 등 이번 사건의 구체적인 정보는 이어지는 사용자 메시지에서 확인하세요.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n본 시뮬레이션은 법률 정보 제공 목적이며 법률 자문이 아닙니다.\n가상판결 출력형식 v13.3 | K-Law {{VER}} 적용\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

function classify(o) {
  if (/원고\s*전부\s*승소/.test(o)) return ['원고전부승소', 'v3'];
  if (/원고\s*일부\s*승소/.test(o)) return ['원고일부승소', 'v3'];
  if (/원고\s*패소|피고\s*승소/.test(o)) return ['원고패소', 'v3'];
  if (/피고인\s*무죄/.test(o)) return ['피고인무죄', 'v3'];
  if (/피고인\s*유죄/.test(o)) return ['피고인유죄', 'v3'];
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
const lastMatch = (t, re) => { let m; let last = null; const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'); while ((m = g.exec(t))) last = m; return last ? last[1] : null; };

function resolveLatestMethod() {
  const files = fs.readdirSync('.').filter((n) => /^klaw_v[\d_]+\.md$/i.test(n));
  if (!files.length) throw new Error('저장소 루트에 klaw_v*.md 방법론 파일이 없습니다.');
  const parseVer = (name) => { const m = name.match(/klaw_v(\d+)_?(\d*)\.md/i); return m ? parseFloat(`${m[1]}.${m[2] || '0'}`) : 0; };
  files.sort((a, b) => parseVer(b) - parseVer(a));
  return files[0];
}

// ── 재검토 프롬프트: STEP V와 같은 정신("해당/비해당 + 근거 인용 + 필요시 재판단")을
//    내부 lint 트리거가 아니라 외부 검수 보고서 원문에 적용한다 ──
const RECONCILE_PROMPT = (ctx, checkReport) => `${ctx}

STEP B(및 자기 검증)가 완료된 위 판결문에 대해, 이 사건 생성과 무관한 별도의 독립
검수 시스템(K-Law-Check)이 다음과 같은 검수 보고서를 작성했습니다. 이 보고서는
확정된 사실이 아니라 외부의 지적이므로, 당신 자신의 방법론에 따라 각 지적을
스스로 재검토하십시오.

[외부 검수 보고서 전문]
${checkReport}

지시:
1. 위 보고서에서 판결문에 대한 구체적 지적 사항을 항목별로 추출하십시오(모듈
   M-1/M-2/M-3 및 [종합 판정] 사유에 열거된 것을 모두 포함하되, 실질적 근거가
   없는 절차적 언급은 제외).
2. 각 항목에 대해 [수용] 또는 [반박] 중 하나로 판정하십시오. 판정에는 반드시
   판결문 원문의 근거 문장을 인용하거나(반박의 경우) 그 근거를 구체적으로
   제시해야 합니다 — 인용·근거 없는 판정은 무효입니다.
3. [수용]으로 판정한 항목이 결론(주문)에 영향을 미치는 경우, 그 영향을 반영하여
   [V-재판단]을 수행하고 주문을 다시 산정하십시오. 영향이 없는 [수용] 항목은
   그 이유(다른 근거로 결론이 유지됨 등)를 명시하십시오.
4. 모든 항목을 처리한 뒤, 마지막 줄에 '최종 주문: (변경 없음 | 주문 문장)'을
   쓰십시오.
5. 맨 마지막 줄은 반드시 다음 형식의 태그로 마무리하십시오(N=A+B):
   [STEP-RECONCILE-COMPLETE | 지적 N건 | 수용 A건 | 반박 B건 | 결론: 유지/변경]`;

// ── API 호출 (klaw_check_runner.mjs와 동일한 스트리밍 방식) ──
async function chat(model, messages, maxTokens, thinking = true) {
  const opt = { temperature: TEMP, thinking };
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    if (opt.temperature !== null) body.temperature = opt.temperature;
    if (opt.thinking) { body.thinking = { type: 'enabled' }; body.reasoning_effort = EFFORT; }
    let r;
    try { r = await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(1_200_000) }); }
    catch (e) { await sleep(3000 * 2 ** attempt); continue; }
    if (!r.ok) {
      const txt = await r.text();
      if (r.status === 400 && opt.temperature !== null && /temperature/i.test(txt)) { opt.temperature = null; attempt--; continue; }
      if (r.status === 400 && opt.thinking && /thinking|reasoning_effort/i.test(txt)) { opt.thinking = false; attempt--; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(3000 * 2 ** attempt); continue; }
      throw new Error(`API ${r.status}: ${txt.slice(0, 300)}`);
    }
    const reader = r.body.getReader(); const dec = new TextDecoder('utf-8');
    let buf = ''; let content = ''; let usage = null; let finish = null;
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
        if (j.usage) usage = j.usage;
      }
    }
    return { content, usage, finish };
  }
  throw new Error('API 재시도 초과');
}

// ── 대상 사건 목록: runs/<tag>/*.json ∩ runs/<tag>-check/*.json ──
const ids = fs.readdirSync(IN)
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .filter((id) => id !== 'results')
  .filter((id) => fs.existsSync(path.join(CHECK_DIR, `${id}.json`)))
  .slice(0, LIMIT);

if (!ids.length) { console.error(`${IN} / ${CHECK_DIR} 양쪽에 공통으로 존재하는 사건 json을 찾지 못했습니다.`); process.exit(1); }

async function reconcileCase(id) {
  const outJson = path.join(OUT, `${id}.json`);
  if (!FORCE && fs.existsSync(outJson)) { console.log(`[skip] ${id} 이미 재검토됨`); return; }

  const rec = JSON.parse(readText(path.join(IN, `${id}.json`)));
  const checkRec = JSON.parse(readText(path.join(CHECK_DIR, `${id}.json`)));
  const checkReport = checkRec.report || '';
  if (!checkReport.trim()) { console.error(`[${id}] 검수 보고서가 비어 있습니다 — 건너뜀.`); return; }

  const ovPath = path.join(OVDIR, `${id}.json`);
  if (!fs.existsSync(ovPath)) { console.error(`[${id}] 개요 없음: ${ovPath}`); return; }
  const overview = JSON.parse(readText(ovPath)).overview_independent;

  // 원 실행과 동일한 방법론 파일을 우선 사용 — 오늘 klaw_v17_0.md가 더 패치됐더라도,
  // 재검토는 판결문을 생성했던 바로 그 방법론 버전 기준으로 이뤄져야 일관성이 있다.
  const methodPath = args.method || (rec.config?.method && fs.existsSync(rec.config.method) ? rec.config.method : resolveLatestMethod());
  const formatPath = args.format || (rec.config?.format && fs.existsSync(rec.config.format) ? rec.config.format : '가상판결_출력형식_v13_3.txt');
  const versionStr = rec.config?.version || (() => { const m = path.basename(methodPath).match(/klaw_v(\d+)_?(\d*)/); return m ? `v${m[1]}.${m[2] || '0'}` : 'v미상'; })();
  const methodText = readText(methodPath); const formatText = readText(formatPath);
  const SYSTEM = SIM_TEMPLATE.replace('{{BODY}}', () => '[K-Law 방법론 원문]\n' + methodText + '\n\n---\n\n' + '[가상판결 출력형식 v13.3]\n' + formatText + '\n\n---\n\n').replace(/\{\{VER\}\}/g, () => versionStr);
  const model = args.model || rec.config?.model || 'deepseek-flash';

  const caseNo = rec.caseNo_sim; const level = rec.level;
  const baseCtx = '사용자: 사건의 개요:\n' + overview + '\n\nK-Law: ' + rec.analysis;
  const prevSteps = [rec.parts?.step0, rec.parts?.stepA, rec.parts?.stepB, rec.parts?.stepV].filter(Boolean).join('\n\n');
  const ctx = `[사건번호: ${caseNo} | 심급: ${level}]\n\n[이전 STEP 출력]\n${prevSteps}\n\n[사건 정보]\n${baseCtx}`;

  const orderBefore = rec.predicted?.order || '';
  const binaryBefore = rec.predicted?.binary || '';

  if (DRY) { console.log(`[dry] ${id} ctx ${ctx.length}자 / 검수보고서 ${checkReport.length}자 / method=${methodPath}`); return; }

  console.log(`[재검토 시작] ${id} ...`);
  const t0 = Date.now();
  const msgs = [{ role: 'system', content: SYSTEM }, { role: 'user', content: RECONCILE_PROMPT(ctx, checkReport) }];
  let r = await chat(model, msgs, MAXTOK);
  let budget = MAXTOK;
  while (r.finish === 'length' && budget < 120000) {
    budget = Math.round(budget * 1.6);
    console.log(`[${id}] 응답이 잘림(finish=length, 본문 ${r.content.length}자) — ${budget} 토큰으로 재시도`);
    r = await chat(model, msgs, budget);
  }
  if (!r.content.trim()) {
    console.log(`[${id}] 본문 없음 — thinking 비활성화로 재시도`);
    r = await chat(model, msgs, MAXTOK, false);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (r.finish === 'length') console.error(`[${id}] 경고: 상한(120,000)에서도 finish=length — 재검토가 잘렸을 수 있습니다(본문 ${r.content.length}자).`);
  else if (!r.content.trim()) console.error(`[${id}] 경고: 재시도에도 재검토 응답이 비어 있습니다(finish=${r.finish}).`);

  const tagMatch = r.content.match(/\[STEP-RECONCILE-COMPLETE\s*\|\s*지적\s*(\d+)\s*건\s*\|\s*수용\s*(\d+)\s*건\s*\|\s*반박\s*(\d+)\s*건\s*\|\s*결론[:：]\s*(유지|변경)\]/);
  const items = { total: tagMatch ? Number(tagMatch[1]) : null, accepted: tagMatch ? Number(tagMatch[2]) : null, rebutted: tagMatch ? Number(tagMatch[3]) : null, conclusion_tag: tagMatch ? tagMatch[4] : null };

  const finOrderRaw = lastMatch(r.content, /최종\s*주문\s*[:：]\s*[`*]*([^\n`]+)/g);
  const orderChanged = !!(finOrderRaw && !/변경\s*없음/.test(finOrderRaw));
  const orderAfter = orderChanged ? finOrderRaw.replace(/\*+/g, '').trim() : orderBefore;
  const [, binaryAfter] = orderAfter ? classify(orderAfter) : [null, binaryBefore];
  const changed = binaryBefore !== binaryAfter || orderChanged;

  const out = {
    id, model, elapsed_s: elapsed, usage: r.usage, finish: r.finish,
    method: methodPath, version: versionStr,
    order_before: orderBefore, binary_before: binaryBefore,
    order_after: orderAfter, binary_after: binaryAfter, changed,
    items, report: r.content,
  };
  fs.writeFileSync(outJson, JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${id}.md`), r.content, 'utf8');
  console.log(`[재검토 완료] ${id} (${elapsed}s) | 지적 ${items.total ?? '?'}건 수용 ${items.accepted ?? '?'} 반박 ${items.rebutted ?? '?'} | 결론 ${changed ? '변경' : '유지'}`);
}

let idx = 0;
async function worker() {
  while (idx < ids.length) {
    const id = ids[idx++];
    try { await reconcileCase(id); } catch (e) { console.error(`[${id}] 실패:`, e.message); }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));

// ── 요약 CSV ──
if (!DRY) {
  const rows = ids
    .map((id) => path.join(OUT, `${id}.json`))
    .filter((p) => fs.existsSync(p))
    .map((p) => JSON.parse(readText(p)));
  if (rows.length) {
    const header = 'id,binary_before,binary_after,changed,items_total,accepted,rebutted,conclusion_tag,elapsed_s';
    const csvRows = rows.map((r) => [r.id, r.binary_before, r.binary_after, r.changed, r.items.total, r.items.accepted, r.items.rebutted, r.items.conclusion_tag, r.elapsed_s].map((v) => `"${String(v ?? '')}"`).join(','));
    fs.writeFileSync(path.join(OUT, 'results.csv'), [header, ...csvRows].join('\n') + '\n', 'utf8');
    const changedN = rows.filter((r) => r.changed).length;
    console.log(`\n완료: ${OUT} | 재검토 ${rows.length}건 중 결론 변경 ${changedN}건`);
  } else {
    console.log(`\n완료: ${OUT}`);
  }
}
