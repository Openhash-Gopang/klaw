# K-Law 검수 파이프라인 — 소유권·순서·파일 규약

이 문서는 `klaw_runner.mjs` → `klaw_check_runner.mjs` → `klaw_reconcile_runner.mjs` 세 스크립트가
어떤 순서로, 어떤 파일을 주고받으며, 무엇을 "이 사건의 최종 결과물"로 취급하는지를 한 곳에
정리한다. 지금까지 이 내용은 각 스크립트 상단 주석에 흩어져 있었다(2026-09-30 검토에서
지적됨). 작성 시점 기준 최신 방법론은 K-Law v17.0.8 / K-Law-Check v1.1이다.

---

## 1. 파이프라인 4단계

```
① klaw_runner.mjs           (생성 — DEEPSEEK_API_KEY)
   ├─ STEP 0 → A → B → C
   ├─ (STEP B 직후) lintB() 결정론적 점검 → 트리거 있으면 STEP V(자기 검증) 실행
   ├─ (항상) STEP V-공통점검(STEPVSC) 실행
   └─ STEP V·STEPVSC가 [최종 판결문 시작]...[최종 판결문 끝]을 냈다면
      self_check.final_text로 채택 → runs/<T>/<id>_final.txt 저장
        ↓ 산출물: runs/<T>/<id>.json, <id>.txt, (있으면) <id>_final.txt, results.csv

② klaw_check_runner.mjs     (독립 검수 — 기본 KLAW_CHECK_API_KEY, 가능하면 다른 모델)
   K-Law-Check(기본 klaw_check_v17_0.md, 자동탐지 — §5 참조)로 ①의 판결문 전문
   (STEP 0~C·STEP V·STEPVSC 전부 포함)을 별도 세션에서 사후 검수. M-1/M-1b/M-2/M-3 모듈.
        ↓ 산출물: runs/<T>-check/<id>.json(report 필드), results 없음(사건별 파일만)

③ klaw_reconcile_runner.mjs (재검토 — 기본 DEEPSEEK_API_KEY, ①과 같은 모델을 기본값으로 함)
   ②의 검수 보고서 원문을 K-Law 자신에게 돌려줘 항목별 [수용]/[반박] 판정을
   강제하고, ①의 self_check.final_text가 있으면 그것을 "현재 확정된 판결문"으로
   프롬프트에 명시한 뒤, 그 위에서 새로운 [최종 판결문 시작]...[최종 판결문 끝]을
   작성하게 한다.
        ↓ 산출물: runs/<T>-final/<id>.json, <id>.md, (있으면) <id>_final.txt, results.csv
```

**세 스크립트는 합쳐지지 않는다** — API 키 격리(②의 독립성 근거)와 단계별 재개(resume)
가능성(각 스크립트가 `--force` 없이는 이미 있는 `<id>.json`을 건너뜀) 때문에 의도적으로
분리돼 있다. 다만 `classify()`·`extractOrder()`·`lastMatch()`·`resolveLatestMethod()`는
①·③이 공유하는 채점 로직이라 `klaw_pipeline_shared.mjs`로 추출해 두 스크립트가 같은
소스를 import한다(2026-09-30) — 복사본을 유지하면 한쪽만 고치고 다른 쪽을 깜빡했을 때
채점이 조용히 어긋나는 위험이 있었다.

---

## 2. "최종 판결문" 소유권 — 어느 파일이 진짜 최종본인가

같은 이름의 파일(`<id>_final.txt`)이 **서로 다른 두 단계에서, 서로 다른 디렉터리에**
생성될 수 있다. 혼동하지 않으려면 디렉터리로 구분한다.

| 파일 | 만드는 스크립트 | 의미 |
|---|---|---|
| `runs/<T>/<id>_final.txt` | ① klaw_runner.mjs | **외부 검수 없이**, K-Law 자신의 lintB/STEP V/STEPVSC만으로 도달한 최종본. 검수를 거치지 않았다면 이것이 사실상 이 사건의 최종 결과물이다. |
| `runs/<T>-final/<id>_final.txt` | ③ klaw_reconcile_runner.mjs | **외부 검수(②)를 반영한 뒤**의 최종본. ①의 self_check.final_text가 있었다면 그 위에 추가로 정정한 것, 없었다면 STEP B(및 STEP V/VSC) 원본 위에 정정한 것이다. |

**둘 다 있다면 `runs/<T>-final/<id>_final.txt`가 더 나중 단계의 산출물**이다 — 파이프라인
순서상 ③은 항상 ①·②보다 뒤에 실행되고, ③의 프롬프트가 ①의 `self_check.final_text`를
"현재 확정된 판결문"으로 명시적으로 받아 그 위에서 재검토하도록 설계돼 있기 때문이다
(2026-09-30 수정 — 이전에는 ③이 이 필드를 전혀 읽지 않아 ①의 정정을 모른 채 처음부터
다시 검토하는 문제가 있었다). 검수(②)까지 거친 사건을 채점·감사할 때는 `-final` 디렉터리
쪽을 권위 있는 결과로 취급한다.

`klaw_runner.mjs`의 `results.csv`에는 `sc_final_source`(stepV/stepVSC/공란) 열이,
`klaw_reconcile_runner.mjs`의 `results.csv`에는 `reversed`(재검토로 결론이 번복됐는지) 열이
있다 — 두 결과를 사건 ID로 조인하면 "① 자기 검증만으로 정정됨" vs "③ 외부 검수까지
반영해 추가로 번복됨"을 구분할 수 있다.

---

## 3. 디렉터리·파일 명명 규약

기본값 기준(모두 `--out`/`--check`/`--out`(reconcile) 등으로 바꿀 수 있음):

```
runs/<TAG>/              ① klaw_runner.mjs 산출물
  <id>.json                전체 레코드(analysis, parts, self_check, predicted, config, usage…)
  <id>.txt                 사람이 읽기 좋은 전문(분석+STEP 0~C(+V/VSC))
  <id>_final.txt            (있으면) self_check.final_text만 담은 정정 반영본
  results.csv               라운드 전체 집계

runs/<TAG>-check/        ② klaw_check_runner.mjs 산출물 (기본: <TAG>-check, --out으로 변경 가능)
  <id>.json                 { report: "K-Law-Check 검수 보고서 전문" }
  <id>.md                   report와 동일 내용, md 확장자

runs/<TAG>-final/        ③ klaw_reconcile_runner.mjs 산출물 (기본: <TAG>-final, --out으로 변경 가능)
  <id>.json                 order_before/final, label_before/final, reversed, items(수용/반박), final_verdict, report
  <id>.md                    report 전문
  <id>_final.txt             (있으면) final_verdict만 담은 정정 반영본
  results.csv                라운드 전체 집계(id, label/binary before·final, reversed, items…)
```

`overview/<id>.json`(`overview_independent` 필드)은 세 스크립트 모두가 공통으로 읽는
입력이며, 어느 스크립트도 이 파일을 쓰지 않는다. `dev.csv`(사건 목록·실제 라벨)는 ①만
읽는다.

---

## 4. API 키 분리 규칙

| 변수 | 기본 사용처 | 기본값 스크립트 | 다른 값 지정 |
|---|---|---|---|
| `DEEPSEEK_API_KEY` | ① 생성, ③ 재검토(기본값) | `klaw_runner.mjs`, `klaw_reconcile_runner.mjs` | ③은 `--key-env=<다른 변수명>`으로 바꿀 수 있음 |
| `KLAW_CHECK_API_KEY` | ② 독립 검수 | `klaw_check_runner.mjs` | `--key-env=<다른 변수명>` |

②가 ①과 다른 변수명을 쓰는 것은 우연이 아니라 설계다 — 검수는 가능하면 다른
모델/제공사 키로 실행해 "같은 모델의 순수 자기 확인(에코 챔버)"이 되는 것을 피하기
위함이다(`klaw_check_v17_0.md` §0 참조). ③이 기본적으로 ①과 **같은** 키를 쓰는 것도
설계다 — 재검토·최종본 작성은 "저자 본인의 방법론 일관성"을 위해 원 생성 모델로
수행하는 것이 기본값이며, `--key-env=KLAW_CHECK_API_KEY`처럼 바꾸는 것은 "재검토를
검수와 같은 모델로 실험해 보고 싶을 때"의 예외적 옵션이다.

세 변수 모두 절대 파일·커밋에 남기지 않는다(레포 전역 규칙). GitHub Actions 등 CI에서
자동 실행하는 방안은 별도로 검토 중이며 이 문서의 범위 밖이다(비용·시크릿 유출 위험
때문에 공개 저장소의 포크 PR에 자동 노출되지 않도록 트리거 방식을 먼저 정해야 한다).

---

## 5. 방법론·검수 SP 버전 관리 (2026-09-30 통일)

K-Law 본체와 K-Law-Check는 **같은 파일명·버전 표기·자동탐지 규칙**을 쓴다
(`klaw_pipeline_shared.mjs`의 `resolveLatestMethod()`/`resolveLatestCheck()`, 둘 다
내부적으로 `parseMajorMinor()`로 비교). 두 파일명의 버전 숫자는 **같은 의미가 아니라는
점**만 유의한다.

- **K-Law 본체**(`klaw_v[MAJOR]_[MINOR].md`, 예: `klaw_v17_0.md`): 파일명 버전 = 이
  방법론 자신의 버전. `resolveLatestMethod()`가 저장소 루트를 스캔해 버전이 가장 높은
  파일을 자동 채택한다. MAJOR.MINOR가 바뀔 때만 파일명을 git mv로 갱신하고, 그 안의
  패치 번호(v17.0.1~v17.0.8처럼 세 번째 숫자)는 같은 파일 안에 패치노트로 누적된다.
- **K-Law-Check**(`klaw_check_v[MAJOR]_[MINOR].md`, 예: `klaw_check_v17_0.md`): 파일명
  버전 = **이 SP가 검토·반영한 K-Law 본체 버전**(SP 자신의 개정 차수가 아니다 — SP
  자신의 개정 차수는 파일 내부 "버전 이력" 표에서 v1.0/v1.1처럼 별도로 추적한다).
  `resolveLatestCheck()`가 똑같이 자동 채택하고, `klaw_check_runner.mjs`는 매 실행 시
  검수 대상 사건을 실제로 생성한 본체 버전(`rec.config.version`)과 이 파일명 버전을
  비교해, 본체가 더 높으면(=SP가 아직 그 버전을 검토하지 않았을 가능성) 콘솔에 경고를
  낸다. K-Law-Check가 v17.0.4에 고정된 채 v17.0.5~v17.0.8을 전혀 몰랐던 문제(2026-09-30
  검토에서 지적)가 다시 "사람이 우연히 알아챌 때까지" 방치되지 않게 하는 안전장치다.
  **주의**: 이 경고는 파일명 숫자만 비교하는 기계적 신호일 뿐, 내용이 실제로 새 버전에
  맞게 검토됐는지는 사람이 판단해야 한다 — 검토 없이 파일명만 올리지 않는다
  (`klaw_check_v17_0.md` 파일 상단 "파일명·버전 표기 규칙" 참조).
- 과거 버전은 재현성을 위해 `library/benchmark/method/dev/klaw_check_v1_0_FROZEN.md`처럼
  보존한다(이미 그 버전으로 감사한 사건이 있다면 그 감사 결과를 나중에 재현·검증할 수
  있어야 하므로).

---

## 6. 실행 순서 예시

```powershell
node library\benchmark\scripts\klaw_runner.mjs --tag=T --round=1
node library\benchmark\scripts\klaw_check_runner.mjs --tag=T
node library\benchmark\scripts\klaw_reconcile_runner.mjs --tag=T
```

②는 ①의 `runs/T/`가, ③은 ①의 `runs/T/`와 ②의 `runs/T-check/`가 모두 있어야 실행된다
(없으면 각 스크립트가 명시적 에러 메시지로 안내하고 종료한다).

---

## 7. 알려진 한계 (2026-09-30 기준)

- K-Law-Check(②)는 독립 세션이지만 여전히 같은 계열 모델을 기본값으로 쓴다 — 다른
  제공사 모델로 돌리는 것을 권장만 하고 강제하지는 않는다.
- ③(reconcile)의 재검토·최종본 작성이 ①의 자기 검증(STEP V/VSC)보다 반드시 더
  정확하다는 보장은 없다 — 검수 보고서 자체가 오인지했을 가능성은 ③의 프롬프트가
  "인용·근거 없는 판정은 무효"로 최소화를 시도하지만, 완전히 배제하지는 못한다.
- CI(GitHub Actions 등)에서 이 파이프라인을 자동 실행하는 방안은 아직 설계되지 않았다.
