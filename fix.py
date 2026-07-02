# -*- coding: utf-8 -*-
"""
K-Law desktop.html 패치 — API Key 저장 버튼이 안 보이는 진짜 원인 수정

이번엔 캐시도, 배포도, 코드 누락도 아니었습니다. 순수 레이아웃 계산 버그였습니다.

원인:
- .llm-grid가 3열(grid-template-columns:repeat(3,1fr))인데, 카드는
  DeepSeek/Claude/Gemini/Groq 4개입니다 — Groq가 나중에 4번째 제공자로
  추가되면서 그리드 열 수를 3→4로 안 늘렸습니다.
- 4개 카드가 3열에 들어가면서 4번째 카드(Groq)가 다음 줄로 밀려
  카드 영역이 2줄이 됩니다.
- 카드 2줄 + API Key 행(입력란+저장 버튼+발급방법 버튼)을 합친 실제 높이가
  부모 컨테이너 .llm-panel의 펼침 상태 높이(max-height:300px)를 초과해서,
  .llm-panel의 overflow:hidden에 의해 하단(API Key 행 일부 또는 전체)이
  잘려 화면에 안 보이게 됨.

수정:
1) .llm-grid: repeat(3,1fr) → repeat(4,1fr) — 카드 4개가 한 줄에 들어감
   (이러면 애초에 2줄이 될 일이 없음)
2) .llm-panel.visible max-height: 300px → 420px — 혹시 모를 좁은 화면에서의
   줄바꿈에도 여유를 두기 위한 안전 마진
"""
import pathlib
import sys

TARGET = pathlib.Path("desktop.html")
if not TARGET.exists():
    print("[오류] desktop.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

src = TARGET.read_text(encoding="utf-8")

old = """.llm-panel.visible{max-height:300px;opacity:1}
.llm-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:0}"""
new = """.llm-panel.visible{max-height:420px;opacity:1}
.llm-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0}"""

if "repeat(4,1fr)" in src and "max-height:420px" in src:
    print("[안내] 변경 사항이 없습니다 (이미 적용됨).")
elif old in src:
    src = src.replace(old, new, 1)
    TARGET.write_text(src, encoding="utf-8")
    print("[완료] desktop.html 패치 적용됨:")
    print("  - .llm-grid: 3열 → 4열 (카드 4개가 한 줄에 배치)")
    print("  - .llm-panel.visible max-height: 300px → 420px")
else:
    print("[오류] 패치 대상 문자열을 찾지 못했습니다. 파일이 변경되었을 수 있습니다.")
    sys.exit(1)
