export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pages (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  url TEXT NOT NULL,
  route_pattern TEXT,
  title TEXT,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS elements (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  semantic_name TEXT NOT NULL,
  element_type TEXT,
  role TEXT,
  visible_text TEXT,
  label TEXT,
  placeholder TEXT,
  test_id TEXT,
  locator_primary TEXT NOT NULL,
  locator_fallback TEXT,
  context_text TEXT,
  confidence REAL NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'scan',
  status TEXT NOT NULL DEFAULT 'approved',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(page_id, semantic_name)
);

CREATE TABLE IF NOT EXISTS business_actions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  page_id TEXT REFERENCES pages(id) ON DELETE SET NULL,
  input_schema_json TEXT,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_file TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  resolved_plan_json TEXT,
  generated_spec_path TEXT,
  status TEXT NOT NULL DEFAULT 'compiled',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS run_results (
  id TEXT PRIMARY KEY,
  test_plan_id TEXT REFERENCES test_plans(id) ON DELETE SET NULL,
  spec_path TEXT NOT NULL,
  status TEXT NOT NULL,
  error_type TEXT,
  failed_step_json TEXT,
  error_message TEXT,
  trace_path TEXT,
  screenshot_path TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_elements_page_id ON elements(page_id);
CREATE INDEX IF NOT EXISTS idx_test_plans_source_file ON test_plans(source_file);
`;
