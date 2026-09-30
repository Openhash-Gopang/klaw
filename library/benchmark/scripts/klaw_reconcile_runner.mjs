// klaw_reconcile_runner.mjs — K-Law-Check(klaw_check_runner.mjs)가 찾아낸 지적사항을
// K-Law 생성 모델 자신에게 되돌려, 기존 STEP V(자기 검증) 경로와 동일한 방식으로
// "해당/비해당 판정 + 근거 인용"을 강제한 뒤, 그 판단을 반영한 완결된 최종 판결문
// (필요하면 결론을 번복한 최종본)을 K-Law 스스로 다시 제출하게 하는 단계.
// (OpenAI 호환 chat completions API, Node 18+)
//
// 파이프라인 위치:
//   klaw_runner.mjs (생성, --tag=T)
//     → klaw_check_runner.mjs (독립 검수, 다른 API 키, runs/T-check/<id>.json 생성)
//       → klaw_reconcile_runner.mjs (본 스크립트, runs/T-final/<id>.json 생성)
//
// v2 설계 변경(2026-09-30): 최초 버전은 "항목별 수용/반박 + 교정 메모"까지만
//만들고, 그 교정을 반영한 완결된 판결문을 내놓지 않았다 — 그 결과 원본
// runs/T/<id>.json의 판결문은 검수 이후에도 전혀 갱신되지 않아, 검수·재검토가
// 이 사건의 실제 "최종 결과물"에는 아무 영향을 주지 못했다. 이번 버전은
// 항목별 판정(3단계)에 이어 "[최종 판결문 시작]...[최종 판결문 끝]"으로
// 감싼 완결된 주문·이유 전문을 반드시 새로 작성하게 하고, 그 안에서 추출한
// 주문을 이 사건의 최종 결론으로 채택한다. 지적을 수용해 결론이 달라져야
// 한다면 주저 없이 번복하도록 명시적으로 지시한다.
//
// 설계 메모:
// - STEP V는 klaw_runner.mjs 안에서 lintB()가 만든 내부 결정론적 트리거(V-1~V-7)만
//   입력으로 받는다. 본 스크립트는 그 트리거 대신 외부 독립 검수(K-Law-Check) 보고서
//   원문을 입력으로 삼아 "같은 SYSTEM(같은 방법론)"으로 K-Law 자신에게 재검토를
//   요청한다 — 검수는 독립성을 위해 다른 모델/키를 쓰지만(klaw_check_runner.mjs 상단
//   설계 메모 참조), 재검토·최종본 작성은 저자 본인의 방법론 일관성을 위해 원 생성
//   모델(기본 DEEPSEEK_API_KEY)로 수행하는 것을 기본값으로 한다.
// - 검수 보고서는 모듈(M-1/M-2/M-3)별 자유서술형 markdown이라 매 실행마다 문구가
//   달라질 수 있으므로, 정규식으로 파싱해 트리거 배열로 변환하지 않고 원문 전체를
//   그대로 프롬프트에 넣는다. 대신 "인용·근거 없는 판정은 무효"라는 조항으로 형식적
//   통과 의례가 되는 것을 막는다.
// - 검수가 스스로 오인지했을 가능성이 있으므로 지적을 자동으로 사실로 취급하지 않고,
//   K-Law가 각 항목을 [수용]/[반박]으로 직접 판정하게 하며, 그 결과([STEP-RECONCILE-
//   COMPLETE | 지적 N건 | 수용 A건 | 반박 B건 | 결론: 유지/번복])와 완결된 최종
//   판결문을 함께 기록해 추후 사람이나 별도 심사로 감사할 수 있게 한다.
// - 원본 runs/T/<id>.json은 감사 추적을 위해 건드리지 않는다. "최종본"은 별도
//   디렉터리(runs/T-final)에 원본과 나란히 저장되며, 어느 쪽이 실제로 채택된
//   결론인지는 이 스크립트가 생성하는 final_verdict/binary_final 필드로 판단한다.
// - v17.0.8 자기 검증 이력 반영 수정(2026-09-30): 이전 버전은 rec.parts에서
//   step0/stepA/stepB/stepV만 모아 컨텍스트를 구성해 STEPVSC 출력(stepV 없이
//   STEPVSC만 발동한 사건에서는 이 자기 검증 이력 전체)을 빠뜨렸고, klaw_runner.mjs
//   v17.0.8이 이미 병합해 둔 rec.self_check.final_text(있다면)도 전혀 참조하지
//   않았다 — 그 결과 STEPVSC가 이미 고친 정정을 reconcile이 모른 채 처음부터
//   다시 검토하거나, 반대로 "이미 병합된 최종본"이 있는 걸 모르고 정정 이전
//   STEP B 초안을 재검토 대상으로 삼는 혼선이 있었다. 이제 stepVSC도 컨텍스트에
//   포함하고, self_check.final_text가 있으면 그것을 "현재 확정된 판결문"으로
//   프롬프트에 명시해 재검토가 그 위에서 이뤄지게 한다.
//
// 사용:
//   node klaw_reconcile_runner.mjs --tag=r01_retest_v17_0_5 [--check=<tag>-check]
//        [--overview=overview] [--runs=runs] [--out=<tag>-final]
//        [--model=<원 실행에 쓰인 모델 자동 사용>] [--effort=high] [--max-tokens=24000]
//        [--concurrency=2] [--limit=N] [--force] [--dry]
//        [--url=https://api.deepseek.com/chat/completions] [--key-env=DEEPSEEK_API_KEY]
// 환경변수: DEEPSEEK_API_KEY (기본. --key-env로 다른 이름 지정 가능 — 예: 재검토를
//   검수와 같은 모델로 실험해보고 싶다면 --key-env=KLAW_CHECK_API_KEY 등)

import fs from 'node:fs';
import path from 'node:path';
// classify()·extractOrder()·lastMatch()·resolveLatestMethod()는 klaw_runner.mjs와 공유하는
// 채점 로직이라 klaw_pipeline_shared.mjs로 분리했다(2026-09-30) — 재검토도 같은 방법론·같은
// 판정 규칙으로 채점되어야 하므로, 복사본이 아니라 반드시 같은 소스를 참조해야 한다.
import { classify, extractOrder, lastMatch, resolveLatestMethod } from './klaw_pipeline_shared.mjs';

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
const OUT = args.out || path.join(RUNS, `${TAG}-final`);
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

// ── klaw_runner.mjs와 동일한 SYSTEM 프롬프트 템플릿(재검토도 같은 방법론으로 채점되어야
//    하므로 문자열 그대로 유지 — classify()·extractOrder()·lastMatch()·resolveLatestMethod()는
//    klaw_pipeline_shared.mjs에서 import한다, 위 참조) ──
const SIM_TEMPLATE = "당신은 K-Law 판결 방법론 {{VER}}을 적용하는 대한민국 법원 판결 AI입니다.\n{{BODY}}위 가상판결 출력형식 v13.3을 반드시 준수하여 판결문을 작성하세요.\n사건번호·심급 등 이번 사건의 구체적인 정보는 이어지는 사용자 메시지에서 확인하세요.\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n본 시뮬레이션은 법률 정보 제공 목적이며 법률 자문이 아닙니다.\n가상판결 출력형식 v13.3 | K-Law {{VER}} 적용\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

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
   M-1/M-1b/M-2/M-3/M-4/M-5/M-6 및 [종합 판정] 사유에 열거된 것을 모두 포함하되, 실질적 근거가
   없는 절차적 언급은 제외).
2. 각 항목에 대해 [수용] 또는 [반박] 중 하나로 판정하십시오. 판정에는 반드시
   판결문 원문의 근거 문장을 인용하거나(반박의 경우) 그 근거를 구체적으로
   제시해야 합니다 — 인용·근거 없는 판정은 무효입니다.
3. [수용]으로 판정한 항목마다 "결론 영향: 있음 / 없음 / 불명"과 근거 한 줄을 쓰십시오
   (v17.1). 영향이 있다면 주저하지 말고 결론을 번복하십시오 — 기존 결론을 그대로
   지키려는 방향으로 판단을 왜곡해서는 안 됩니다. "없음"이라고 쓰려면 다른 독립된
   근거로 결론이 유지되는 이유를 판결문 원문 문장을 인용해 제시해야 합니다. 결정 규범
   (결론을 지탱하는 조문·법리)이나 방향성 원칙에 관한 지적을 수용하면서 "없음"의
   근거를 인용하지 못하거나 "불명"이면, 결론 유형을 [조건부 결론]으로 전환하고 지적이
   옳을 경우의 주문을 함께 병기하십시오.
4. 위 재검토를 모두 반영하여, 이 사건에 대해 지금 다시 선고한다면 나올 완결된
   판결문 전문을 새로 작성하십시오. 이것은 기존 판결문에 대한 부분 수정
   메모가 아니라 그 자체로 완결된 하나의 문서여야 하며, 가상판결 출력형식
   v13.3의 주문·이유 형식을 그대로 따라야 합니다. 결론이 번복됐다면 번복된
   결론과 그 이유를, 유지된다면 보강된 이유와 함께 원래 결론을 그대로
   싣습니다. 반드시 아래 구분자로 감싸십시오:
   [최종 판결문 시작]
   주 문:
   (주문 전문)
   이 유:
   (이유 전문)
   [최종 판결문 끝]
5. 맨 마지막 줄은 반드시 다음 형식의 태그로 마무리하십시오(N=A+B):
   [STEP-RECONCILE-COMPLETE | 지적 N건 | 수용 A건 | 반박 B건 | 결론: 유지/번복]`;

// ── API 호출 (klaw_check_runner.mjs와 동일한 스트리밍 방식) ──
// 최종 판결문 블록 추출: 마커가 "줄 단독"으로 쓰인 구간만 인정한다(본문 설명·표 안에 `[최종 판결문 시작]…` 같은
// 인라인 언급이 먼저 나와도 그것을 블록으로 오인하지 않게 함 — 617151 재검토에서 `…`만 추출된 사고의 수정).
// 줄 단독 마커 쌍이 없으면 기존 방식(첫 인라인 쌍)으로 되돌린다.
const extractFinalBlock = (t) => {
  const s = String(t ?? '');
  const re = /^[ \t*]*\[최종\s*판결문\s*시작\][ \t*]*$([\s\S]*?)^[ \t*]*\[최종\s*판결문\s*끝\][ \t*]*$/gm;
  let last = null; let m; while ((m = re.exec(s)) !== null) last = m[1];
  if (last !== null && last.trim().length > 20) return last.trim();
  const f = s.match(/\[최종\s*판결문\s*시작\]([\s\S]*?)\[최종\s*판결문\s*끝\]/);
  return f ? f[1].trim() : null;
};

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
  // stepVSC도 포함(과거엔 누락 — 위 2026-09-30 설계 메모 참조).
  const prevSteps = [rec.parts?.step0, rec.parts?.stepA, rec.parts?.stepB, rec.parts?.stepV, rec.parts?.stepVSC].filter(Boolean).join('\n\n');
  // klaw_runner.mjs v17.0.8이 STEP V·STEPVSC에서 이미 병합해 둔 최종 판결문이 있다면
  // (rec.self_check.final_text), 원본 STEP B가 아니라 그것이 "지금 확정된 판결문"임을
  // 명시한다 — 검수 보고서의 지적을 이 재검토 프롬프트가 그 위에 쌓도록 하기 위함.
  const finalNote = rec.self_check?.final_text
    ? `\n\n[참고: 위 STEP 이력 중 STEP V·STEP V-공통점검이 이미 정정 사항을 반영해 아래와 같은\n최종 판결문을 새로 작성했습니다(source: ${rec.self_check.final_source || '미상'}). 지금부터의 재검토는\nSTEP B 초안이 아니라 이 최종 판결문을 "현재 확정된 판결문"으로 삼아 그 위에서\n수행하십시오.]\n[최종 판결문 시작]\n${rec.self_check.final_text}\n[최종 판결문 끝]`
    : '';
  const ctx = `[사건번호: ${caseNo} | 심급: ${level}]\n\n[이전 STEP 출력]\n${prevSteps}${finalNote}\n\n[사건 정보]\n${baseCtx}`;

  const orderBefore = rec.predicted?.order || '';
  const binaryBefore = rec.predicted?.binary || '';
  const labelBefore = rec.predicted?.label || (orderBefore ? classify(orderBefore)[0] : '');

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

  const tagMatch = r.content.match(/\[STEP-RECONCILE-COMPLETE\s*\|\s*지적\s*(\d+)\s*건\s*\|\s*수용\s*(\d+)\s*건\s*\|\s*반박\s*(\d+)\s*건\s*\|\s*결론[:：]\s*(유지|번복|변경)\]/);
  const items = { total: tagMatch ? Number(tagMatch[1]) : null, accepted: tagMatch ? Number(tagMatch[2]) : null, rebutted: tagMatch ? Number(tagMatch[3]) : null, conclusion_tag: tagMatch ? tagMatch[4] : null };

  // 완결된 최종 판결문 전문을 [최종 판결문 시작]...[최종 판결문 끝]에서 추출한다.
  // 이 블록이 곧 "이 사건의 최종 결과물"이다 — 원본 parts.stepB는 감사를 위해
  // 그대로 두고, 최종 결론은 이 블록에서 다시 판정한다.
  const finalVerdictText = extractFinalBlock(r.content) || '';
  if (!finalVerdictText) console.error(`[${id}] 경고: [최종 판결문 시작]...[최종 판결문 끝] 블록을 찾지 못했습니다 — 원 결론을 그대로 유지 처리합니다.`);
  const orderFinal = finalVerdictText ? extractOrder(finalVerdictText) : orderBefore;
  const [labelFinal, binaryFinal] = orderFinal ? classify(orderFinal) : [labelBefore, binaryBefore];
  // "번복" 여부는 binary(파기/유지/v3처럼 거친 채점 범주)가 아니라 label(원고전부승소/
  // 원고일부승소/원고패소 등 세부 결론)로 판정한다 — v3 포맷은 승패 방향이 실제로
  // 달라져도(예: 일부승소 → 전부승소) binary가 똑같이 'v3'로 묶여 감지되지 않는다.
  const reversed = labelBefore !== labelFinal;

  const out = {
    id, model, elapsed_s: elapsed, usage: r.usage, finish: r.finish,
    method: methodPath, version: versionStr,
    order_before: orderBefore, label_before: labelBefore, binary_before: binaryBefore,
    order_final: orderFinal, label_final: labelFinal, binary_final: binaryFinal, reversed,
    items, final_verdict: finalVerdictText, report: r.content,
  };
  fs.writeFileSync(outJson, JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${id}.md`), r.content, 'utf8');
  if (finalVerdictText) fs.writeFileSync(path.join(OUT, `${id}_final.txt`), finalVerdictText, 'utf8');
  console.log(`[재검토 완료] ${id} (${elapsed}s) | 지적 ${items.total ?? '?'}건 수용 ${items.accepted ?? '?'} 반박 ${items.rebutted ?? '?'} | 결론 ${reversed ? '번복' : '유지'}`);
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
    const header = 'id,label_before,label_final,binary_before,binary_final,reversed,items_total,accepted,rebutted,conclusion_tag,elapsed_s';
    const csvRows = rows.map((r) => [r.id, r.label_before, r.label_final, r.binary_before, r.binary_final, r.reversed, r.items.total, r.items.accepted, r.items.rebutted, r.items.conclusion_tag, r.elapsed_s].map((v) => `"${String(v ?? '')}"`).join(','));
    fs.writeFileSync(path.join(OUT, 'results.csv'), [header, ...csvRows].join('\n') + '\n', 'utf8');
    const reversedN = rows.filter((r) => r.reversed).length;
    console.log(`\n완료: ${OUT} | 재검토 ${rows.length}건 중 결론 번복 ${reversedN}건`);
  } else {
    console.log(`\n완료: ${OUT}`);
  }
}
