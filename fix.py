#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
fix_rightmenu_p3_recursive_accordion.py

계획서 P3: right-menu.html 렌더링/토글/검색 로직을 임의 깊이 트리 지원 재귀
방식으로 교체(순수 리팩토링 — 지금 당장 보이는 화면은 바뀌지 않음).

  - renderCategories(): 2단 고정 렌더링 -> renderNode() 재귀 렌더링
    (depth 0만 큰 아이콘, depth 1+는 leaf-item과 같은 스타일로 재사용)
  - toggleAcc(id): id 기반 -> key(경로 전체를 이어붙인 문자열) 기반으로 변경,
    서로 다른 상위 트리에 같은 id가 있어도 충돌하지 않도록 함
  - _reflowAncestorPanels() 신설: 중첩 아코디언에서 하위를 펼치고 접을 때
    이미 열려 있는 상위 패널들의 max-height를 다시 계산(안 하면 내용이
    잘리거나 빈 공간이 남는 버그 발생)
  - SEARCHABLE: 1단 items만 펼치던 방식 -> collectLeaves()로 깊이 무관하게
    리프만 재귀 수집(catLabel은 지금과 동일하게 최상위 카테고리명 유지,
    화면에 보이는 검색 결과는 변화 없음)

검증: jsdom으로 4단 깊이 가상 데이터(기관→중앙/지방→도청→시청→읍면동) 및
실제 운영 데이터(K-서비스 16개 등) 양쪽에서 렌더링·중첩 토글·검색 총 26개
케이스 확인 완료(2026-07-23).

이 패치만으로는 화면에 보이는 카테고리 구성이 바뀌지 않습니다 — 이후 P4
(기관 페르소나 계층 삽입)·P5(산업 페르소나 KSIC 계층 삽입)에서 이 재귀
렌더러 위에 실제 깊은 트리 데이터를 얹습니다.

대상 파일: right-menu.html (현재 디렉터리에 있어야 함)
전제조건: P1·P2 패치가 이미 적용된 상태(CATEGORIES 첫 항목이 'kservice')
실행: python fix.py  (right-menu.html과 같은 폴더에서)
"""
import sys
import pathlib

TARGET = pathlib.Path("right-menu.html")

OLD_SEARCHABLE = """const SEARCHABLE = CATEGORIES.flatMap(cat => cat.items.map(it => ({ ...it, catLabel: cat.name })));"""

NEW_SEARCHABLE = """// 리프(하위 items 없는 노드, 즉 실제 이동 가능한 항목)만 재귀적으로 모은다.
// 트리 깊이가 몇 단이든(카테고리→...→리프) 상관없이 검색 대상은 항상 리프뿐이며,
// catLabel은 지금까지와 동일하게 "최상위 카테고리명"으로 고정한다(중간 단계
// 이름까지 배지에 넣으면 화면이 복잡해지므로, 필요해지면 breadcrumb는
// leaf.path에서 별도로 뽑아 쓸 수 있게 남겨둔다).
function collectLeaves(node, rootCatName, path) {
  path = path ? [...path, node.name] : [node.name];
  const hasChildren = Array.isArray(node.items) && node.items.length > 0;
  if (!hasChildren) return [{ ...node, catLabel: rootCatName, path }];
  return node.items.flatMap(child => collectLeaves(child, rootCatName, path));
}
const SEARCHABLE = CATEGORIES.flatMap(cat => collectLeaves(cat, cat.name));"""

OLD_RENDER = """function renderCategories() {
  const catTiles = CATEGORIES.map(cat => `
    <div class="acc-item" data-id="${cat.id}">
      <button class="acc-header" onclick="toggleAcc('${cat.id}')" data-explain="${esc(cat.name + ' — ' + cat.desc + ' (눌러서 펼치기)')}">
        <span class="sys-icon"><svg viewBox="0 0 24 24">${ICONS[cat.icon] || ''}</svg></span>
        <span class="acc-header-text">
          <span class="sys-name">${cat.name}</span>
          <span class="sys-desc">${cat.desc}</span>
        </span>
        <svg class="acc-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="acc-panel">
        <div class="acc-panel-inner leaf-list">
          ${cat.items.map(it => leafRowHtml(it, false)).join('')}
        </div>
      </div>
    </div>`).join('');

  accList.innerHTML = catTiles;
  _bindExplainTargets(accList);
}
renderCategories();

// 카테고리 항목을 누르면 하위 목록이 아래로 펼쳐짐(아코디언). 여러 항목을 동시에 펼쳐둘 수 있음.
function toggleAcc(id) {
  const item  = accList.querySelector(`.acc-item[data-id="${id}"]`);
  if (!item) return;
  const panel = item.querySelector('.acc-panel');
  if (!panel) return; // K-Law는 펼칠 패널이 없음
  const open  = item.classList.contains('open');

  if (open) {
    item.classList.remove('open');
    panel.style.maxHeight = '0px';
  } else {
    item.classList.add('open');
    panel.style.maxHeight = panel.scrollHeight + 'px';
  }
}
window.toggleAcc = toggleAcc;"""

NEW_RENDER = """// 트리 노드 하나를 렌더링 — depth 0(카테고리 자신)만 큰 아이콘(sys-icon)을 달고,
// 그 아래 중간 노드(depth 1 이상, 예: "지방자치단체" > "제주특별자치도청" > "제주시청")는
// leaf-item과 동일하게 아이콘 없이 텍스트+화살표만 쓴다 — 깊이가 몇 단이든 재사용된다.
// path는 루트부터 이 노드까지의 id를 이어붙인 배열로, data-key(펼침 상태 추적용
// 고유 키)를 만드는 데 쓴다 — 서로 다른 상위 카테고리 아래에 같은 id를 쓰는 노드가
// 있어도(예: 기관 트리와 산업 트리에 우연히 같은 코드가 나오는 경우) key가 충돌하지
// 않도록 하기 위함이다.
function renderNode(node, path, depth) {
  const hasChildren = Array.isArray(node.items) && node.items.length > 0;
  if (!hasChildren) return leafRowHtml(node, false);

  const key = path.join('/');
  const iconHtml = depth === 0
    ? `<span class="sys-icon"><svg viewBox="0 0 24 24">${ICONS[node.icon] || ''}</svg></span>`
    : '';
  const descHtml = node.desc ? `<span class="sys-desc">${node.desc}</span>` : '';

  return `
    <div class="acc-item${depth > 0 ? ' sub' : ''}" data-key="${key}">
      <button class="acc-header" onclick="toggleAcc('${key}')" data-explain="${esc(node.name + (node.desc ? ' — ' + node.desc : '') + ' (눌러서 펼치기)')}">
        ${iconHtml}
        <span class="acc-header-text">
          <span class="sys-name">${node.name}</span>
          ${descHtml}
        </span>
        <svg class="acc-chevron" viewBox="0 0 24 24"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div class="acc-panel">
        <div class="acc-panel-inner leaf-list">
          ${node.items.map((child, i) => renderNode(child, [...path, child.id ?? i], depth + 1)).join('')}
        </div>
      </div>
    </div>`;
}

function renderCategories() {
  accList.innerHTML = CATEGORIES.map(cat => renderNode(cat, [cat.id], 0)).join('');
  _bindExplainTargets(accList);
}
renderCategories();

// 카테고리(및 하위 중간 노드)를 누르면 그 아래 목록이 펼쳐짐(아코디언, 깊이 무관).
// 여러 항목을 동시에 펼쳐둘 수 있다. 이미 펼쳐진 상위 노드 안에서 하위 노드를
// 펼치거나 접으면, 상위 패널의 max-height가 예전 값(하위가 접혀있던 시점의 높이)에
// 그대로 고정돼 있어 새로 늘어난/줄어든 내용이 잘리거나 빈 공간이 남는다 —
// 그래서 토글할 때마다 열려 있는 조상 패널들의 max-height를 전부 다시 재는
// _reflowAncestorPanels를 함께 호출한다.
function toggleAcc(key) {
  const item  = accList.querySelector(`.acc-item[data-key="${key}"]`);
  if (!item) return;
  const panel = item.querySelector('.acc-panel');
  if (!panel) return; // 리프는 펼칠 패널이 없음
  const open  = item.classList.contains('open');

  if (open) {
    item.classList.remove('open');
    panel.style.maxHeight = '0px';
  } else {
    item.classList.add('open');
    panel.style.maxHeight = panel.scrollHeight + 'px';
  }
  _reflowAncestorPanels(item);
}
window.toggleAcc = toggleAcc;

function _reflowAncestorPanels(el) {
  let node = el.parentElement;
  while (node && node !== accList) {
    if (node.classList && node.classList.contains('acc-panel')) {
      const ownerItem = node.parentElement; // 이 패널을 담고 있는 .acc-item
      if (ownerItem && ownerItem.classList.contains('open')) {
        node.style.maxHeight = node.scrollHeight + 'px';
      }
    }
    node = node.parentElement;
  }
}"""

REPLACEMENTS = [(OLD_SEARCHABLE, NEW_SEARCHABLE), (OLD_RENDER, NEW_RENDER)]


def main():
    if not TARGET.exists():
        print(f"[에러] {TARGET} 파일을 찾을 수 없습니다. right-menu.html이 있는 폴더에서 실행하세요.")
        sys.exit(1)

    text = TARGET.read_text(encoding="utf-8")

    if all(old not in text for old, _ in REPLACEMENTS):
        print("[스킵] 이미 패치가 적용되어 있습니다 (변경 없음).")
        return

    applied = 0
    for idx, (old, new) in enumerate(REPLACEMENTS, 1):
        if old not in text:
            if new in text:
                continue
            print(f"[에러] {idx}번째 원본 코드를 찾지 못했고, 적용된 흔적도 없습니다.")
            print("       right-menu.html이 이미 다른 방식으로 수정되었을 수 있습니다 — 수동 확인 필요.")
            print("       (P1·P2 패치가 먼저 적용된 상태인지도 확인해주세요)")
            sys.exit(1)
        count = text.count(old)
        if count != 1:
            print(f"[에러] {idx}번째 원본 코드가 {count}번 발견됨(정확히 1번이어야 함) — 수동 확인 필요.")
            sys.exit(1)
        text = text.replace(old, new)
        applied += 1

    TARGET.write_text(text, encoding="utf-8")
    print(f"[완료] right-menu.html 패치 적용됨 — 재귀 아코디언 컴포넌트로 교체({applied}건).")
    print("       화면상 카테고리 구성은 이전과 동일합니다(순수 리팩토링).")


if __name__ == "__main__":
    main()
