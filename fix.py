# -*- coding: utf-8 -*-
"""
K-Law desktop.html 패치 — 그동안 누락되었던 두 가지 수정을 하나로 합침

(참고: 이전에 스트리밍 패치는 정상 반영되었으나, 아래 두 가지는 파일 이동
경로 문제로 실제로는 적용되지 않은 채 남아 있었습니다.)

1) API Key "저장" 버튼 추가
   입력란 옆에 명시적 저장 버튼을 추가. 클릭 시 즉시 저장되고
   버튼에 "저장됨 ✓" 표시가 잠깐 나타남 (기존 자동 저장(oninput)은 유지).

2) API Key 입력값이 지워지는 경쟁 상태(race condition) 수정
   selectLLM()이 중복 호출될 때마다 무조건 입력란을 localStorage 값으로
   덮어써서, 페이지 초기화가 늦게 완료되면 사용자가 이미 입력한 키가
   지워지는 문제가 있었음. 실제로 제공자가 바뀐 경우에만 저장된 키를
   다시 불러오도록 수정 — 같은 제공자로 재호출되는 중복 초기화는
   입력란을 건드리지 않음.
"""
import pathlib
import sys

TARGET = pathlib.Path("desktop.html")
if not TARGET.exists():
    print("[오류] desktop.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

src = TARGET.read_text(encoding="utf-8")
applied = []

# ── 패치 1: HTML — 저장 버튼 추가 ──────────────────────────
html_old = """        <div class="api-key-row visible" id="api-key-section">
          <label class="api-key-label" id="api-key-label">DeepSeek API Key</label>
          <input class="api-key-input" type="password" id="api-key" placeholder="sk-…" oninput="saveApiKey(conversationState.llmModel||'deepseek', this.value)">
          <button type="button" onclick="openApiKeyHelp()" style="padding:6px 10px;border:1px solid var(--pri);border-radius:var(--r);background:none;color:var(--pri);font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">무료 API Key 발급 방법</button>
        </div>"""
html_new = """        <div class="api-key-row visible" id="api-key-section">
          <label class="api-key-label" id="api-key-label">DeepSeek API Key</label>
          <input class="api-key-input" type="password" id="api-key" placeholder="sk-…" oninput="saveApiKey(conversationState.llmModel||'deepseek', this.value)">
          <button type="button" id="api-key-save-btn" onclick="saveApiKeyClick()" style="padding:6px 10px;border:1px solid var(--pri);border-radius:var(--r);background:var(--pri);color:#fff;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">저장</button>
          <button type="button" onclick="openApiKeyHelp()" style="padding:6px 10px;border:1px solid var(--pri);border-radius:var(--r);background:none;color:var(--pri);font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap">무료 API Key 발급 방법</button>
        </div>"""

if 'id="api-key-save-btn"' in src:
    applied.append("HTML: 저장 버튼 이미 존재 (건너뜀)")
elif html_old in src:
    src = src.replace(html_old, html_new, 1)
    applied.append("HTML: API Key 저장 버튼 추가")
else:
    print("[오류] 패치 1(HTML) 대상 문자열을 찾지 못했습니다. 파일이 변경되었을 수 있습니다.")
    sys.exit(1)

# ── 패치 2: JS — saveApiKeyClick() 함수 추가 ────────────────
js_old = """function loadApiKey(model) {
  try { return localStorage.getItem(API_KEY_STORAGE_PREFIX + model) || ''; } catch(e) { return ''; }
}"""
js_new = """function loadApiKey(model) {
  try { return localStorage.getItem(API_KEY_STORAGE_PREFIX + model) || ''; } catch(e) { return ''; }
}

// "저장" 버튼 클릭 시 명시적으로 저장하고 버튼에 확인 표시
function saveApiKeyClick() {
  const model = conversationState.llmModel || 'deepseek';
  const input = document.getElementById('api-key');
  const key = input ? input.value.trim() : '';
  saveApiKey(model, key);
  const btn = document.getElementById('api-key-save-btn');
  if (!btn) return;
  if (btn._resetTimer) clearTimeout(btn._resetTimer);
  const original = btn.dataset.label || btn.textContent;
  btn.dataset.label = original;
  btn.textContent = key ? '저장됨 ✓' : '삭제됨';
  btn._resetTimer = setTimeout(() => { btn.textContent = original; }, 1200);
}"""

if "function saveApiKeyClick()" in src:
    applied.append("JS: saveApiKeyClick() 이미 존재 (건너뜀)")
elif js_old in src:
    src = src.replace(js_old, js_new, 1)
    applied.append("JS: saveApiKeyClick() 함수 추가")
else:
    print("[오류] 패치 2(JS) 대상 문자열을 찾지 못했습니다.")
    sys.exit(1)

# ── 패치 3: JS — selectLLM() 경쟁 상태 수정 ─────────────────
race_old = """function selectLLM(model) {
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
race_new = """function selectLLM(model) {
  const modelChanged = conversationState.llmModel !== model;
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
  // 실제로 제공자가 바뀐 경우에만 저장된 키를 불러옴 — 같은 제공자로 재호출될 때
  // (예: 페이지 초기화가 뒤늦게 한 번 더 실행되는 경우) 사용자가 이미 입력 중인 값을 덮어쓰지 않도록 함.
  if (modelChanged) apiInput.value = loadApiKey(model);
}"""

if "const modelChanged = conversationState.llmModel !== model;" in src:
    applied.append("JS: selectLLM() 경쟁 상태 수정 이미 존재 (건너뜀)")
elif race_old in src:
    src = src.replace(race_old, race_new, 1)
    applied.append("JS: selectLLM() 경쟁 상태 수정 (제공자 변경 시에만 키 재로드)")
else:
    print("[오류] 패치 3(JS - selectLLM) 대상 문자열을 찾지 못했습니다.")
    sys.exit(1)

TARGET.write_text(src, encoding="utf-8")
print("[완료] desktop.html 패치 적용됨:")
for a in applied:
    print("  - " + a)
