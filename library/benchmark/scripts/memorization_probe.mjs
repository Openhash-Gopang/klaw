// memorization_probe.mjs — "완전 일치" 사건(금액까지 정확히 일치)에 대해, 사건 사실관계를
// 전혀 주지 않고 사건번호·선고일만으로 모델이 결론·금액·법리를 "암기"해서 재현하는지 시험한다.
// K-Law 가상 판결을 생성한 것과 같은 API(DEEPSEEK_API_KEY)로 완전히 새로운 대화(사건 개요
// 미제공)를 열어 질의한다 — klaw_runner.mjs의 생성 파이프라인과는 무관한 독립 스크립트.
//
// 사용:
//   node library\benchmark\scripts\memorization_probe.mjs
//   (결과는 runs\memorization_probe\<id>.json 및 .md에 저장됨)
//
// 환경변수: DEEPSEEK_API_KEY (K-Law 본체 생성에 쓰는 것과 동일 키/모델로 질의 —
//   "같은 모델이 암기했는가"를 보는 것이므로 검수용 키가 아니라 생성용 키를 쓴다)

import fs from 'node:fs';
import path from 'node:path';

const KEY = process.env.DEEPSEEK_API_KEY;
if (!KEY) { console.error('DEEPSEEK_API_KEY 환경변수가 없습니다.'); process.exit(1); }

const URL = 'https://api.deepseek.com/chat/completions';
const MODEL = 'deepseek-flash';
const OUT = 'runs/memorization_probe';
fs.mkdirSync(OUT, { recursive: true });

// 시험 대상: 전체 라운드 중 "완전 일치"(금액까지 정확히 일치)로 확인된 2건.
// 사건 사실관계·당사자·청구원인은 일체 포함하지 않고, 사건번호·선고일만 제공한다.
const CASES = [
  {
    id: '619445',
    caseNo: '2024다324972',
    date: '2026. 4. 9.',
    // 채점 시 확인된 실제 정답(스크립트가 아니라 사람이 비교 참고용으로만 사용)
    groundTruth: {
      label: '상고기각(원고승계참가인 전부승소 유지)',
      amount: '91,803,279원',
      coreLogic: '채무자회생법 제399조 — 부인에 따른 원상회복 범위에 함께 소멸한 담보도 포함',
    },
  },
  {
    id: '621985',
    caseNo: '2025다220651',
    date: '2026. 5. 8.',
    groundTruth: {
      label: '상고 모두 기각(국가배상 일부 인용 유지)',
      amount: '위자료 합계 500만원(2심 400만원+1심 100만원)',
      coreLogic: '출국금지결정 본체는 재량 내 적법, 통지유예만 요건 미충족으로 위법',
    },
  },
];

const SYSTEM = '당신은 한국 법률 질의에 답하는 보조자입니다. 모르면 추측하지 말고 "모른다"고 답하세요.';

async function probe(c) {
  const userMsg = `대법원 ${c.caseNo} 판결(선고일 ${c.date})에 대해 알고 있는 내용을 설명해 주세요. 가능하다면 주문(결론), 인정된 손해배상액·채권액 등 구체적 금액, 핵심 법리를 포함해 주세요. 이 판결에 대해 모른다면 추측하지 말고 "모른다"고만 답하세요.`;
  console.log(`[질의] ${c.id} (${c.caseNo}, ${c.date}) ...`);
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: userMsg }],
      temperature: 0,
      max_tokens: 4000,
      stream: false,
    }),
  });
  if (!r.ok) { console.error(`[${c.id}] API 오류: ${r.status} ${await r.text()}`); return; }
  const j = await r.json();
  const content = j.choices?.[0]?.message?.content || '';
  fs.writeFileSync(path.join(OUT, `${c.id}.json`), JSON.stringify({ id: c.id, caseNo: c.caseNo, date: c.date, groundTruth: c.groundTruth, query: userMsg, response: content }, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT, `${c.id}.md`), `# 암기 질의 — ${c.id} (${c.caseNo}, ${c.date})\n\n## 질의\n${userMsg}\n\n## 모델 응답\n${content}\n\n## (참고용) 실제 정답\n- 결론: ${c.groundTruth.label}\n- 금액: ${c.groundTruth.amount}\n- 핵심 법리: ${c.groundTruth.coreLogic}\n`, 'utf8');
  console.log(`[완료] ${c.id} — 응답 ${content.length}자 저장됨`);
}

for (const c of CASES) {
  await probe(c);
}
console.log(`\n완료: ${OUT}`);
