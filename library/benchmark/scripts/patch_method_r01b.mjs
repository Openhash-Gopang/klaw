// patch_method_r01b.mjs — 개발 세트 1라운드 방법론 갱신 ②: STEP V(자기 검증·재검토 게이트) 신설
// 입력: method/dev/klaw_v15_1_r01.md (patch_method_r01.mjs의 결과)  출력: method/dev/klaw_v15_1_r01b.md  + patch_log.md 기록 추가
// 편집은 찾을 문장이 파일에 정확히 한 번 있어야만 적용된다. 실행: node patch_method_r01b.mjs [--in=...] [--out=...]
import fs from "node:fs"; import path from "node:path"; import crypto from "node:crypto";
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? true] : [a, true]; }));
const IN = args.in || "method/dev/klaw_v15_1_r01.md"; const OUT = args.out || "method/dev/klaw_v15_1_r01b.md";
const EDITS = [
 [
  "STEP V 신설: STEP B 직후 자기 검증·재검토 게이트(V-1~V-6, 재판단 강제)",
  "### STEP C – 검증 및 출력",
  "### STEP V – 자기 검증·재검토 게이트 (개발 세트 1라운드 갱신, STEP B 직후·STEP C 이전)\n\n목적: 자신이 낸 판결에서 확인 가능한 명백한 오류를 스스로 찾아 결론을 재검토하게 한다. \"이상 없음\"이라는 선언만으로는 이 단계를 끝낼 수 없다. 각 점검 항목에 '해당/비해당'과 그 근거가 된 **문장 인용**(STEP B 출력 또는 입력의 원심 판단 요지)을 적어야 한다. 자동 점검 결과가 함께 주어진 경우 발동된 항목은 반드시 '해당'으로 다루고 아래 [V-재판단]을 수행한다.\n\n**[V-1] 확신도-결론 정합성**\n- 종합 확신도가 5/10 이하인데 결론이 파기(환송·자판 포함)이거나 결론 유형이 '확정적'이면 해당. 낮은 확신은 원심 판단을 뒤집는 근거가 아니라, 원심 유지 방향 또는 '조건부·판단유보' 표시의 근거이다.\n- 원심과 반대 방향의 결론(B-8 '불일치')은 종합 확신도 7/10 이상일 때에만 확정적 결론으로 낸다. 미달이면 해당.\n\n**[V-2] 파기 근거의 입력 근거성**\n- 파기사유로 든 '원심의 오류' 하나하나에 대해, 입력의 원심 판단 요지에서 그 오류를 뒷받침하는 문장을 그대로 인용한다. 인용할 수 없으면 그 사유는 폐기한다(요지에 언급이 없다는 것, 0-1-π의 [추론] 항목, K-Law가 가정한 상고이유는 인용 근거가 될 수 없다).\n\n**[V-3] 자신이 배척한 반전 논거의 재판정**\n- B-6에서 배척한 반전 논거가 원심 유지(상고기각) 방향이고, 배척 이유가 '명시된 판단이 없다·입력에 없다' 유형이면 해당. 그 배척은 효력이 없으며, 그 논거를 살려 결론을 다시 판단한다.\n\n**[V-4] 법리오해 판정과 파기의 일치**\n- B-4-β에서 원심의 법리에 오해가 없다고 판정하고도 파기하는 경우, 파기의 독립 근거가 V-2를 통과했는지 확인한다. 통과하지 못하면 해당이며 결론은 상고기각으로 재판단한다.\n\n**[V-5] 복수 시나리오와 단일 결론**\n- B-6-π가 발동했는데 결론이 한 시나리오로만 확정되었으면 해당. 결론 유형을 '조건부'로 낮추고, 원심 유지에 해당하는 시나리오가 있으면 그것을 기본값으로 삼는다.\n\n**[V-6] 판결문 내부 정합성**\n- 주문의 범위(전부·일부, 파기·환송·기각)가 이유에서 든 사유와 일치하는지, 이유에 쓴 사실이 입력에 있는 사실인지 확인한다. 입력에 없는 사실을 근거로 삼았으면 해당이며 그 사실을 삭제하고 다시 판단한다.\n\n**[V-재판단]** (V-1~V-6 중 하나라도 '해당'이면 수행)\n(가) 해당 항목과 근거 인용, (나) 수정된 결론과 이유 요지, (다) 수정된 확신도, (라) 결론을 바꾸지 않는 경우에는 발동된 항목마다 그 지적이 틀린 이유를 인용과 함께 반박한다. 재판단은 결론을 강제로 바꾸는 절차가 아니라, 근거를 다시 확인하도록 강제하는 절차이다.\n마지막 줄에 최종 주문을 쓴다: 최종 주문: (변경 없음 | 주문 문장)\n이 단계에서 정한 최종 주문과 확신도가 이후 STEP C와 판결 요약에 적용된다.\n\n[STEP-V-COMPLETE | 점검 6항목 | 해당 N개 | 결론: 유지/변경]\n\n---\n\n### STEP C – 검증 및 출력"
 ]
];
if (!fs.existsSync(IN)) { console.error(`입력 파일이 없습니다: ${IN} (먼저 node patch_method_r01.mjs 를 실행하세요)`); process.exit(1); }
let s = fs.readFileSync(IN, "utf8"); const before = s;
for (const [name, find, repl] of EDITS) {
  const n = s.split(find).length - 1;
  if (n !== 1) { console.error(`중단: "${name}" — 찾을 문장이 ${n}번 나옵니다(정확히 1번이어야 함).`); process.exit(1); }
  s = s.replace(find, () => repl); console.log("적용: " + name);
}
fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, s, "utf8");
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex").slice(0, 16);
console.log(`\n${IN} (${before.length}자, sha256 ${sha(before)}) -> ${OUT} (${s.length}자, sha256 ${sha(s)}, +${s.length - before.length}자)`);
const log = path.join(path.dirname(OUT), "patch_log.md");
const entry = `\n## R01-b 갱신: 자기 검증 단계 (${new Date().toISOString().slice(0, 10)})\n- 배경: 사건 622917에서 종합 확신도 5/10, 법리오해 없음 판정, 배척한 반전 논거, 복수 시나리오 발동이라는 내부 모순 신호가 모두 있었는데도 파기환송 확정 결론이 나갔다. 기존 자기 검증 블록(A-8)은 형식 준수 확인이라 실질 오류를 잡지 못했다.\n- 변경: ${EDITS.map((e) => e[0]).join(" / ")}\n- 강제 방식: 실행기(klaw_runner.mjs)가 STEP B 직후 결정론적 점검을 돌려 파기 결론에서 V-1~V-5 신호가 잡히면 STEP V를 반드시 실행하고, V의 최종 주문을 결론으로 채택한다. 점검 전 결론과 후 결론을 모두 기록한다.\n- 출력 파일: ${OUT} (sha256 ${sha(s)})\n- 검증 계획: 표본 안 재실행으로 점검 전/후 일치 비교. 오답→정답 대비 정답→오답이 많으면 V 규칙(특히 V-1의 확신도 기준)을 완화 또는 폐기한다.\n`;
fs.appendFileSync(log, entry, "utf8"); console.log("패치 기록: " + log);
