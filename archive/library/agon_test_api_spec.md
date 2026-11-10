# Agon 테스트 결과 저장소 — API 설계안 (초안 v0.1)

`agon-test.html`에서 사용자가 실행한 테스트를 모아 "테스트 결과" 목록에 쌓기 위한 서버 측 저장소 설계입니다. 구현 전 검토용입니다.

## 1. 원칙

1. **API Key는 서버를 거치지 않는다.** LLM 호출 3단계(자료 작성 → 가상 판결 → 일치도 평가)는 브라우저가 사용자 Key로 직접 수행한다. Worker는 Key를 받지도, 저장하지도 않는다.
2. **Key 해시도 저장하지 않는다.** "본 사이트는 Key를 저장하지 않는다"는 안내와 일치시킨다. 따라서 "개요에 쓴 Key를 같은 사건의 판결에 쓰지 않는다"는 규칙은 한 번의 테스트 실행 안에서 브라우저가 강제하고, 실행 간 재사용은 서버가 막지 못한다(한계로 명시).
3. **판례 원문은 저장하지 않는다.** 사건번호와 공개 출처 링크만 보관한다. 사용자가 첨부한 파일 자체는 서버로 보내지 않는다.
4. **사용자 결과는 공식 라운드 기록과 분리한다.** 모든 기록에 `status`(기본 `unreviewed`)와 "사용자 자체 평가, 제3자 검증 전" 표시를 붙인다.
5. **작성자는 익명 코드로만 식별한다.** 계정·IP·Key 정보는 목록에 노출하지 않는다.

## 2. 구성

| 대상 | 저장소 | 비고 |
|---|---|---|
| 결과 메타데이터 | Cloudflare D1(또는 KV) | 건수가 적고 읽기가 많음. 검색용 `summary`·`keywords` 포함 |
| 생성 문서(개요, 쉬운 설명, 원고·피고 논거, 표준 판결문, 가상 판결문, 평가) | Cloudflare R2 | 문서 단위 객체. 열람은 `doc.html?src=` 뷰어 |
| 작성자 코드 서명 | Worker 비밀값 `AUTHOR_HMAC_SECRET` | 코드 위조 방지 |

R2 객체 키: `agon-test/{record_id}/{kind}.md` (`kind` = overview, easy, plaintiff, defendant, standard, verdict, evaluation)

## 3. 작성자 코드

- 최초 방문 시 `POST /api/agon-test/author` → `{ "author": "A-K7M2QX", "token": "<서명>" }`.
- `token = HMAC(AUTHOR_HMAC_SECRET, author)`. 브라우저는 둘 다 localStorage에 보관한다.
- 결과 등록 시 `author`와 `token`을 함께 보내고, Worker가 서명을 검증한다. 코드(`author`)만으로는 등록할 수 없으므로 남의 코드 도용이 막힌다. 목록 조회·검색은 코드만으로 가능(공개).
- 다른 기기에서 "내 테스트"를 관리하려면 코드와 토큰을 함께 옮겨야 한다. 토큰을 잃으면 새 코드를 발급한다.

## 4. 엔드포인트

### `POST /api/agon-test/author`
작성자 코드·토큰 발급. 요청 본문 없음. IP당 시간당 5회 제한.

### `POST /api/agon-test/results`
테스트 1건 등록.

```json
{
  "author": "A-K7M2QX",
  "token": "…",
  "case_no": "2026다300001",
  "id": "621985",
  "source_url": "https://glaw.scourt.go.kr/...",
  "decided_on": "2026-09-18",
  "published_on": "2026-09-25",
  "summary": "자동차보험 자기차량손해보험에서 …(익명화된 개요 요지, 300자 이내)",
  "keywords": "보험자대위 자기부담금",
  "grade": "일치 | 잠정 일치 | 불일치",
  "score": "8/10",
  "method_version": "Agon 0.3",   // 필수. 이 사건에 적용한 Agon 버전
  "models": { "key1": "deepseek-v4-pro", "key2": "claude-sonnet-5-5" },
  "docs": {
    "overview": "…", "easy": "…", "plaintiff": "…", "defendant": "…",
    "standard": "…", "verdict": "…", "evaluation": "…"
  },
  "refs": { "supreme": "https://…", "second": "https://…", "first": "https://…" }
}
```

- `docs`의 각 값은 마크다운 텍스트(항목당 200KB 이하, 전체 1MB 이하). Worker가 R2에 저장하고 결과 조회 시 문서 URL로 바꿔 돌려준다.
- 검증: 서명, 필수 필드(`method_version` 포함, `^Agon \d+(\.\d+)*$` 형식), 크기, `models.key1 == models.key2`(같은 모델이면 경고만 표시, 거부하지 않음), `published_on`이 6개월을 넘으면 `warnings: ["older_than_6_months"]`를 붙인다.
- 응답: `201 { "record_id": "…", "status": "unreviewed", "warnings": [] }`
- 제한: 작성자당 하루 20건, IP당 시간당 30건.

### `GET /api/agon-test/results`
목록 조회. `agon-test.html`이 읽는 JSON과 같은 형태(`id, case_no, date, author, grade, score, summary, keywords, docs{…URL}`)를 배열로 반환한다. 쿼리: `author=A-K7M2QX`, `since=2026-10-01`, `limit`(기본 200). 자연어 검색은 지금처럼 브라우저가 수행한다(건수가 수천을 넘으면 서버 측 검색으로 전환).

### `GET /api/agon-test/stats/by-version`
Agon 버전별 집계. `author`, `status` 쿼리로 범위를 좁힐 수 있다.

```json
[{ "method_version": "Agon 0.3", "n": 12, "match": 7, "provisional": 2, "mismatch": 3,
   "avg_score10": 7.1, "scored": 12, "match_rate": 0.75 }]
```

`avg_score10`은 `score`("8/10" 등)를 10점 만점으로 환산한 단순 평균, `match_rate`는 (일치 + 잠정 일치) / 평가 완료 건수이다. 화면의 "Agon 버전별 일치도" 표가 같은 값을 보여 준다(현재는 브라우저에서 계산).

### `GET /api/agon-test/results/{record_id}`
단건 조회(메타데이터 + 문서 URL).

### `GET /api/agon-test/docs/{record_id}/{kind}`
R2 문서를 `text/markdown; charset=utf-8`로 반환. 공개 캐시 가능.

### 운영자 전용 (`Authorization: Bearer <ADMIN_TOKEN>`)
- `PATCH /api/agon-test/results/{record_id}` — `status`를 `unreviewed → reviewed | hidden`으로 변경.
- `DELETE /api/agon-test/results/{record_id}` — 기록과 R2 문서 삭제(작성자 본인 삭제 요청 처리용).

## 5. 상태와 표시

| status | 목록 표시 |
|---|---|
| `unreviewed` (기본) | 표시. "사용자 자체 평가 · 미검토" 배지 |
| `reviewed` | 표시. 운영자 검토 완료 배지 |
| `hidden` | 목록에서 제외(스팸·개인정보 포함 등) |

## 6. 프라이버시·보안

- 목록에는 `author` 코드만 노출한다. IP는 속도 제한 계산에만 쓰고 기록하지 않는다(해시 카운터를 TTL과 함께 KV에 둔다).
- 문서에 실명·주소 등 개인정보가 남아 있을 수 있으므로, 업로드 전 브라우저가 익명화 점검 문구를 보여 주고, 운영자는 `hidden` 처리할 수 있다.
- CORS: `https://klaw.hondi.net`만 허용. 쓰기 엔드포인트는 `Origin`을 검사한다.
- 본문 길이·JSON 구조를 엄격히 검증하고, `docs`는 마크다운 텍스트로만 저장·반환한다(HTML 렌더링 시 이스케이프 — `doc.html`이 이미 텍스트 뷰어로 동작하는지 구현 시 확인).

## 7. 프런트엔드 전환 계획

1. `agon-test.html`: `fetch('agon-test-results.json')`을 `fetch(API + '/api/agon-test/results')`로 교체. 실패 시 `agon-test-results.json`을 읽는 대체 경로를 유지한다.
2. 테스트 실행 코드: 3단계 완료 후 `POST /api/agon-test/results`로 등록하고, 응답의 `record_id`로 목록을 새로 고친다.
3. 첫 방문 시 `POST /api/agon-test/author`로 코드·토큰을 발급해 localStorage에 저장한다(현재의 무작위 코드를 대체).

## 8. 미결 사항

- D1과 KV 중 선택(검색·필터가 늘면 D1 권장).
- 운영자 검토 절차와 "reviewed"로 승격할 기준.
- 공식 라운드 기록(`rounds.html`)과의 관계(사용자 결과를 공식 통계에 포함하지 않는다는 원칙 유지).
- 같은 사건에 여러 사용자가 테스트한 결과의 묶음 표시 여부.
- 버전별 평균을 공식 라운드 기록(`rounds.html`)의 버전별 성적과 나란히 비교해 보여 줄지 여부(사용자 평가와 공식 평가는 기준이 달라 섞지 않는다).
- 실행 간 Key 재사용 방지를 하려면 Key 해시 저장이 필요하나, 현재는 저장하지 않기로 함.
