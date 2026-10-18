CREATE TABLE public.investigations (
  id uuid primary key default gen_random_uuid(),
  case_id text unique not null,
  investigator_name text,
  evidence_name text,
  evidence_type text,
  evidence_description text,
  status text default 'draft',
  ai_probability numeric,
  manipulation_probability numeric,
  authenticity_confidence numeric,
  risk_level text,
  metadata_status text,
  source_trace_status text,
  summary text,
  is_demo boolean default false,
  created_at timestamptz default now()
);

CREATE TABLE public.evidence (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete cascade,
  file_name text,
  file_type text,
  file_size bigint,
  file_url text,
  file_hash text,
  width integer,
  height integer,
  created_at timestamptz default now()
);

CREATE TABLE public.analysis_results (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete cascade,
  file_hash text,
  ai_probability numeric,
  manipulation_probability numeric,
  authenticity_confidence numeric,
  risk_level text,
  findings jsonb,
  signals jsonb,
  created_at timestamptz default now()
);

CREATE TABLE public.source_matches (
  id uuid primary key default gen_random_uuid(),
  investigation_id uuid references public.investigations(id) on delete cascade,
  source_name text,
  source_url text,
  similarity_score numeric,
  confidence numeric,
  discovered_date text,
  is_demo boolean default true,
  created_at timestamptz default now()
);

CREATE INDEX idx_investigations_case_id ON public.investigations(case_id);
CREATE INDEX idx_evidence_investigation_id ON public.evidence(investigation_id);
CREATE INDEX idx_evidence_file_hash ON public.evidence(file_hash);
CREATE INDEX idx_analysis_results_investigation_id ON public.analysis_results(investigation_id);
CREATE INDEX idx_analysis_results_file_hash ON public.analysis_results(file_hash);
CREATE INDEX idx_source_matches_investigation_id ON public.source_matches(investigation_id);

GRANT SELECT, INSERT, UPDATE ON public.investigations TO anon, authenticated;
GRANT SELECT, INSERT ON public.evidence TO anon, authenticated;
GRANT SELECT, INSERT ON public.analysis_results TO anon, authenticated;
GRANT SELECT, INSERT ON public.source_matches TO anon, authenticated;
GRANT ALL ON public.investigations, public.evidence, public.analysis_results, public.source_matches TO service_role;

ALTER TABLE public.investigations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_matches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "investigations readable" ON public.investigations FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "investigations insertable" ON public.investigations FOR INSERT TO anon, authenticated WITH CHECK (true);
CREATE POLICY "investigations updatable" ON public.investigations FOR UPDATE TO anon, authenticated USING (is_demo = false) WITH CHECK (is_demo = false);

CREATE POLICY "evidence readable" ON public.evidence FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "evidence insertable" ON public.evidence FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "analysis readable" ON public.analysis_results FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "analysis insertable" ON public.analysis_results FOR INSERT TO anon, authenticated WITH CHECK (true);

CREATE POLICY "source matches readable" ON public.source_matches FOR SELECT TO anon, authenticated USING (true);
CREATE POLICY "source matches insertable" ON public.source_matches FOR INSERT TO anon, authenticated WITH CHECK (true);

INSERT INTO public.investigations (case_id, investigator_name, evidence_name, evidence_type, evidence_description, status, ai_probability, manipulation_probability, authenticity_confidence, risk_level, metadata_status, source_trace_status, summary, is_demo) VALUES
('SS-DEMO-0001', 'A. Rao', 'streetscene_original.jpg', 'image/jpeg', 'Reference demo case: authentic smartphone photograph with intact camera metadata.', 'complete', 8, 12, 82, 'LOW', 'INTACT', 'NOT_AVAILABLE', 'Demo case. Camera metadata intact and internally consistent; no generative-software signatures; sensor-noise characteristics consistent with smartphone capture.', true),
('SS-DEMO-0002', 'A. Rao', 'notice_scan_edited.jpg', 'image/jpeg', 'Reference demo case: recompressed and edited document image.', 'complete', 22, 68, 54, 'MODERATE', 'INCONSISTENT', 'NOT_AVAILABLE', 'Demo case. Editing software signature present and quantisation characteristics indicate multiple recompression generations; metadata timeline internally inconsistent.', true),
('SS-DEMO-0003', 'A. Rao', 'portrait_synthetic.png', 'image/png', 'Reference demo case: image exported by a generative image tool.', 'complete', 86, 30, 71, 'HIGH', 'MISSING', 'NOT_AVAILABLE', 'Demo case. Generative-tool software signature detected, output dimensions match a common generator default, and noise floor is unusually low.', true);

INSERT INTO public.source_matches (investigation_id, source_name, source_url, similarity_score, confidence, discovered_date, is_demo)
SELECT id, 'Illustrative archive record', 'https://example.org/illustrative-record', 91, 60, '2026-02-11', true FROM public.investigations WHERE case_id = 'SS-DEMO-0002';