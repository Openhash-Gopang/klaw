// klaw_pipeline_shared.mjs — klaw_runner.mjs와 klaw_reconcile_runner.mjs가 공유하는 채점·방법론
// 탐지 로직. (klaw_check_runner.mjs는 채점을 하지 않으므로 이 모듈을 쓰지 않는다.)
//
// 왜 분리했는가(2026-09-30): classify()·extractOrder()·lastMatch()·resolveLatestMethod()가
// klaw_runner.mjs와 klaw_reconcile_runner.mjs 두 곳에 글자 그대로 복사돼 있었다. 지금은 내용이
// 같지만, 채점 규칙(예: classify()의 결론 유형 분류)이 나중에 바뀔 때 한쪽만 고치고 다른 쪽을
// 깜빡하면 "생성 단계 채점"과 "재검토 단계 채점"이 조용히 어긋나는 위험이 있다 — K-Law-Check가
// v17.0.4에 멈춰 있다가 §7-3·STEPVSC를 몰랐던 것과 같은 종류의 "환류 안 된 변경" 문제다.
// 두 스크립트의 CLI 진입점·재실행(resume) 로직·API 키 분리는 그대로 유지하고, 순수 판정
// 로직만 이 모듈로 옮겨 두 스크립트가 반드시 같은 소스를 참조하게 한다.
//
// 이 파일은 저장소 루트를 현재 작업 디렉터리(cwd)로 실행되는 것을 전제로 한다
// (resolveLatestMethod()가 '.'에서 klaw_v*.md를 스캔) — 기존 두 스크립트와 동일한 가정.

import fs from 'node:fs';
import path from 'node:path';

// ── 채점 규칙(label_civil.ps1과 같은 규칙) ─────────────
// v17.0.3(절차적 주문 어휘 전면 폐지) 이후 K-Law 출력은 "원고 전부승소/일부승소/
// 원고 패소(=피고 승소)" 또는(형사) "피고인 유죄/무죄"로만 결론을 표시한다.
// 이 새 포맷은 binary 'v3'로 표시하고, dev.csv의 실제 라벨(유지/파기, 절차적
// 주문 기반 역사적 기록)과는 척도가 다르므로 아래 correct 계산에서 자동
// 정오 비교 대상에서 제외한다 — 일치도 평가 기준 v3.0에 따라 사람이 법리·
// 승소 당사자·영역·수준을 직접 대조해야 한다(자동 비교 불가, 육안 확인 필요).
export function classify(o) {
  if (/원고\s*전부\s*승소/.test(o)) return ['원고전부승소', 'v3'];
  if (/원고\s*일부\s*승소/.test(o)) return ['원고일부승소', 'v3'];
  if (/원고\s*패소|피고\s*승소/.test(o)) return ['원고패소', 'v3'];
  if (/피고인\s*무죄/.test(o)) return ['피고인무죄', 'v3'];
  if (/피고인\s*유죄/.test(o)) return ['피고인유죄', 'v3'];
  // ── 이하 구 포맷(절차적 주문) 하위호환 — v17.0.2 이하 과거 결과 재채점 전용.
  //    v17.0.3 이후 정상 실행에서는 도달하지 않는 것이 정상이다.
  if (!/파기/.test(o)) {
    if (/상고를\s*(모두\s*)?각하/.test(o)) return ['상고각하', '유지'];
    if (/상고를\s*(모두\s*)?기각/.test(o)) return ['상고기각', '유지'];
    return ['확인필요', '확인필요'];
  }
  if (/이송한다/.test(o)) return ['파기이송', '파기'];
  if (/환송한다/.test(o)) {
    if (/^(1\.\s*)?원심판결을\s*파기하고,?\s*(이\s*)?사건을/.test(o) && !/상고를\s*(모두\s*)?기각/.test(o)) return ['전부파기환송', '파기'];
    return ['일부파기환송', '파기'];
  }
  return ['파기자판', '파기'];
}

export function extractOrder(text) {
  const t = text.replace(/\*\*/g, '');
  // 라벨: 줄 첫머리의 "주 문:", "【주 문】", "이 유:" 등. 본문이 '이유'로 시작하는 문장은 걸리지 않도록 구분자를 요구한다.
  const re = /(?:^|\n)[ \t#*【\[]*(주\s*문|이\s*유)[ \t]*(?:[】\]]+[ \t]*[:：]?|[:：]|(?=[ \t]*(?:\n|$)))/g;
  const labels = []; let m;
  while ((m = re.exec(t))) labels.push({ kind: m[1].replace(/\s+/g, ''), idx: m.index, end: m.index + m[0].length });
  for (let i = labels.length - 1; i >= 0; i--) {
    if (labels[i].kind !== '주문') continue;
    const next = labels.slice(i + 1).find((l) => l.kind === '이유');
    if (next) return t.slice(labels[i].end, next.idx).replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  const last = [...labels].reverse().find((l) => l.kind === '주문');
  return last ? t.slice(last.end, last.end + 600).replace(/\s+/g, ' ').trim() : '';
}

export const lastMatch = (t, re) => {
  let m; let last = null;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(t))) last = m;
  return last ? last[1] : null;
};

// 버전 문자열("v17.0", "17.0", "klaw_v17_0.md" 등)에서 major.minor를 뽑아 비교 가능한
// 숫자로 변환한다. 파일명 자동탐지와 버전 불일치 경고(klaw_check_runner.mjs)가 모두
// 이 함수로 통일해 비교한다.
export function parseMajorMinor(s) {
  const m = String(s || '').match(/v?(\d+)[._](\d+)/i);
  return m ? parseFloat(`${m[1]}.${m[2]}`) : 0;
}

// 저장소 루트에서 주어진 접두사(prefix)_v[숫자_숫자].md 패턴 파일을 스캔해 버전 숫자가
// 가장 큰 파일을 자동 채택한다(benchmark.html·desktop.html·webapp.html의 GitHub API
// 버전 스캔과 같은 규칙을 로컬 파일시스템에 적용). 파일명은 내부 버전과 일치시키고,
// 버전이 바뀔 때마다 git mv로 파일명도 함께 갱신한다 — 그러면 이 함수를 쓰는 스크립트도
// 세 브라우저 앱도 코드 수정 없이 최신 버전을 자동으로 호출한다(구버전을 계속 부르는
// 사고를 방지하는 안전장치).
function resolveLatestVersionedFile(prefix, label) {
  const re = new RegExp(`^${prefix}_v[\\d_]+\\.md$`, 'i');
  const files = fs.readdirSync('.').filter((n) => re.test(n));
  if (!files.length) throw new Error(`저장소 루트에 ${prefix}_v*.md ${label} 파일이 없습니다.`);
  files.sort((a, b) => parseMajorMinor(b) - parseMajorMinor(a));
  return files[0];
}

// K-Law 본체 방법론(klaw_v[숫자_숫자].md, 예: klaw_v17_0.md) 자동탐지.
export function resolveLatestMethod() {
  return resolveLatestVersionedFile('klaw', '방법론');
}

// K-Law-Check 검수 SP(klaw_check_v[숫자_숫자].md, 예: klaw_check_v17_0.md) 자동탐지.
// 이 파일명의 버전은 검수 SP 자신의 개정 차수가 아니라 "이 SP가 검토·반영한 K-Law
// 본체 버전"을 나타낸다(klaw_check_v17_0.md 파일 상단 "파일명·버전 표기 규칙" 참조).
export function resolveLatestCheck() {
  return resolveLatestVersionedFile('klaw_check', 'K-Law-Check');
}
