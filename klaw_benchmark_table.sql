-- ═══════════════════════════════════════════════════════════
-- klaw_benchmark 테이블 — K-Law 일치도 누적 평가
-- ═══════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.klaw_benchmark (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  case_no         text        NOT NULL,                    -- 사건번호 (자동 생성)
  case_type       text,                                    -- 사건 유형 (민사/형사/행정 등)
  case_input      text,                                    -- 사건 개요 입력 (2000자 제한)
  virtual_verdict text,                                    -- K-Law 가상 판결문
  real_verdict    text,                                    -- 실제 대법원 판결문
  score_conclusion  numeric(4,2),                          -- 결론 방향 점수 (0~4)
  score_law_logic   numeric(4,2),                          -- 핵심 법리 점수 (0~3)
  score_detail      numeric(4,2),                          -- 세부 논증 점수 (0~3)
  score_total       numeric(4,2),                          -- 종합 점수 (0~10)
  grade           text,                                    -- 등급 (완전 일치 등)
  eval_raw        text,                                    -- DeepSeek 평가 원문
  klaw_version    text        NOT NULL DEFAULT 'v15.3',    -- K-Law 버전
  llm_model       text        NOT NULL DEFAULT 'deepseek-v4-pro',
  reporter        text,                                    -- 등록자 ipv6 (익명)
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_klaw_benchmark_created_at
  ON public.klaw_benchmark (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_klaw_benchmark_klaw_version
  ON public.klaw_benchmark (klaw_version);

CREATE INDEX IF NOT EXISTS idx_klaw_benchmark_reporter
  ON public.klaw_benchmark (reporter);

-- RLS 활성화 (anon 키로 INSERT 허용, SELECT는 본인 것만)
ALTER TABLE public.klaw_benchmark ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon insert" ON public.klaw_benchmark
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "anon select own" ON public.klaw_benchmark
  FOR SELECT TO anon
  USING (reporter = current_setting('request.headers')::json->>'x-gopang-ipv6');

-- ═══════════════════════════════════════════════════════════
-- 버전별 평균 일치도 뷰 (이력 탭 추세선용)
-- ═══════════════════════════════════════════════════════════
CREATE OR REPLACE VIEW public.klaw_benchmark_trend AS
SELECT
  klaw_version,
  COUNT(*)                          AS total_cases,
  ROUND(AVG(score_total),    2)     AS avg_total,
  ROUND(AVG(score_conclusion), 2)   AS avg_conclusion,
  ROUND(AVG(score_law_logic),  2)   AS avg_law_logic,
  ROUND(AVG(score_detail),     2)   AS avg_detail,
  MIN(created_at)                   AS first_at,
  MAX(created_at)                   AS last_at
FROM public.klaw_benchmark
GROUP BY klaw_version
ORDER BY klaw_version;
