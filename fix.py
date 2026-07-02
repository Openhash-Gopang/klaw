# -*- coding: utf-8 -*-
"""
서브도메인.openhash.kr / 서브도메인.gopang.net → 서브도메인.hondi.net 통일

이 스크립트는 현재 폴더(저장소 루트)를 재귀적으로 훑어서 아래 규칙을 적용합니다:

1) "서브도메인.openhash.kr" → "서브도메인.hondi.net"
   예) klaw.openhash.kr → klaw.hondi.net, law.openhash.kr → law.hondi.net,
       www.openhash.kr → www.hondi.net
2) "서브도메인.gopang.net" → "서브도메인.hondi.net"
   예) klaw.gopang.net → klaw.hondi.net
3) 순수 "gopang.net"(서브도메인 없음) → "hondi.net"
4) 순수 "openhash.kr"(서브도메인 없음)은 절대 건드리지 않음
   — 이건 별도 저장소를 가진 독립 도메인이기 때문.

특수 보호: 현재 폴더에 worker.js가 있으면(=gopang 저장소), 그 파일의
CORS 허용 목록 중 다음 부분은 의도적인 전환기간 조치이므로 절대 건드리지 않음:
  // ── 전환 기간 병행 허용 (gopang.net → hondi.net 301 리다이렉트 완료 후 제거) ──
  'https://gopang.net',
  'https://www.gopang.net',
그리고 'https://openhash.kr',(독립 도메인이므로 규칙4에 의해 어차피 안 건드려짐)

여러 번 실행해도 안전합니다(멱등).
"""
import re
import pathlib

SUBDOMAIN_KR  = re.compile(r'(?<![a-zA-Z0-9.\-])([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\.openhash\.kr(?![a-zA-Z0-9-])')
SUBDOMAIN_NET = re.compile(r'(?<![a-zA-Z0-9.\-])([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)\.gopang\.net(?![a-zA-Z0-9-])')
BARE_GOPANG   = re.compile(r'(?<![a-zA-Z0-9.\-])gopang\.net(?![a-zA-Z0-9-])')
# 와일드카드 서브도메인 표기(문서에서 `*.gopang.net` 형태로 등장) — 위 정규식은
# 마크다운 굵게(**text**)와의 충돌을 피하려 별표를 서브도메인 문자로 다루지
# 않으므로, 이 표기만 별도로 명시적 처리.
WILDCARD_NET = re.compile(r'(?<![a-zA-Z0-9])\*\.gopang\.net(?![a-zA-Z0-9-])')
WILDCARD_KR  = re.compile(r'(?<![a-zA-Z0-9])\*\.openhash\.kr(?![a-zA-Z0-9-])')

# worker.js에서 절대 건드리지 않을 줄 번호 (1-indexed) — gopang 저장소 전용.
WORKER_JS_PROTECTED_LINES = {13, 14, 15, 34}

SKIP_DIR_NAMES = {'.git', 'node_modules'}


def fix_file(path: pathlib.Path) -> bool:
    try:
        text = path.read_text(encoding='utf-8')
    except (UnicodeDecodeError, PermissionError):
        return False
    orig = text

    protect_lines = WORKER_JS_PROTECTED_LINES if path.name == 'worker.js' else set()

    lines = text.split('\n')
    for i, line in enumerate(lines):
        if (i + 1) in protect_lines:
            continue
        line = SUBDOMAIN_KR.sub(lambda m: f'{m.group(1)}.hondi.net', line)
        line = SUBDOMAIN_NET.sub(lambda m: f'{m.group(1)}.hondi.net', line)
        line = WILDCARD_KR.sub('*.hondi.net', line)
        line = WILDCARD_NET.sub('*.hondi.net', line)
        line = BARE_GOPANG.sub('hondi.net', line)
        lines[i] = line
    text = '\n'.join(lines)

    if text != orig:
        path.write_text(text, encoding='utf-8')
        return True
    return False


def main():
    root = pathlib.Path('.')
    changed = []
    self_path = pathlib.Path(__file__).resolve()
    for p in root.rglob('*'):
        if p.is_dir():
            continue
        if any(part in SKIP_DIR_NAMES for part in p.parts):
            continue
        if p.resolve() == self_path:
            continue
        if fix_file(p):
            changed.append(str(p))

    if changed:
        print(f"[완료] {len(changed)}개 파일 수정됨:")
        for c in changed:
            print("  - " + c)
    else:
        print("[안내] 변경 사항 없음 (이미 적용되었거나 대상이 없습니다).")


if __name__ == '__main__':
    main()
