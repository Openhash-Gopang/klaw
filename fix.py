# -*- coding: utf-8 -*-
"""
K-Law 전체 파일 — gopang.net → hondi.net 도메인 정리

배경: gopang.net은 더 이상 사용되지 않으며, 관련 저장소(gopang/gopang_v2)의
CNAME도 이미 hondi.net으로 이전되어 있습니다. klaw 저장소 곳곳에 남아있던
gopang.net 참조를 hondi.net으로 정리합니다.

대상 및 영향:
- desktop.html, webapp.html, benchmark.html:
  <script type="module" src="https://gopang.net/auth/subsystem-auth.js">
  → 실제 인증 스크립트가 있는 위치(hondi.net)로 수정. 이전에는 존재하지
    않는 옛 주소를 요청해서 CORS 에러와 함께 로딩이 아예 실패했음.
- webapp.html: window.opener.postMessage(..., 'https://gopang.net') →
  'https://hondi.net' (팝업 연동 시 origin 불일치로 메시지가 전달되지
  않던 문제도 함께 해결)
- 나머지 파일들(business.html, report.html, dashboard.html, index.html,
  participation.html, klaw_intro.html, whitepaper.html): "고팡 앱" 링크,
  푸터의 "klaw.gopang.net" 표기 등 — 사용자에게 노출되는 링크/텍스트를
  hondi.net으로 정리.

10개 파일이 대상입니다. 각 파일은 개별적으로 이미 적용되어 있는지 확인 후
건너뛰므로 여러 번 실행해도 안전합니다.
"""
import pathlib
import sys

FILES = [
    "business.html", "report.html", "desktop.html", "dashboard.html",
    "index.html", "participation.html", "klaw_intro.html", "webapp.html",
    "whitepaper.html", "benchmark.html",
]

total_applied = 0
total_skipped = 0
total_missing = 0

for fname in FILES:
    p = pathlib.Path(fname)
    if not p.exists():
        print(f"[건너뜀] {fname} — 현재 폴더에 없음")
        total_missing += 1
        continue

    src = p.read_text(encoding="utf-8")

    if "gopang.net" not in src:
        print(f"[건너뜀] {fname} — gopang.net 참조 없음 (이미 정리됨)")
        total_skipped += 1
        continue

    new_src = src
    # 순서 중요: 더 구체적인 패턴부터 치환
    new_src = new_src.replace(
        'src="https://gopang.net/auth/subsystem-auth.js"',
        'src="https://hondi.net/auth/subsystem-auth.js"',
    )
    new_src = new_src.replace("'https://gopang.net'", "'https://hondi.net'")
    new_src = new_src.replace('"https://gopang.net/"', '"https://hondi.net/"')
    new_src = new_src.replace('"https://gopang.net"', '"https://hondi.net"')
    new_src = new_src.replace("(https://gopang.net)", "(https://hondi.net)")
    new_src = new_src.replace("klaw.gopang.net", "klaw.hondi.net")
    # 마지막으로 남은 gopang.net 문자열(링크 표시 텍스트 등)을 일괄 정리
    new_src = new_src.replace("gopang.net", "hondi.net")

    if new_src == src:
        print(f"[안내] {fname} — 변경 사항 없음")
        continue

    p.write_text(new_src, encoding="utf-8")
    print(f"[완료] {fname} — gopang.net → hondi.net 적용됨")
    total_applied += 1

print()
print(f"요약: 적용 {total_applied} / 이미 정리됨 {total_skipped} / 파일 없음 {total_missing}")

if total_missing == len(FILES):
    sys.exit(1)
