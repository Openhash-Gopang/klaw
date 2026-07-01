# -*- coding: utf-8 -*-
"""
K-Law 통합 패치 (이번 대화의 모든 수정 사항 포함)

[desktop.html]
1) API Key 재입력 요구 오류 수정 — runSimulation()이 #api-key 값을 읽지 않던 문제
2) 판결문 생성(STEP 0/A/B/C) 중 진행 상태 팝업 추가
3) 좌측 상단 "K-Law" 로고 전체(아이콘+텍스트)를 홈(klaw_intro.html) 링크로 통일
4) LLM API Key를 제공자별로 브라우저 localStorage에 저장 — 재방문 시 자동 입력

[index.html]
5) 루트(klaw.hondi.net) 접속 시 klaw_intro.html(인트로 페이지)로 연결되도록 수정
   — 기존에는 기기별로 desktop/webapp.html로 즉시 우회하던 오류

[benchmark.html]
6) 좌측 상단 "K-Law" 로고 → 홈(klaw_intro.html) 링크 추가 (기존엔 링크 자체가 없었음)
7) "입력 및 분석" / "일치도 이력" 탭 전환이 안 되는 것처럼 보이던 문제 수정
   (탭 active 상태 표시를 CSS 클래스 기반으로 통일)

각 패치는 개별적으로 이미 적용되어 있는지 확인 후 건너뛰므로, 여러 번 실행해도 안전합니다.
"""
import pathlib
import sys


def apply_patch(text, old, new, marker, label, applied_list):
    """marker가 이미 있으면 건너뛰고, old가 있으면 교체, 없으면 오류."""
    if marker in text:
        applied_list.append(f"{label} (이미 적용됨 — 건너뜀)")
        return text
    if old in text:
        applied_list.append(label)
        return text.replace(old, new, 1)
    print(f"[오류] 패치 대상 문자열을 찾지 못했습니다: {label}")
    sys.exit(1)


# ══════════════════════════════════════════════════════════════
# desktop.html
# ══════════════════════════════════════════════════════════════
DESK = pathlib.Path("desktop.html")
if not DESK.exists():
    print("[오류] desktop.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

d = DESK.read_text(encoding="utf-8")
d_applied = []

# D1: 진행 상태 팝업 CSS
_old = """.spinner{width:14px;height:14px;border:2px solid var(--bdr);border-top-color:var(--pri);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}"""
_new = """.spinner{width:14px;height:14px;border:2px solid var(--bdr);border-top-color:var(--pri);border-radius:50%;animation:spin .6s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* ── 판결문 생성 진행 상태 팝업 ── */
.progress-toast{
  display:none;position:fixed;right:20px;bottom:20px;z-index:900;
  background:var(--sur);border:1px solid var(--bdr);border-radius:12px;
  box-shadow:0 10px 32px rgba(0,0,0,.16);padding:14px 16px;width:280px;
}
.progress-toast.open{display:block;animation:toastIn .18s ease-out}
@keyframes toastIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.progress-toast-hd{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.progress-toast-title{font-size:12.5px;font-weight:700;color:var(--txt)}
.progress-toast-steps{display:flex;gap:5px;margin-bottom:8px}
.progress-toast-dot{flex:1;height:4px;border-radius:2px;background:var(--bdr)}
.progress-toast-dot.done{background:var(--pri)}
.progress-toast-dot.active{background:var(--pri);opacity:.5;animation:dotPulse 1s ease-in-out infinite}
@keyframes dotPulse{0%,100%{opacity:.35}50%{opacity:.9}}
.progress-toast-label{font-size:11.5px;color:var(--txt3);line-height:1.5}"""
d = apply_patch(d, _old, _new, ".progress-toast{", "desktop.html: 진행 상태 팝업 CSS 추가", d_applied)

# D2: 진행 상태 팝업 HTML 마크업
_old = """<body>

<div class="history-panel" id="klaw-history-panel">"""
_new = """<body>

<div class="progress-toast" id="progress-toast">
  <div class="progress-toast-hd">
    <div class="spinner"></div>
    <span class="progress-toast-title" id="progress-toast-title">판결문 생성 중…</span>
  </div>
  <div class="progress-toast-steps" id="progress-toast-steps"></div>
  <div class="progress-toast-label" id="progress-toast-label"></div>
</div>

<div class="history-panel" id="klaw-history-panel">"""
d = apply_patch(d, _old, _new, 'id="progress-toast"', "desktop.html: 진행 상태 팝업 HTML 마크업 추가", d_applied)

# D3: runSimulation() API Key 동기화
_old = """  document.getElementById('llm-section').classList.add('visible');
  if (!conversationState.llmModel) selectLLM('deepseek');

  const btn = document.getElementById('run-btn');
  btn.disabled = true; btn.textContent = '분석 중...';"""
_new = """  document.getElementById('llm-section').classList.add('visible');
  if (!conversationState.llmModel) selectLLM('deepseek');

  // API Key 동기화 — 이 입력란(#api-key)에서 값을 읽어와야 callLLM이 사용할 수 있음.
  // (기존에는 runJudgementSim에서만 읽어들여 여기서는 항상 빈 값으로 호출되어 재입력 오류가 발생했음)
  const apiKeyInput = document.getElementById('api-key');
  const apiKeyVal = apiKeyInput ? apiKeyInput.value.trim() : '';
  if (!apiKeyVal) { alert('선택한 LLM의 API Key를 입력해 주세요.\\n(아직 키가 없다면 "무료 API Key 발급 방법" 버튼을 참고하세요)'); return; }
  conversationState.apiKey = apiKeyVal;

  const btn = document.getElementById('run-btn');
  btn.disabled = true; btn.textContent = '분석 중...';"""
d = apply_patch(d, _old, _new, "apiKeyVal = apiKeyInput", "desktop.html: runSimulation() API Key 동기화", d_applied)

# D4: runJudgementSim() 진행 팝업 연동
_old = """  const baseCtx = conversationState.messages.filter(m=>m.role!=='system').map(m=>(m.role==='user'?'사용자: ':'K-Law: ')+m.content).join('\\n\\n');
  window._verdictParts = {};
  window._verdictCaseNo = caseNo;

  for (const stepDef of STEP_DEFS) {
    await renderStepStreaming(stepDef, baseCtx, caseNo, level);
  }"""
_new = """  const baseCtx = conversationState.messages.filter(m=>m.role!=='system').map(m=>(m.role==='user'?'사용자: ':'K-Law: ')+m.content).join('\\n\\n');
  window._verdictParts = {};
  window._verdictCaseNo = caseNo;

  showProgressToast();
  try {
    for (let i = 0; i < STEP_DEFS.length; i++) {
      updateProgressToast(i, STEP_DEFS.length, STEP_DEFS[i].title);
      await renderStepStreaming(STEP_DEFS[i], baseCtx, caseNo, level);
    }
    updateProgressToast(STEP_DEFS.length, STEP_DEFS.length, '완료');
  } finally {
    setTimeout(hideProgressToast, 900);
  }"""
d = apply_patch(d, _old, _new, "showProgressToast();", "desktop.html: runJudgementSim() 진행 팝업 연동", d_applied)

# D5: 진행 팝업 헬퍼 함수
_old = """async function renderStepStreaming(stepDef, baseCtx, caseNo, level) {"""
_new = """// ══ 판결문 생성 진행 상태 팝업 ══════════════════════════
function showProgressToast() {
  const t = document.getElementById('progress-toast');
  if (t) t.classList.add('open');
}

function updateProgressToast(doneCount, total, currentLabel) {
  const dotsEl = document.getElementById('progress-toast-steps');
  const labelEl = document.getElementById('progress-toast-label');
  const titleEl = document.getElementById('progress-toast-title');
  if (dotsEl) {
    dotsEl.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const dot = document.createElement('div');
      dot.className = 'progress-toast-dot' + (i < doneCount ? ' done' : (i === doneCount ? ' active' : ''));
      dotsEl.appendChild(dot);
    }
  }
  if (titleEl) titleEl.textContent = doneCount >= total ? '판결문 생성 완료' : `판결문 생성 중… (${doneCount + 1}/${total})`;
  if (labelEl) labelEl.textContent = currentLabel || '';
}

function hideProgressToast() {
  const t = document.getElementById('progress-toast');
  if (t) t.classList.remove('open');
}

async function renderStepStreaming(stepDef, baseCtx, caseNo, level) {"""
d = apply_patch(d, _old, _new, "function showProgressToast()", "desktop.html: 진행 팝업 헬퍼 함수 추가", d_applied)

# D6: 로고 전체를 홈 링크로 통일
_old = """  <div class="topbar-brand">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.5 9h15M3 18h18M7 9l-3 9M17 9l3 9"/></svg>
    <a href="klaw_intro.html" style="color:inherit;text-decoration:none">K-Law</a>
  </div>"""
_new = """  <a class="topbar-brand" href="klaw_intro.html" style="cursor:pointer">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.5 9h15M3 18h18M7 9l-3 9M17 9l3 9"/></svg>
    K-Law
  </a>"""
d = apply_patch(d, _old, _new, '<a class="topbar-brand" href="klaw_intro.html"', "desktop.html: 로고 아이콘까지 홈 링크에 포함", d_applied)

# D7: selectLLM()에 API Key localStorage 저장/복원 추가
_old = """function selectLLM(model) {
  conversationState.llmModel = model;
  document.querySelectorAll('.llm-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('card-' + model)?.classList.add('selected');
  ['deepseek','claude','gemini','groq'].forEach(m => {
    const n = document.getElementById('llm-nav-' + m);
    if (n) n.classList.toggle('active', m === model);
  });
  const apiSec = document.getElementById('api-key-section');
  const apiLabel = document.getElementById('api-key-label');
  const apiInput = document.getElementById('api-key');
  apiSec.classList.add('visible');
  const labels = {
    deepseek: 'DeepSeek API Key',
    claude:   'Anthropic API Key',
    gemini:   'Google API Key',
    groq:     'Groq API Key',
  };
  const phs = {
    deepseek: 'sk-…',
    claude:   'sk-ant-…',
    gemini:   'AIza…',
    groq:     'gsk_…',
  };
  apiLabel.textContent = labels[model] || 'API Key';
  apiInput.placeholder = phs[model] || 'API Key를 입력하세요';
}"""
_new = """// ══ API Key 브라우저 저장 (제공자별) ═══════════════════════
// 이 기기의 브라우저 localStorage에만 저장됨 — K-Law 서버로는 전송되지 않음.
const API_KEY_STORAGE_PREFIX = 'klaw_api_key_';
function saveApiKey(model, key) {
  try {
    if (key) localStorage.setItem(API_KEY_STORAGE_PREFIX + model, key);
    else localStorage.removeItem(API_KEY_STORAGE_PREFIX + model);
  } catch(e) {}
}
function loadApiKey(model) {
  try { return localStorage.getItem(API_KEY_STORAGE_PREFIX + model) || ''; } catch(e) { return ''; }
}

function selectLLM(model) {
  conversationState.llmModel = model;
  document.querySelectorAll('.llm-card').forEach(c => c.classList.remove('selected'));
  document.getElementById('card-' + model)?.classList.add('selected');
  ['deepseek','claude','gemini','groq'].forEach(m => {
    const n = document.getElementById('llm-nav-' + m);
    if (n) n.classList.toggle('active', m === model);
  });
  const apiSec = document.getElementById('api-key-section');
  const apiLabel = document.getElementById('api-key-label');
  const apiInput = document.getElementById('api-key');
  apiSec.classList.add('visible');
  const labels = {
    deepseek: 'DeepSeek API Key',
    claude:   'Anthropic API Key',
    gemini:   'Google API Key',
    groq:     'Groq API Key',
  };
  const phs = {
    deepseek: 'sk-…',
    claude:   'sk-ant-…',
    gemini:   'AIza…',
    groq:     'gsk_…',
  };
  apiLabel.textContent = labels[model] || 'API Key';
  apiInput.placeholder = phs[model] || 'API Key를 입력하세요';
  apiInput.value = loadApiKey(model);
}"""
d = apply_patch(d, _old, _new, "function saveApiKey(model, key)", "desktop.html: API Key localStorage 저장/복원 추가", d_applied)

# D8: API Key 입력란 oninput 저장 핸들러
_old = """          <input class="api-key-input" type="password" id="api-key" placeholder="sk-…">"""
_new = """          <input class="api-key-input" type="password" id="api-key" placeholder="sk-…" oninput="saveApiKey(conversationState.llmModel||'deepseek', this.value)">"""
d = apply_patch(d, _old, _new, 'oninput="saveApiKey(', "desktop.html: API Key 입력란 oninput 저장 핸들러 추가", d_applied)

# D9: 안내 문구 갱신
_old = """              시뮬레이션을 실행하려면 <b>각자 탑승할 자동차(LLM)의 API Key를 입력</b>해야 합니다 — K-Law는 자체 LLM 서버를 운영하지 않고, 입력하신 키는 브라우저나 서버에 보관되지 않습니다."""
_new = """              시뮬레이션을 실행하려면 <b>각자 탑승할 자동차(LLM)의 API Key를 입력</b>해야 합니다 — K-Law는 자체 LLM 서버를 운영하지 않습니다. 입력하신 키는 이 브라우저에만(localStorage) 저장되어 다음 방문 시 자동으로 채워지며, K-Law 서버로는 전송되지 않습니다. 공용 PC라면 브라우저 방문 기록 삭제 시 함께 삭제됩니다."""
d = apply_patch(d, _old, _new, "다음 방문 시 자동으로 채워지며", "desktop.html: API Key 안내 문구 갱신", d_applied)

# D10: 발급 안내 모달 문구 갱신
_old = """          ⚠️ 발급받은 API Key는 본인의 브라우저에만 임시로 보관되며 K-Law 서버로 전송되거나 저장되지 않습니다. 각 제공자의 요금 정책 및 무료 한도는 변경될 수 있으니 발급 페이지에서 최신 정보를 확인하세요."""
_new = """          ⚠️ 발급받은 API Key는 본인의 브라우저에만(localStorage) 보관되며 K-Law 서버로 전송되거나 저장되지 않습니다. 각 제공자의 요금 정책 및 무료 한도는 변경될 수 있으니 발급 페이지에서 최신 정보를 확인하세요."""
d = apply_patch(d, _old, _new, "본인의 브라우저에만(localStorage) 보관", "desktop.html: API Key 발급 안내 모달 문구 갱신", d_applied)

DESK.write_text(d, encoding="utf-8")
print("[완료] desktop.html 패치:")
for a in d_applied:
    print("  - " + a)


# ══════════════════════════════════════════════════════════════
# index.html
# ══════════════════════════════════════════════════════════════
IDX = pathlib.Path("index.html")
if not IDX.exists():
    print("[오류] index.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

i = IDX.read_text(encoding="utf-8")
i_applied = []

_old = """<script>
// 화면 크기·UA로 모바일/PC 분기 → 각 전용 페이지로 즉시 이동
(function(){
  var mobile = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent)
               || window.innerWidth < 768;
  location.replace(mobile ? 'webapp.html' : 'desktop.html');
})();
</script>"""
_new = """<script>
// 루트 접속 시 인트로 페이지로 이동 (기존: 기기별로 desktop/webapp로 즉시 우회하던 오류 수정)
(function(){
  location.replace('klaw_intro.html');
})();
</script>"""
i = apply_patch(i, _old, _new, "location.replace('klaw_intro.html')", "index.html: 루트 리다이렉트 → klaw_intro.html", i_applied)

IDX.write_text(i, encoding="utf-8")
print("[완료] index.html 패치:")
for a in i_applied:
    print("  - " + a)


# ══════════════════════════════════════════════════════════════
# benchmark.html
# ══════════════════════════════════════════════════════════════
BENCH = pathlib.Path("benchmark.html")
if not BENCH.exists():
    print("[오류] benchmark.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

b = BENCH.read_text(encoding="utf-8")
b_applied = []

# B1: 로고 → 홈 링크
_old = """<header class="topbar">
  <div class="topbar-brand">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.5 9h15M3 18h18M7 9l-3 9M17 9l3 9"/></svg>
    K-Law
  </div>"""
_new = """<header class="topbar">
  <a class="topbar-brand" href="klaw_intro.html" style="cursor:pointer">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18M4.5 9h15M3 18h18M7 9l-3 9M17 9l3 9"/></svg>
    K-Law
  </a>"""
b = apply_patch(b, _old, _new, '<a class="topbar-brand" href="klaw_intro.html"', "benchmark.html: 로고 → 홈 링크 추가", b_applied)

# B2: 탭 CSS 클래스 추가
_old = """.page-tab{padding:10px 16px;font-size:13px;color:var(--txt3);border-bottom:2px solid transparent;cursor:pointer;background:none;border-top:none;border-left:none;border-right:none;transition:color .12s,border-color .12s;font-family:var(--font)}
.page-tab:hover{color:var(--txt)}
.page-tab.active{color:var(--txt);border-bottom-color:var(--txt);font-weight:500}"""
_new = """.page-tab{padding:10px 16px;font-size:13px;color:var(--txt3);border-bottom:2px solid transparent;cursor:pointer;background:none;border-top:none;border-left:none;border-right:none;transition:color .12s,border-color .12s;font-family:var(--font)}
.page-tab:hover{color:var(--txt)}
.page-tab.active{color:var(--txt);border-bottom-color:var(--txt);font-weight:500}
.page-tab-pill{display:inline-flex;align-items:center;gap:6px;padding:7px 16px;border-radius:6px;border:none;cursor:pointer;background:#e5e7eb;color:#374151;font-size:13px;font-weight:700;font-family:var(--font);transition:background .15s,color .15s}
.page-tab-pill:hover{background:#d1d5db}
.page-tab-pill.active{background:#374151;color:#fff}
.page-tab-pill.active:hover{background:#374151}
.page-tab-pill-badge{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;background:rgba(55,65,81,.15);color:#374151;font-size:10px;font-weight:700;border-radius:9px;line-height:1}
.page-tab-pill.active .page-tab-pill-badge{background:rgba(255,255,255,.25);color:#fff}"""
b = apply_patch(b, _old, _new, ".page-tab-pill{", "benchmark.html: 탭 active 스타일 CSS 클래스 추가", b_applied)

# B3: 탭 HTML 마크업 교체
_old = """        <button class="page-tab active" id="tab-sim" onclick="window.switchBenchTab&&window.switchBenchTab('sim')">입력 및 분석</button>
        <button id="tab-history" onclick="window.switchBenchTab&&window.switchBenchTab('history')"
          style="display:inline-flex;align-items:center;gap:6px;
            padding:7px 16px;border-radius:6px;border:none;cursor:pointer;
            background:#374151;color:#fff;font-size:13px;font-weight:700;
            font-family:var(--font);transition:opacity .15s">
          일치도 이력
          <span id="bench-history-badge" style="
            display:inline-flex;align-items:center;justify-content:center;
            min-width:18px;height:18px;padding:0 5px;
            background:rgba(255,255,255,.25);color:#fff;
            font-size:10px;font-weight:700;border-radius:9px;line-height:1">0</span>
        </button>"""
_new = """        <button class="page-tab active" id="tab-sim" onclick="window.switchBenchTab&&window.switchBenchTab('sim')">입력 및 분석</button>
        <button class="page-tab-pill" id="tab-history" onclick="window.switchBenchTab&&window.switchBenchTab('history')">
          일치도 이력
          <span class="page-tab-pill-badge" id="bench-history-badge">0</span>
        </button>"""
b = apply_patch(b, _old, _new, 'class="page-tab-pill" id="tab-history"', "benchmark.html: 탭 HTML 마크업 교체", b_applied)

# B4: switchBenchTab() 로직 수정
_old = """window.switchBenchTab = function(tab) {
  const simTab   = document.getElementById('tab-sim');
  const histTab  = document.getElementById('tab-history');
  const content  = document.querySelector('.content');
  const histPanel = document.getElementById('bench-history-panel');
  const guide    = document.getElementById('bench-input-guide');

  if (tab === 'sim') {
    simTab.classList.add('active');
    histTab.style.opacity = '1';
    if (content)   content.style.display = '';
    if (histPanel) histPanel.style.display = 'none';
    if (guide)     guide.style.display = '';
  } else {
    simTab.classList.remove('active');
    histTab.style.opacity = '.75';
    if (content)   content.style.display = 'none';
    if (histPanel) histPanel.style.display = 'block';
    if (guide)     guide.style.display = 'none';
    renderBenchHistory();
  }
}"""
_new = """window.switchBenchTab = function(tab) {
  const simTab   = document.getElementById('tab-sim');
  const histTab  = document.getElementById('tab-history');
  const content  = document.querySelector('.content');
  const histPanel = document.getElementById('bench-history-panel');
  const guide    = document.getElementById('bench-input-guide');

  if (tab === 'sim') {
    simTab.classList.add('active');
    histTab.classList.remove('active');
    if (content)   content.style.display = '';
    if (histPanel) histPanel.style.display = 'none';
    if (guide)     guide.style.display = '';
  } else {
    simTab.classList.remove('active');
    histTab.classList.add('active');
    if (content)   content.style.display = 'none';
    if (histPanel) histPanel.style.display = 'block';
    if (guide)     guide.style.display = 'none';
    renderBenchHistory();
  }
}"""
b = apply_patch(b, _old, _new, "histTab.classList.add('active');", "benchmark.html: switchBenchTab() 탭 토글 로직 수정", b_applied)

BENCH.write_text(b, encoding="utf-8")
print("[완료] benchmark.html 패치:")
for a in b_applied:
    print("  - " + a)
