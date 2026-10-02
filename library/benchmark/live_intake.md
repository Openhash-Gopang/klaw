# 신규 판결 상시 수집 → 10건마다 라운드 편성 (live intake)

법제처 API에 새로 올라온 대법원 민사 `다` 판결을 주 1회 수집하고, 새 사건이 10건 쌓일 때마다
다음 라운드(r11, r12, …)를 자동으로 만든다. 법제처 DB는 선고 후 2개월 반쯤 늦게 올라오므로(2026-10-01
기준 7월 16일 선고분까지), 이 흐름의 사건은 대부분 LLM 학습 시점 이후 판결이다.

## 흐름

| 단계 | 처리 | 자동 여부 |
|---|---|---|
| 1 | 법제처 조회(마지막 조회일 −30일부터, 늦게 올라온 판결 포함), 이미 아는 사건 제외 | 자동 |
| 2 | 본문 수집, 2심·1심 연결, 주문 라벨(유지/파기, 6유형) | 자동 |
| 3 | 대기열이 10건이 되면 가장 오래된 10건을 라운드로 편성(임의 선별 없음) | 자동 |
| 4 | 라운드 번호를 시드로 DeepSeek 5건 / Claude 5건 배정 | 자동 |
| 5 | 개요 작성(overview_writer, DeepSeek 개요 계정) | 자동(`--auto`) |
| 6 | 저장소 게재용 파일 생성(원문·개요), ROUND_READY 파일 | 자동(`--auto`) |
| 7 | DeepSeek 담당 5건 가상 판결(klaw_runner, v17.1) | 자동(`--run-deepseek`) |
| 8 | 매니페스트 재생성·PR·병합 | 수동(진행 담당이 명령 제공) |
| 9 | Claude 담당 5건: 창 A 가상 판결·재검토, 창 B 검수 | 수동(채팅 창) |
| 10 | 채점(일치도 평가 기준 v3.0), 일치도 표 갱신 | 수동(진행 담당) |
| 11 | 라운드 종료 후 방법론·검수 SP 갱신 검토 | 수동(판단 사항) |

## 파일 위치 (klaw-bench\live\)

`state.json`, `index_live.csv`(대기·편성 상태), `labels_live.csv`, `chain_live.csv`, `dev_live.csv`(라운드 편성표),
`assign_rNN.json`(담당 배정 — 블라인드 유지를 위해 저장소에 올리지 않는다), `ROUND_READY_rNN.txt`, `log.txt`, `task_log.txt`.
기존 prec_civil·labels·chain·split 파일은 건드리지 않고, 본문만 기존 이름 규칙(prec_civil\<선고일>_<id>.json 등)으로 추가한다.

## 설정(한 번만)

```powershell
setx LAW_OC "openhash"
setx DEEPSEEK_OVERVIEW_API_KEY "<개요용 키>"
setx DEEPSEEK_API_KEY "<가상 판결용 키>"
# 새 PowerShell 창을 연 뒤:
powershell -File "$env:USERPROFILE\Downloads\klaw\library\benchmark\scripts\register_intake_task.ps1"
```

매주 월요일 09:00에 실행한다(`-Day`, `-Time`으로 변경). PC가 꺼져 있었으면 켜진 직후 실행한다.
가상 판결 호출 비용을 쓰지 않으려면 `-NoRunDeepseek`를 붙인다.

## 수동 실행

```powershell
cd "$env:USERPROFILE\klaw-bench"
node "$env:USERPROFILE\Downloads\klaw\library\benchmark\scripts\klaw_intake.mjs" status
node "$env:USERPROFILE\Downloads\klaw\library\benchmark\scripts\klaw_intake.mjs" poll           # 수집(+10건이면 편성까지)
node "$env:USERPROFILE\Downloads\klaw\library\benchmark\scripts\klaw_intake.mjs" poll --auto --repo="$env:USERPROFILE\Downloads\klaw" --run-deepseek
node "$env:USERPROFILE\Downloads\klaw\library\benchmark\scripts\klaw_intake.mjs" selftest       # 네트워크 없이 로직 시험
```

## 한계

- 법제처 API의 호출 허용 IP에 등록된 PC에서만 동작한다(OC 등록 규칙).
- 라벨은 주문 정규식 분류다. 라벨이 `확인필요`인 사건은 라운드 편성 전에 사람이 확인한다.
- 라이브 라운드는 자연 분포(상고기각·파기 비율)를 따르므로 개발 세트의 4:6 층화와 다르다. 일치도를 비교할 때 결과 유형별로 나눠 본다.
- 하급심을 찾지 못한 사건은 1심·2심 일치도 비교 분모에서 빠진다.
- 편성은 선고일 순이어서 한 라운드에 비슷한 시기의 사건이 모인다.
