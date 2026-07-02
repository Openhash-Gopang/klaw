# -*- coding: utf-8 -*-
"""
K-Law desktop.html 패치 — API Key 행의 "저장" 버튼이 안 보이는 문제 수정

원인: 캐시 문제가 아니었음 (원본 서버 콘텐츠는 정상 확인됨).
실제 원인은 레이아웃 클리핑:
  - .api-key-row는 flex-wrap 없이 label+input+저장+발급방법 4개 요소를
    한 줄에 강제로 배치하려 함.
  - 이 행의 부모 컨테이너 .llm-panel은 펼침 애니메이션(max-height transition)
    때문에 항상 overflow:hidden 상태를 유지함 (펼쳐진 상태에서도 오버라이드되지 않음).
  - 이 두 조건이 겹치면, 창 폭이 좁아지거나(예: 개발자 도구를 연 상태) 요소가
    하나 늘어나면(이번에 추가된 "저장" 버튼), 넘치는 요소가 부모의
    overflow:hidden에 의해 잘려서 "존재하지만 안 보이는" 상태가 됨.

수정: .api-key-row에 flex-wrap:wrap을 추가해 공간이 부족하면 다음 줄로
자연스럽게 넘어가도록 하고, 펼쳐진 상태의 max-height를 60px → 110px로
늘려 두 줄로 표시되어도 잘리지 않도록 함.
"""
import pathlib
import sys

TARGET = pathlib.Path("desktop.html")
if not TARGET.exists():
    print("[오류] desktop.html 파일을 현재 폴더에서 찾을 수 없습니다.")
    sys.exit(1)

src = TARGET.read_text(encoding="utf-8")

old = """.api-key-row{padding:12px 16px;border-top:1px solid var(--bdr);display:flex;align-items:center;gap:10px;max-height:0;overflow:hidden;transition:max-height .3s ease}
.api-key-row.visible{max-height:60px;overflow:visible}"""
new = """.api-key-row{padding:12px 16px;border-top:1px solid var(--bdr);display:flex;align-items:center;flex-wrap:wrap;gap:10px;max-height:0;overflow:hidden;transition:max-height .3s ease}
.api-key-row.visible{max-height:110px;overflow:visible}"""

if "flex-wrap:wrap;gap:10px;max-height:0;overflow:hidden;transition:max-height .3s ease}\n.api-key-row.visible{max-height:110px" in src:
    print("[안내] 변경 사항이 없습니다 (이미 적용됨).")
elif old in src:
    src = src.replace(old, new, 1)
    TARGET.write_text(src, encoding="utf-8")
    print("[완료] desktop.html 패치 적용됨: API Key 행에 flex-wrap 추가, 펼침 높이 확장 (60px→110px)")
else:
    print("[오류] 패치 대상 문자열을 찾지 못했습니다. 파일이 변경되었을 수 있습니다.")
    sys.exit(1)
