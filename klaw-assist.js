/* ═════════════════════════════════════════════════════════════════
   klaw-assist.js — 나비웹 도우미 자동 진행기 (2026-11-11 신설)
   하는 일: 사건번호 하나로 아래 6단계를 차례로 진행하고, 단계마다 진행 상황과 만든 문서 링크를 패널에 보고한다.
     1 판결문 확보(법제처 판례 API, 없으면 사용자가 첨부)  2 사실관계 추출·익명화  3 통합 판결문 작성
     4 가상 판결문 생성(기존 STEP 0~C 그대로)  5 일치도 평가(통합 판결문 비교)  6 방법론 갱신 제안
   로그인: 나비웹(naviweb.kr, mail.hondi.net)이 창을 열면서 postMessage 로 토큰을 넘기고, 여기서 KAuth.adopt 로 받는다
          (출처·창 확인 후에만. 주소창에 토큰을 싣지 않는다). 직접 연 경우에는 이 창에서 로그인한다.
   의존: desktop.html 의 전역 함수·변수(runSimulation, autoRunSim, runJudgementSim, runMatchEvaluation, setMatchMode,
        callLLMStream, updateProgressToast, conversationState, klawVersion, klawMethodText, KAuth …).
   주의: 판결문 화면·이력 저장·GDC 차감은 기존 흐름 그대로다. 이 파일은 그 흐름을 순서대로 호출하고 보고만 한다.
   ═════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var ALLOWED_ORIGINS = ['https://naviweb.kr', 'https://www.naviweb.kr', 'https://mail.hondi.net'];
  var CASE_RE = /^\d{2,4}[가-힣]{1,4}\d{1,7}$/;
  var LEVEL_LABEL = { supreme: '대법원', appeal: '2심', first: '1심' };
  var CAP = 30000;   // 판결문 한 건당 AI 에 넣는 글자 수 상한(길면 앞부분)

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function stamp() { var d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }

  var params = new URLSearchParams(location.search);
  var wantAssist = params.get('assist') === '1';
  var S = { caseNo: '', files: [], docs: {}, out: {}, stage: 0, running: false, urls: [] };

  /* ───────── 화면 ───────── */
  var panel, logEl, headEl, stepEl, actEl;
  function css() {
    if ($('assist-css')) return;
    var st = document.createElement('style'); st.id = 'assist-css';
    st.textContent = '#assist-panel{border:1px solid var(--bdr,#e5e7eb);border-radius:12px;background:var(--sur,#fff);margin:0 0 16px;overflow:hidden}' +
      '#assist-panel .as-hd{display:flex;align-items:center;gap:10px;padding:12px 16px;background:var(--bg,#f8f9fa);border-bottom:1px solid var(--bdr,#e5e7eb)}' +
      '#assist-panel .as-hd b{font-size:14px}#assist-panel .as-step{margin-left:auto;font-size:12px;color:var(--txt3,#6b7280)}' +
      '#assist-panel .as-log{max-height:340px;overflow:auto;padding:12px 16px;font-size:13px;line-height:1.7;color:var(--txt2,#374151)}' +
      '#assist-panel .as-row{display:flex;gap:10px;margin:0 0 6px}#assist-panel .as-t{flex:none;color:var(--txt4,#9ca3af);font-size:11.5px;padding-top:2px}' +
      '#assist-panel .as-row.err{color:#b91c1c}#assist-panel .as-row.ok .as-m::before{content:"✓ ";color:#2baa74;font-weight:700}' +
      '#assist-panel .as-links{display:flex;gap:8px;flex-wrap:wrap;margin-top:3px}#assist-panel .as-links a{font-size:12px;color:var(--blue,#3b82f6);text-decoration:underline}' +
      '#assist-panel .as-act{padding:10px 16px;border-top:1px solid var(--bdr,#e5e7eb);display:flex;gap:8px;flex-wrap:wrap;align-items:center}' +
      '#assist-panel .as-act:empty{display:none}#assist-panel input[type=text]{padding:7px 10px;border:1px solid var(--bdr,#e5e7eb);border-radius:6px;font-size:13px;min-width:200px}' +
      '#assist-panel .as-note{font-size:12px;color:var(--txt3,#6b7280)}';
    document.head.appendChild(st);
  }
  function mountPanel() {
    if (panel) return;
    css();
    panel = document.createElement('section'); panel.id = 'assist-panel'; panel.setAttribute('aria-label', '나비웹 도우미 진행 상황');
    panel.innerHTML = '<div class="as-hd"><b>나비웹 도우미</b><span id="as-head" class="as-note"></span><span class="as-step" id="as-step"></span></div>' +
      '<div class="as-log" id="as-log" aria-live="polite"></div><div class="as-act" id="as-act"></div>';
    var host = document.querySelector('.content') || document.body;
    host.insertBefore(panel, host.firstChild);
    logEl = $('as-log'); headEl = $('as-head'); stepEl = $('as-step'); actEl = $('as-act');
  }
  function say(text, o) {
    o = o || {}; mountPanel();
    var row = document.createElement('div'); row.className = 'as-row' + (o.err ? ' err' : '') + (o.ok ? ' ok' : '');
    var body = '<div class="as-m">' + esc(text) + '</div>';
    if (o.links && o.links.length) body += '<div class="as-links">' + o.links.map(function (l) { return '<a href="' + esc(l.url) + '" target="_blank" rel="noopener" download="' + esc(l.name) + '">' + esc(l.label) + '</a>'; }).join('') + '</div>';
    row.innerHTML = '<span class="as-t">' + stamp() + '</span><div>' + body + '</div>';
    logEl.appendChild(row); logEl.scrollTop = logEl.scrollHeight;
    return row;
  }
  function live(text) { // 같은 줄을 갱신하는 진행 표시
    if (!live.row) live.row = say(text);
    else live.row.querySelector('.as-m').textContent = text;
    logEl.scrollTop = logEl.scrollHeight;
  }
  live.end = function () { live.row = null; };
  function setStep(n, total, label) { mountPanel(); stepEl.textContent = '단계 ' + n + '/' + total + (label ? ' · ' + label : ''); }
  function actions(nodes) { mountPanel(); actEl.innerHTML = ''; (nodes || []).forEach(function (n) { actEl.appendChild(n); }); }
  function btn(label, fn, primary) { var b = document.createElement('button'); b.type = 'button'; b.className = 'btn' + (primary ? ' btn-primary' : ''); b.textContent = label; b.onclick = fn; return b; }
  function docLink(name, label, text) {
    var url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })); S.urls.push(url);
    return { url: url, name: name, label: label };
  }

  /* ───────── AI 호출 ───────── */
  async function llm(messages, max, opt) {
    opt = opt || {};
    var onChunk = function (d, full) { live((opt.label || '작성 중') + ' · ' + full.length.toLocaleString('ko-KR') + '자'); };
    var out = await callLLMStream(messages, max, onChunk, { forceProTier: !!opt.pro });
    if (!String(out || '').trim()) out = await callLLMStream(messages, Math.round(max * 1.6), onChunk, { forceProTier: true });
    live.end();
    if (!String(out || '').trim()) throw new Error('AI 응답이 두 번 모두 비어 있습니다.');
    return out;
  }
  function clip(t, n) { t = String(t || ''); return t.length > n ? t.slice(0, n) + '\n…(이하 생략)' : t; }

  /* ───────── 단계 정의 ───────── */
  /* 이력(내 판결 이력)에 사건번호와 확보한 문서들을 남긴다 — 본인 이력에서 탭별로 다시 열람한다 */
  function saveDocs() {
    var id = window._klawCurrentSessionId;
    if (!id || typeof KAuth === 'undefined' || !KAuth.getToken) return Promise.resolve();
    var cut = function (t) { return String(t || '').slice(0, 150000); };
    var docs = {
      v: 1, case_no: window._klawAssistCaseNo || '',
      judgments: (S.out.judgments || []).map(function (f) { return { level: f.level, court: f.court || '', case_no: f.caseNo || '', text: cut(f.text) }; }),
      integrated: cut(S.out.int),
      update: S.out.update ? { status: 'proposed', text: cut(S.out.update), at: new Date().toISOString() } : { status: 'none' }
    };
    return fetch(KLAW_API_BASE + '/klaw/sessions/visibility', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, phone_verify_token: KAuth.getToken(), case_no: window._klawAssistCaseNo || '', case_docs: JSON.stringify(docs) }) }).catch(function () { /* 이력 저장 실패는 진행을 막지 않는다 */ });
  }

  var STAGES = [
    { id: 'fetch', name: '판결문 확보', run: stageFetch },
    { id: 'anon', name: '익명화', run: stageAnon },
    { id: 'int', name: '통합 판결문', run: stageInt },
    { id: 'verdict', name: '가상 판결문', run: stageVerdict },
    { id: 'eval', name: '일치도 평가', run: stageEval },
    { id: 'update', name: '방법론 갱신 제안', run: stageUpdate },
  ];

  async function stageFetch() {
    var got = S.files.filter(function (f) { return f && f.text && f.text.length > 300; });
    if (!got.length) {
      say('사건번호 ' + S.caseNo + '의 판결문을 법제처 판례 API에서 가져오고 있습니다.');
      var tok = KAuth.getToken ? KAuth.getToken() : '';
      var r = await fetch(KLAW_API_BASE + '/klaw/case-judgments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ case_no: S.caseNo, phone_verify_token: tok }) });
      var j = await r.json().catch(function () { return {}; });
      if (r.ok && j.ok && j.levels && j.levels.length) {
        got = j.levels.map(function (l) { return { level: l.level, court: l.court, caseNo: l.case_no, text: l.text, body: l.body }; });
        (j.notes || []).forEach(function (n) { say(n); });
      } else {
        say('판결문을 자동으로 가져오지 못했습니다' + (j && (j.message || j.detail) ? ' (' + (j.message || j.detail) + ')' : '') + '.', { err: true });
        got = await askFiles();
      }
    }
    S.out.judgments = got;
    var links = got.map(function (f) { return docLink('판결문_' + (LEVEL_LABEL[f.level] || f.level) + '_' + (f.caseNo || '') + '.txt', (LEVEL_LABEL[f.level] || f.level) + (f.caseNo ? ' ' + f.caseNo : ''), f.text); });
    say('판결문 ' + got.length + '건을 확보했습니다: ' + got.map(function (f) { return (LEVEL_LABEL[f.level] || f.level) + (f.court ? '(' + f.court + ')' : ''); }).join(', ') + '.', { ok: true, links: links });
    if (!got.some(function (f) { return f.level === 'appeal'; }) || !got.some(function (f) { return f.level === 'first'; }))
      say('1심 또는 2심 판결문이 없습니다. 원심 판결문이 일부 없어도 판결문 생성은 가능하지만, 1~3심 판결문을 모두 반영한 경우보다 통합 판결문에 담기는 법리가 줄어 가상 판결문의 일치도가 떨어질 수 있습니다.');
  }

  function askFiles() {
    return new Promise(function (resolve) {
      say('대법원 판결문과 1~2심 판결문 파일(txt·md)을 첨부해 주세요. 한 번에 여러 개를 고를 수 있고, 파일 이름에 "대법원"·"2심"·"1심"이 있으면 심급을 알아봅니다.');
      var inp = document.createElement('input'); inp.type = 'file'; inp.multiple = true; inp.accept = '.txt,.md,text/plain';
      var go = btn('첨부한 파일로 계속', async function () {
        var fs = Array.prototype.slice.call(inp.files || []);
        if (!fs.length) { say('파일을 먼저 선택해 주세요.', { err: true }); return; }
        var out = [];
        for (var i = 0; i < fs.length; i++) {
          var t = await fs[i].text(), n = fs[i].name;
          var lv = /대법|supreme/i.test(n) ? 'supreme' : /2심|항소|appeal/i.test(n) ? 'appeal' : /1심|first/i.test(n) ? 'first' : (i === 0 ? 'supreme' : i === 1 ? 'appeal' : 'first');
          out.push({ level: lv, court: '', caseNo: '', text: t, body: t });
        }
        actions([]); resolve(out);
      }, true);
      actions([inp, go]);
    });
  }

  async function stageAnon() {
    var js = S.out.judgments, pick = function (lv) { var f = js.filter(function (x) { return x.level === lv; })[0]; return f ? clip(f.body || f.text, CAP) : ''; };
    var src = ['supreme', 'appeal', 'first'].map(function (lv) { var t = pick(lv); return t ? '[' + LEVEL_LABEL[lv] + ' 판결문]\n' + t : ''; }).filter(Boolean).join('\n\n');
    say('DeepSeek V4 Flash로 사실관계를 추출하고 있습니다(판결 결과를 암시하는 내용은 제외).');
    var facts = await llm([{ role: 'user', content:
      '아래 판결문(들)에서 "사건의 사실관계"만 추출하세요.\n- 포함: 당사자와 지위, 거래·행위의 경과(시간순), 처분·기소 경위, 양측 주장\n- 제외: 법원의 판단·이유·결론·주문, 법령 해석, 판결 결과를 짐작하게 하는 표현(예: 유죄, 기각, 책임이 인정), 법령명과 쟁점 해설\n- 사실과 주장을 구분하고, 다툼이 있는 사실은 "~라고 주장" 형태로 적으세요.\n\n' + src }], 9000, { label: '사실관계 추출 중' });
    say('DeepSeek V4 Flash로 익명화 작업을 진행하고 있습니다.');
    var anon = await llm([{ role: 'user', content:
      '아래 사건 개요를 익명화·변형하세요.\n- 실명·법인명·지명·물품·수량·일시를 모두 가상의 값으로 바꾸고(갑·을·병, A사 등), 실제 사건과 대조해도 알아볼 수 없게 하세요.\n- 법적 구조(당사자의 지위, 권한·책임 관계, 절차, 업무 범위)는 바꾸지 마세요.\n- 새 사실을 추가하거나 결론·법령명·쟁점 해설을 넣지 마세요.\n- 결과는 사건 개요 본문만 출력하세요(머리말·설명 없이).\n\n' + facts }], 9000, { label: '익명화 중' });
    S.out.anon = anon.trim();
    say('익명화가 완료되었습니다.', { ok: true, links: [docLink('사건개요_익명화_' + S.caseNo + '.md', '익명화된 사건 개요', S.out.anon), docLink('사실관계_추출_' + S.caseNo + '.md', '추출한 사실관계(익명화 전)', facts)] });
  }

  async function stageInt() {
    var js = S.out.judgments;
    var src = js.map(function (f) { return '[' + (LEVEL_LABEL[f.level] || f.level) + ' 판결문' + (f.caseNo ? ' ' + f.caseNo : '') + ']\n' + clip(f.text, CAP); }).join('\n\n');
    say('DeepSeek V4 Pro로 통합 판결문을 작성하고 있습니다.');
    var prompt = '당신은 한국 법원 판결 분석가입니다. 아래 [익명화된 사건 개요]에 대한 "통합 판결문"을 작성하세요. 통합 판결문은 실제 1·2·3심 판결을 종합한 정답 판결문입니다.\n' +
      '작성 원칙:\n1. 사실 인정은 사건 개요에 있는 사실만 씁니다(개요에 없는 사실은 쓰지 않습니다).\n2. 법리는 각 심급이 설시한 것을 종합합니다. 1심이 놓쳤거나 상고심이 다루지 않은 쟁점도 포함합니다.\n3. 결과는 확정된 최종 결과를 씁니다. 형량·구체 금액은 정하지 않습니다.\n4. 인명·지명은 개요의 가상 표기(갑·을·병, A사 등)를 그대로 씁니다. 실제 이름·실제 사건번호를 쓰지 않습니다.\n' +
      '5. 판결문 뒤에 "부록: 법리 체크리스트"를 만듭니다. 채점 대상인 법리 항목(L1, L2, …)과 참고만 하는 사실의존 항목(F1, F2, …)으로 나누고, 항목마다 한 줄로 기준을 씁니다. 이 부록은 평가용입니다.\n\n' +
      '[익명화된 사건 개요]\n' + S.out.anon + '\n\n[참고: 실제 판결문들(이 내용을 그대로 옮기지 말고 법리만 종합하세요)]\n' + src;
    S.out.int = (await llm([{ role: 'user', content: prompt }], 24000, { pro: true, label: '통합 판결문 작성 중' })).trim();
    say('통합 판결문 작성이 완료되었습니다.', { ok: true, links: [docLink('통합판결문_' + S.caseNo + '.md', '통합 판결문(부록 포함)', S.out.int)] });
  }

  var judgePromise = null, judgeWrapped = false;
  function wrapHooks() {
    if (judgeWrapped) return; judgeWrapped = true;
    var origJ = window.runJudgementSim;
    window.runJudgementSim = function () { judgePromise = origJ.apply(this, arguments); return judgePromise; };
    var origP = window.updateProgressToast;
    window.updateProgressToast = function (done, total, label) {
      try { if (S.running && S.stage === 3) live(done >= total ? '가상 판결문 생성을 마쳤습니다.' : '현재 ' + (label || 'STEP') + ' 진행 중… ' + done + '/' + total + ' 완료'); } catch (e) { /* 표시만 */ }
      return origP.apply(this, arguments);
    };
  }
  async function stageVerdict() {
    wrapHooks();
    if (typeof cmSwitchTab === 'function') { try { cmSwitchTab('single'); } catch (e) { /* 이미 단일 */ } }
    if (typeof selectLLM === 'function') selectLLM('deepseek');
    $('case-input').value = S.out.anon;
    judgePromise = null;
    say('K-Law ' + klawVersion + '과 DeepSeek V4 Pro로 가상 판결문을 생성하고 있습니다. 먼저 사건을 분석합니다.');
    await runSimulation();
    if (conversationState.phase === 'chatting') { say('K-Law가 추가 질문을 했지만 익명화된 개요 외 정보가 없어 "추가 정보 없이 진행"으로 이어 갑니다.'); autoRunSim(); }
    var t0 = Date.now(); while (!judgePromise && Date.now() - t0 < 25000) await sleep(200);
    if (!judgePromise) throw new Error('판결문 생성이 시작되지 않았습니다. 화면의 오류 안내(로그인·GDC 잔액 등)를 확인해 주세요.');
    await judgePromise; live.end();
    var v = String(window._verdictText || '');
    if (v.length < 500) throw new Error('가상 판결문이 비어 있거나 너무 짧습니다.');
    S.out.verdict = v;
    var cnt = (v.match(/\[STEP-[0ABC](?:-[A-Z0-9-]+)?-COMPLETE/g) || []).length;
    say('가상 판결문 생성이 완료되었습니다(완결 표시 ' + cnt + '/4).', { ok: true, links: [docLink('가상판결문_' + S.caseNo + '.md', '가상 판결문 전문', v)] });
  }

  async function stageEval() {
    say('통합 판결문과 비교해 일치도 평가를 진행합니다(법리 한정).');
    setMatchMode('integrated');
    $('match-eval-input').value = S.out.int;
    var before = window._matchEvalText || '';
    live('일치도 평가 중…');
    var iv = setInterval(function () { var el = $('match-eval-live-text'); if (el && el.textContent) live('일치도 평가 중 · ' + el.textContent.slice(-60).replace(/\s+/g, ' ')); }, 1500);
    try { await runMatchEvaluation(); } finally { clearInterval(iv); live.end(); }
    var rep = String(window._matchEvalText || '');
    if (!rep || rep === before) throw new Error('일치도 평가 보고서를 받지 못했습니다.');
    S.out.eval = rep;
    var m = rep.match(/\[항목:\s*종합 일치도\]\s*\[점수:\s*([\d.]+%)\]/);
    say('일치도 평가가 완료되었습니다' + (m ? ' (종합 일치도 ' + m[1] + ')' : '') + '. 결과는 사용 이력에도 저장됩니다.', { ok: true, links: [docLink('일치도평가_' + S.caseNo + '.md', '일치도 평가 보고서', rep)] });
  }

  async function stageUpdate() {
    say('DeepSeek V4 Pro로 방법론 갱신 제안을 작성하고 있습니다.');
    var prompt = '당신은 K-Law 방법론 관리자입니다. 아래 [일치도 평가 보고서]에서 드러난 문제를 바탕으로, 현재 방법론([K-Law 방법론 ' + klawVersion + ' 원문])의 갱신안을 제안하세요.\n' +
      '규칙:\n- 제안은 최대 5개. 각 제안마다 (1) 변경할 위치(공리·강제규칙·단계 이름) (2) 현행 내용 요지 (3) 제안 문안(그대로 넣을 수 있는 문장) (4) 근거(평가 보고서의 어느 항목·문장) (5) 과적합 위험을 쓰세요.\n- 이 사건에만 해당하는 사실에 의존한 제안은 제외하세요(방법론은 일반 원리·원칙이어야 합니다).\n- 평가 보고서에 근거가 없는 제안은 쓰지 마세요.\n- 개선 필요성이 없으면 "갱신 불필요"라고 쓰고 이유를 적으세요.\n\n' +
      '[일치도 평가 보고서]\n' + clip(S.out.eval, 40000) + '\n\n[K-Law 방법론 ' + klawVersion + ' 원문]\n' + clip(typeof klawMethodText === 'string' ? klawMethodText : '', 60000);
    S.out.update = (await llm([{ role: 'user', content: prompt }], 12000, { pro: true, label: '갱신 제안 작성 중' })).trim();
    say('방법론 갱신 제안이 작성되었습니다. 방법론 파일에 반영하려면 관리자의 검토·승인이 필요합니다(이 제안서를 관리자에게 전달해 주세요).', { ok: true, links: [docLink('방법론갱신제안_' + S.caseNo + '.md', '방법론 갱신 제안서', S.out.update)] });
  }

  /* ───────── 실행 ───────── */
  async function runFrom(i) {
    S.running = true; actions([btn('중단', function () { S.abort = true; say('사용자가 중단했습니다.', { err: true }); }, false)]);
    S.abort = false;
    for (; i < STAGES.length; i++) {
      if (S.abort) break;
      S.stage = i; setStep(i + 1, STAGES.length, STAGES[i].name);
      try { await STAGES[i].run(); if (i >= 3) await saveDocs(); }
      catch (e) {
        live.end(); S.running = false;
        say(STAGES[i].name + ' 단계에서 멈췄습니다: ' + (e && e.message || e), { err: true });
        var k = i; actions([btn('이 단계부터 다시 시도', function () { runFrom(k); }, true)]);
        return;
      }
    }
    S.running = false;
    if (!S.abort) {
      setStep(STAGES.length, STAGES.length, '완료');
      say('모든 과정을 마쳤습니다. 위 문서 링크는 이 창을 닫으면 사라집니다. 사건 개요·판결문·평가·갱신 제안은 "판결 이력"에서 사건번호를 눌러 탭별로 다시 볼 수 있습니다.', { ok: true });
    }
    actions([]);
  }

  function start(caseNo, files) {
    caseNo = String(caseNo || '').replace(/\s+/g, '');
    mountPanel();
    if (!CASE_RE.test(caseNo) && !(files && files.length)) { say('사건번호 형식이 올바르지 않습니다. 예: 2024도7082', { err: true }); return manualForm(); }
    if (S.running) return;
    S.caseNo = caseNo || '첨부'; S.files = files || []; S.out = {}; S.abort = false;
    window._klawAssistCaseNo = /^\d{2,4}[가-힣]{1,4}\d{1,7}$/.test(String(caseNo || '').replace(/\s+/g, '')) ? String(caseNo).replace(/\s+/g, '') : '';
    headEl.textContent = '사건번호 ' + S.caseNo;
    say('도우미를 시작합니다. 사건번호 ' + S.caseNo + ' — 판결문 확보부터 방법론 갱신 제안까지 진행합니다. 가상 판결문 생성에는 GDC가 사용량만큼 차감됩니다.');
    say('안내: 판결문은 매번 새로 익명화한 뒤(실명·법인명·지명·물품·수량·일시를 가상 값으로 변경) 가상 판결문을 생성합니다. 그래서 같은 판례를 여러 사용자가 같은 AI로 생성하더라도, AI가 그 사건을 기억하고 있는지와 관계없이 입력에는 원래 사건을 알아볼 단서가 없어 판결문 생성에 영향을 주지 않도록 했습니다.');
    runFrom(0);
  }

  function manualForm() {
    mountPanel();
    var inp = document.createElement('input'); inp.type = 'text'; inp.placeholder = '대법원 사건번호 예: 2024도7082'; inp.setAttribute('aria-label', '사건번호');
    var go = btn('도우미 시작', function () { start(inp.value, []); }, true);
    actions([inp, go]);
  }

  /* adopt 가 없는 구버전 인증 모듈용: hondi_pvt / hondi_pvt_exp 쿠키(.hondi.net)를 심고, 작업 내용을 잠시 보관한 채 새로고침 */
  var PEND_KEY = 'klaw-assist-pending';
  function cookieAdopt(m) {
    var tok = String(m.token || ''), exp = Number(m.exp);
    if (tok.length < 20 || tok.length > 4000 || !(exp > Date.now() + 60000)) return false;
    try {
      var age = Math.min(Math.floor((exp - Date.now()) / 1000), 86400 * 30);
      var dom = /(^|\.)hondi\.net$/.test(location.hostname) ? '.hondi.net' : location.hostname;
      document.cookie = 'hondi_pvt=' + encodeURIComponent(tok) + '; domain=' + dom + '; path=/; max-age=' + age + '; secure; samesite=lax';
      document.cookie = 'hondi_pvt_exp=' + encodeURIComponent(String(exp)) + '; domain=' + dom + '; path=/; max-age=' + age + '; secure; samesite=lax';
      sessionStorage.setItem(PEND_KEY, JSON.stringify({ at: Date.now(), caseNo: String(m.caseNo || ''), files: Array.isArray(m.files) ? m.files.slice(0, 3) : [] }));
      location.reload();
      return true;
    } catch (e) { return false; }
  }
  function takePending() {
    try { var r = sessionStorage.getItem(PEND_KEY); sessionStorage.removeItem(PEND_KEY); var j = r && JSON.parse(r); return j && Date.now() - j.at < 120000 ? j : null; } catch (e) { return null; }
  }

  /* ───────── 나비웹에서 넘겨받기 ───────── */
  function listenHandoff() {
    mountPanel(); setStep(0, STAGES.length, '대기'); headEl.textContent = '나비웹에서 정보를 받는 중…';
    var done = false;
    window.addEventListener('message', function (ev) {
      var m = ev.data;
      if (done || ALLOWED_ORIGINS.indexOf(ev.origin) < 0 || ev.source !== window.opener || !m || m.type !== 'klaw-assist-start') return;
      done = true;
      var ok = false;
      try { ok = typeof KAuth.adopt === 'function' && KAuth.adopt(String(m.token || ''), Number(m.exp)); } catch (e) { ok = false; }
      // 인증 모듈(hondi.net)이 아직 adopt 를 갖추지 못한 경우: 같은 쿠키 규칙으로 직접 심고 이 창을 다시 읽는다
      if (!ok && typeof KAuth.adopt !== 'function' && cookieAdopt(m)) return;
      if (!ok) {
        // adopt 가 없거나(인증 모듈 갱신 전) 토큰이 맞지 않으면, 이미 이 사이트에 로그인돼 있는지 본다
        if (!(KAuth.hasValidLogin && KAuth.hasValidLogin())) say('나비웹의 로그인 정보를 받지 못했습니다. 이 창에서 로그인한 뒤 아래에서 시작해 주세요.', { err: true });
      } else say('나비웹의 로그인 정보로 이 창을 열었습니다(다시 인증하지 않아도 됩니다).', { ok: true });
      var files = (Array.isArray(m.files) ? m.files : []).slice(0, 3).map(function (f) { return { level: ['supreme', 'appeal', 'first'].indexOf(f.level) >= 0 ? f.level : 'supreme', court: '', caseNo: '', text: String(f.text || '').slice(0, 400000), body: String(f.text || '').slice(0, 400000) }; });
      if (KAuth.hasValidLogin && KAuth.hasValidLogin()) start(m.caseNo, files); else manualForm();
    });
    var tries = 0, ping = setInterval(function () {
      if (done || ++tries > 20) { clearInterval(ping); if (!done) { say('나비웹에서 정보가 오지 않았습니다. 사건번호를 직접 입력해 시작할 수 있습니다.'); manualForm(); } return; }
      ALLOWED_ORIGINS.forEach(function (o) { try { window.opener.postMessage({ type: 'klaw-assist-ready' }, o); } catch (e) { /* 다른 출처로는 전달되지 않는다 */ } });
    }, 700);
  }

  function init() {
    if (!wantAssist) return;
    // 판결문 생성에 쓰는 전역이 모두 준비된 뒤 시작한다
    var t0 = Date.now();
    (function wait() {
      if (typeof runSimulation === 'function' && typeof KAuth !== 'undefined' && $('case-input')) {
        var pend = takePending();
        if (pend && KAuth.hasValidLogin && KAuth.hasValidLogin()) {
          mountPanel(); say('나비웹의 로그인 정보로 이 창을 열었습니다(다시 인증하지 않아도 됩니다).', { ok: true });
          start(pend.caseNo, (pend.files || []).map(function (f) { var t = String(f.text || '').slice(0, 400000); return { level: ['supreme', 'appeal', 'first'].indexOf(f.level) >= 0 ? f.level : 'supreme', court: '', caseNo: '', text: t, body: t }; }));
        } else if (window.opener) listenHandoff(); else { mountPanel(); say('나비웹 도우미입니다. 대법원 사건번호를 입력하면 판결문 확보부터 방법론 갱신 제안까지 진행합니다.'); manualForm(); }
      } else if (Date.now() - t0 < 15000) setTimeout(wait, 200);
    })();
  }
  window.KlawAssist = { start: start, state: S };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
