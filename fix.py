# -*- coding: utf-8 -*-
"""
K-Law desktop.html 패치 — 판결문 생성(STEP 0/A/B/C) 실시간 스트리밍 표시

기존에는 각 STEP의 LLM 응답을 한 번에 받아서(non-streaming) 완료 후 통째로
렌더링했음 — 생성 중에는 스피너만 보이고 실제 내용은 완료돼야 나타남.

변경 사항:
1) _pumpSSE() / callLLMStream() 추가 — DeepSeek/Claude/Gemini/Groq 4개 제공자
   모두 SSE(Server-Sent Events) 스트리밍 응답을 파싱해 토큰이 도착하는 대로
   콜백(onChunk)을 호출. 각 제공자별 이벤트 포맷 차이(OpenAI 호환 delta.content,
   Claude의 content_block_delta, Gemini의 candidates 등) 처리.
2) renderStepStreaming()이 callLLMStream()을 사용하도록 변경 — STEP 카드 안에
   텍스트가 실시간으로 타이핑되듯 나타나고, 끝에 깜빡이는 커서 표시.
3) .stream-cursor CSS 추가 (깜빡이는 커서 애니메이션).

검증: SSE 파싱 로직에 대해 DeepSeek/Claude 포맷, UTF-8 멀티바이트 문자가 청크
경계에서 분할되는 경우, 스트림 중간 오류 이벤트, HTTP 레벨 오류 등 5개 케이스
단위 테스트 통과. renderStepStreaming() 전체 흐름(카드 생성 → 실시간 갱신 →
최종 렌더링 → STEP-COMPLETE 배지 추출)도 헤드리스 환경에서 시뮬레이션 검증 완료.
"""
import pathlib
import sys

TARGET = pathlib.Path("desktop.html")
if not TARGET.exists():
    print("[오류] desktop.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

src = TARGET.read_text(encoding="utf-8")
applied = []

# ── 패치 1: CSS — 스트리밍 커서 ──────────────────────────────
p1_old = '.step-body{font-size:13px;color:var(--txt);line-height:1.85;white-space:pre-wrap}'
p1_new = '.step-body{font-size:13px;color:var(--txt);line-height:1.85;white-space:pre-wrap}\n.stream-cursor{display:inline-block;width:2px;height:1em;background:var(--pri);vertical-align:text-bottom;margin-left:1px;animation:cursorBlink .9s step-start infinite}\n@keyframes cursorBlink{50%{opacity:0}}'
if ".stream-cursor{" in src:
    applied.append("CSS: 스트리밍 커서 스타일 이미 존재 (건너뜀)")
elif p1_old in src:
    src = src.replace(p1_old, p1_new, 1)
    applied.append("CSS: 스트리밍 커서 스타일 추가")
else:
    print("[오류] 패치 1(CSS) 대상 문자열을 찾지 못했습니다.")
    sys.exit(1)

# ── 패치 2: JS — _pumpSSE / callLLMStream 추가 ───────────────
p2_old = "  const data = await resp.json();\n  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));\n  return data.choices?.[0]?.message?.content || '';\n}\n\n// ══ K-Law 버전 동적 로드"
p2_new = "  const data = await resp.json();\n  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));\n  return data.choices?.[0]?.message?.content || '';\n}\n\n// ══ 스트리밍 응답 (판결문 생성 STEP 카드용) ═══════════════════\n// onChunk(delta, fullTextSoFar)를 매 토큰 청크마다 호출하고, 최종 전체 텍스트를 반환.\nasync function _pumpSSE(response, handleJson) {\n  if (!response.ok) {\n    let errMsg = `HTTP ${response.status}`;\n    try { const errBody = await response.json(); errMsg = errBody.error?.message || errBody.message || errMsg; } catch(e) {}\n    throw new Error(errMsg);\n  }\n  const reader = response.body.getReader();\n  const decoder = new TextDecoder('utf-8');\n  let buf = '';\n  while (true) {\n    const { value, done } = await reader.read();\n    if (done) break;\n    buf += decoder.decode(value, { stream: true });\n    const lines = buf.split('\\n');\n    buf = lines.pop();\n    for (const line of lines) {\n      const t = line.trim();\n      if (!t.startsWith('data:')) continue;\n      const payload = t.slice(5).trim();\n      if (payload === '[DONE]') continue;\n      let json;\n      try { json = JSON.parse(payload); } catch(e) { continue; }\n      handleJson(json);\n    }\n  }\n}\n\nasync function callLLMStream(messages, maxTokens = 3000, onChunk) {\n  const model  = conversationState.llmModel || 'deepseek';\n  const apiKey = conversationState.apiKey;\n  let fullText = '';\n  const emit = (delta) => { if (delta) { fullText += delta; onChunk && onChunk(delta, fullText); } };\n\n  if (model === 'claude') {\n    const resp = await fetch('https://api.anthropic.com/v1/messages', {\n      method: 'POST',\n      headers: { 'Content-Type':'application/json', 'x-api-key':apiKey, 'anthropic-version':'2023-06-01' },\n      body: JSON.stringify({ model: conversationState.selectedModel || 'claude-sonnet-4-20250514', max_tokens:maxTokens, stream:true, messages:messages.filter(m=>m.role!=='system'), system:messages.find(m=>m.role==='system')?.content||'' })\n    });\n    await _pumpSSE(resp, (json) => {\n      if (json.type === 'error') throw new Error(json.error?.message || 'Claude 스트리밍 오류');\n      if (json.type === 'content_block_delta' && json.delta?.type === 'text_delta') emit(json.delta.text);\n    });\n    return fullText;\n  }\n  if (model === 'gemini') {\n    const gmsg = messages.filter(m=>m.role!=='system').map(m=>({role:m.role==='assistant'?'model':'user',parts:[{text:m.content}]}));\n    const sys  = messages.find(m=>m.role==='system')?.content || '';\n    const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${conversationState.selectedModel||'gemini-2.5-pro'}:streamGenerateContent?alt=sse&key=${apiKey}`,\n      {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({system_instruction:sys?{parts:[{text:sys}]}:undefined,contents:gmsg,generationConfig:{maxOutputTokens:maxTokens}})});\n    await _pumpSSE(resp, (json) => {\n      if (json.error) throw new Error(json.error.message || 'Gemini 스트리밍 오류');\n      emit(json.candidates?.[0]?.content?.parts?.[0]?.text || '');\n    });\n    return fullText;\n  }\n  if (model === 'groq') {\n    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {\n      method: 'POST',\n      headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey },\n      body: JSON.stringify({ model: conversationState.selectedModel || 'llama-3.3-70b-versatile', messages, max_tokens:maxTokens, temperature:0.2, stream:true })\n    });\n    await _pumpSSE(resp, (json) => {\n      if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));\n      emit(json.choices?.[0]?.delta?.content || '');\n    });\n    return fullText;\n  }\n  // DeepSeek — 사용자 본인 API Key 필요\n  const resp = await fetch(DEEPSEEK_ENDPOINT, {\n    method: 'POST',\n    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+apiKey },\n    body: JSON.stringify({ model: conversationState.selectedModel || 'deepseek-v4-pro', messages, max_tokens:maxTokens, temperature:0.2, stream:true })\n  });\n  await _pumpSSE(resp, (json) => {\n    if (json.error) throw new Error(json.error.message || JSON.stringify(json.error));\n    emit(json.choices?.[0]?.delta?.content || '');\n  });\n  return fullText;\n}\n\n// ══ K-Law 버전 동적 로드"
if "async function callLLMStream(" in src:
    applied.append("JS: callLLMStream() 이미 존재 (건너뜀)")
elif p2_old in src:
    src = src.replace(p2_old, p2_new, 1)
    applied.append("JS: _pumpSSE() / callLLMStream() 스트리밍 함수 추가")
else:
    print("[오류] 패치 2(JS - callLLMStream) 대상 문자열을 찾지 못했습니다.")
    sys.exit(1)

# ── 패치 3: JS — renderStepStreaming()이 스트리밍 사용하도록 변경 ─
p3_old = '  try {\n    const result = await callLLM(msgs, 3000);\n    window._verdictParts[stepDef.id] = result;\n    const bodyEl = document.getElementById(\'vsb-\' + stepDef.id);\n    if (bodyEl) bodyEl.innerHTML = `<div class="step-body">${escHtml(result)}</div>`;'
p3_new = '  try {\n    const bodyEl = document.getElementById(\'vsb-\' + stepDef.id);\n    let streamStarted = false;\n    const result = await callLLMStream(msgs, 3000, (delta, fullSoFar) => {\n      if (!streamStarted) {\n        streamStarted = true;\n        bodyEl.innerHTML = `<div class="step-body">${escHtml(fullSoFar)}<span class="stream-cursor"></span></div>`;\n      } else {\n        bodyEl.firstElementChild.firstChild.nodeValue = fullSoFar;\n      }\n    });\n    window._verdictParts[stepDef.id] = result;\n    if (bodyEl) bodyEl.innerHTML = `<div class="step-body">${escHtml(result)}</div>`;'
if "let streamStarted = false;" in src:
    applied.append("JS: renderStepStreaming() 스트리밍 연동 이미 존재 (건너뜀)")
elif p3_old in src:
    src = src.replace(p3_old, p3_new, 1)
    applied.append("JS: renderStepStreaming()이 callLLMStream() 사용하도록 변경")
else:
    print("[오류] 패치 3(JS - renderStepStreaming) 대상 문자열을 찾지 못했습니다.")
    sys.exit(1)

TARGET.write_text(src, encoding="utf-8")
print("[완료] desktop.html 패치 적용됨:")
for a in applied:
    print("  - " + a)
