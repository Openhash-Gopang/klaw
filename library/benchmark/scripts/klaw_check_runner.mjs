// klaw_check_runner.mjs — klaw_runner.mjs가 생성한 판결문을 K-Law-Check로 별도 API
// 호출에서 사후 검수한다. (OpenAI 호환 chat completions API, Node 18+)
//
// 검수 SP 자동탐지·버전 불일치 경고(2026-09-30 신설): --check를 생략하면 저장소 루트의
// klaw_check_v[숫자_숫자].md 중 버전이 가장 높은 파일을 klaw_v*.md와 똑같은 규칙으로
// 자동 채택한다(klaw_pipeline_shared.mjs의 resolveLatestCheck). 이 파일명의 버전은
// "이 SP가 검토·반영한 K-Law 본체 버전"을 뜻한다 — 검수 대상 사건을 생성한 본체
// 버전(rec.config.version)이 이보다 높으면(예: 본체 v18.0인데 검수 SP는 여전히
// klaw_check_v17_0.md) 실행 시작 시 콘솔에 경고를 출력한다. K-Law-Check가 한동안
// v17.0.4에 고정된 채 v17.0.5~v17.0.8을 전혀 모르고 있었던 문제(2026-09-30 검토에서
// 지적됨)가 다음에는 사람이 우연히 알아챌 때까지 방치되지 않도록 하기 위함이다.
//
// 사용:
//   node klaw_check_runner.mjs --tag=r01_retest_v17_0_4 [--check=klaw_check_v17_0.md]
//        [--overview=overview] [--runs=runs] [--out=runs/<tag>-check]
//        [--model=deepseek-flash] [--url=https://api.deepseek.com/chat/completions]
//        [--key-env=KLAW_CHECK_API_KEY] [--max-tokens=20000] [--concurrency=2] [--limit=N] [--force] [--dry]
// 환경변수: KLAW_CHECK_API_KEY (기본값. klaw_runner.mjs가 쓰는 DEEPSEEK_API_KEY와
//   이름을 일부러 다르게 뒀다 — 두 키는 용도가 다르다: 하나는 판결문 생성, 하나는
//   검수용이며, 검수는 가능하면 다른 제공사·다른 모델의 키를 쓰는 것이 권장되므로
//   변수명을 공유하면 두 용도가 섞여 헷갈릴 수 있다. 필요하면 --key-env로 다른
//   환경변수 이름을 지정할 수 있다. 검수에 DeepSeek을 그대로 쓰더라도, 키 자체를
//   판결문 생성용과 별도로 발급받아 이 변수에 넣는 것을 권장한다.
//
// 설계 메모(klaw_check_v17_0.md §0 참조): 1차 판결문을 생성한 것과 같은 모델·같은 API 키로
// 돌려도 M-1(법령 원문 텍스트 대조)·M-2(특별법 구조적 열거)는 "제공된 자료와의 대조",
// "구체적 목록 열거"로 범위를 좁혀 설계돼 있어 순수 자기 확인보다는 신뢰도가 높다.
// 다만 가능하면 1차 생성과 다른 모델로 이 스크립트를 돌리는 것을 권장한다(--model 또는
// --url로 다른 OpenAI 호환 엔드포인트를 지정 가능).

import fs from 'node:fs';
import path from 'node:path';
import { resolveLatestCheck, parseMajorMinor } from './klaw_pipeline_shared.mjs';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));

const TAG = args.tag;
if (!TAG) { console.error('사용: node klaw_check_runner.mjs --tag=<klaw_runner.mjs 실행 시 사용한 --tag>'); process.exit(1); }
const CHECK = args.check || resolveLatestCheck();
const OVDIR = args.overview || 'overview';
const RUNS = args.runs || 'runs';
const IN = path.join(RUNS, TAG);
const OUT = args.out || path.join(RUNS, `${TAG}-check`);
const MODEL = args.model || 'deepseek-flash';
const MAXTOK = Number(args['max-tokens'] || 20000);
const CONC = Math.max(1, Number(args.concurrency || 2));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const FORCE = !!args.force;
const DRY = !!args.dry;
const URL = args.url || 'https://api.deepseek.com/chat/completions';
const KEY_ENV = args['key-env'] || 'KLAW_CHECK_API_KEY';
const KEY = process.env[KEY_ENV];

if (!fs.existsSync(IN)) { console.error(`실행 결과 폴더가 없습니다: ${IN} (먼저 klaw_runner.mjs --tag=${TAG} 를 돌렸는지 확인하세요)`); process.exit(1); }
if (!KEY && !DRY) { console.error(`${KEY_ENV} 환경변수가 없습니다. (klaw_runner.mjs의 DEEPSEEK_API_KEY와는 별도 변수입니다 — --key-env로 이름을 바꿀 수 있습니다)`); process.exit(1); }

const readText = (p) => { let t = fs.readFileSync(p, 'utf8'); if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1); return t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const checkSP = readText(CHECK);
fs.mkdirSync(OUT, { recursive: true });

// ── 대상 사건 목록: runs/<tag>/*.json (results.csv 제외) ──
const ids = fs.readdirSync(IN)
  .filter((n) => n.endsWith('.json'))
  .map((n) => n.replace(/\.json$/, ''))
  .filter((id) => id !== 'results')
  .slice(0, LIMIT);

if (!ids.length) { console.error(`${IN}에서 사건 json을 찾지 못했습니다.`); process.exit(1); }

// ── 버전 불일치 경고: 검수 SP가 검토·반영한 K-Law 본체 버전(CHECK 파일명)과, 실제로
//    검수 대상 사건을 생성한 본체 버전(rec.config.version, klaw_runner.mjs가 기록)을
//    비교한다. 여러 버전이 섞여 있으면(같은 태그를 여러 시점에 이어 실행한 경우 등)
//    가장 높은 생성 버전을 기준으로 판단한다. ──
(function warnVersionDrift() {
  const checkVer = parseMajorMinor(CHECK);
  let maxMethodVer = 0; let maxMethodStr = '';
  for (const id of ids) {
    try {
      const rec = JSON.parse(readText(path.join(IN, `${id}.json`)));
      const v = parseMajorMinor(rec.config?.version || '');
      if (v > maxMethodVer) { maxMethodVer = v; maxMethodStr = rec.config?.version || ''; }
    } catch { /* 개별 사건 파싱 실패는 이 경고 목적상 무시 — 본 실행에서 다시 에러가 난다 */ }
  }
  if (maxMethodVer > checkVer) {
    console.error(`⚠ 버전 불일치: 검수 대상 사건이 K-Law ${maxMethodStr}로 생성됐는데, 지금 쓰는 검수 SP(${CHECK})는 v${checkVer.toFixed(1)}까지만 검토·반영돼 있습니다. K-Law-Check 내용이 최신 본체 버전(새 공리·새 자기검증 장치 등)을 반영했는지 확인하고, 반영했다면 klaw_check_v${String(maxMethodStr).replace(/^v/, '').replace('.', '_')}.md로 git mv 하세요.`);
  }
})();

// ── API 호출 (klaw_runner.mjs와 동일한 스트리밍 방식) ──
async function chat(messages, maxTokens, thinking = true) {
  const opt = { temperature: 0.2, thinking };
  for (let attempt = 0; attempt < 6; attempt++) {
    const body = { model: MODEL, messages, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true } };
    if (opt.temperature !== null) body.temperature = opt.temperature;
    if (opt.thinking) { body.thinking = { type: 'enabled' }; body.reasoning_effort = 'high'; }
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

async function checkCase(id) {
  const outJson = path.join(OUT, `${id}.json`);
  if (!FORCE && fs.existsSync(outJson)) { console.log(`[skip] ${id} 이미 검수됨`); return; }

  const rec = JSON.parse(readText(path.join(IN, `${id}.json`)));
  const ovPath = path.join(OVDIR, `${id}.json`);
  if (!fs.existsSync(ovPath)) { console.error(`[${id}] 개요 없음: ${ovPath}`); return; }
  const overview = JSON.parse(readText(ovPath)).overview_independent;
  const verdictText = Object.values(rec.parts || {}).join('\n\n') || rec.predicted?.order || '';

  const userMsg = `[사건 ID: ${id}]\n\n[사건 개요 — K-Law에 실제로 입력된 원문]\n${overview}\n\n---\n\n[K-Law 판결문 전문]\n${verdictText}`;
  if (DRY) { console.log(`[dry] ${id} 개요 ${overview.length}자 / 판결문 ${verdictText.length}자`); return; }

  console.log(`[검수 시작] ${id} ...`);
  const t0 = Date.now();
  const msgs = [{ role: 'system', content: checkSP }, { role: 'user', content: userMsg }];
  let r = await chat(msgs, MAXTOK);
  // finish==='length'면 본문이 비었든 일부만 나왔든(중간에 잘림) 예산이 부족했다는 뜻이므로
  // 예산을 키워 재시도한다(klaw_runner.mjs의 retry-length와 동일한 안전장치). 매번 finish가
  // 'length'로 남아 있는 한 계속 키우되, 상한(120,000)을 넘지 않는다.
  let budget = MAXTOK;
  while (r.finish === 'length' && budget < 120000) {
    budget = Math.round(budget * 1.6);
    console.log(`[${id}] 응답이 잘림(finish=length, 본문 ${r.content.length}자) — ${budget} 토큰으로 재시도`);
    r = await chat(msgs, budget);
  }
  // 그래도 본문이 비면 추론 모드를 끄고 한 번 더 시도(추론 자체가 예산을 독점하는 것을 원천 차단).
  if (!r.content.trim()) {
    console.log(`[${id}] 여전히 본문 없음 — thinking 비활성화로 재시도`);
    r = await chat(msgs, MAXTOK, false);
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (r.finish === 'length') console.error(`[${id}] 경고: 상한(120,000)에서도 finish=length — 보고서가 잘렸을 수 있습니다(본문 ${r.content.length}자).`);
  else if (!r.content.trim()) console.error(`[${id}] 경고: 재시도에도 검수 보고서가 비어 있습니다(finish=${r.finish}).`);

  fs.writeFileSync(outJson, JSON.stringify({ id, model: MODEL, elapsed_s: elapsed, usage: r.usage, finish: r.finish, report: r.content }, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${id}.md`), r.content, 'utf8');
  console.log(`[검수 완료] ${id} (${elapsed}s)`);
}

let idx = 0;
async function worker() {
  while (idx < ids.length) {
    const id = ids[idx++];
    try { await checkCase(id); } catch (e) { console.error(`[${id}] 실패:`, e.message); }
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, ids.length) }, worker));
console.log(`\n완료: ${OUT}`);
