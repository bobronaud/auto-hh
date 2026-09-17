-- RESEARCH §7.3. Единственный источник правды по дедупликации и лимитам.

CREATE TABLE IF NOT EXISTS vacancies (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  hh_id                    TEXT    NOT NULL UNIQUE,
  title                    TEXT    NOT NULL,
  company                  TEXT,
  url                      TEXT    NOT NULL,
  area                     TEXT,
  salary_from              INTEGER,
  salary_to                INTEGER,
  salary_currency          TEXT,
  -- NULL = неизвестно (в карточке выдачи флага не было, страница не открывалась).
  -- Отличать от 0/false: §3.2, после закрытия API флаги не всегда доступны заранее.
  has_test                 INTEGER,
  response_letter_required INTEGER,
  archived                 INTEGER NOT NULL DEFAULT 0,
  snippet                  TEXT,
  description              TEXT,
  raw_json                 TEXT,
  found_at                 TEXT    NOT NULL,
  detail_fetched_at        TEXT
);
CREATE INDEX IF NOT EXISTS idx_vacancies_found_at ON vacancies (found_at);

CREATE TABLE IF NOT EXISTS scores (
  vacancy_id     INTEGER PRIMARY KEY REFERENCES vacancies (id) ON DELETE CASCADE,
  score_vacancy  REAL,
  score_cv_match REAL,
  score_overall  REAL,
  weighted       REAL    NOT NULL,
  reason         TEXT,
  model          TEXT,
  prompt_version TEXT,
  scored_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scores_weighted ON scores (weighted DESC);

CREATE TABLE IF NOT EXISTS letters (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  vacancy_id     INTEGER NOT NULL REFERENCES vacancies (id) ON DELETE CASCADE,
  text           TEXT    NOT NULL,
  chars          INTEGER NOT NULL,
  model          TEXT,
  prompt_version TEXT,
  approved_at    TEXT,
  edited         INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_letters_vacancy ON letters (vacancy_id);

CREATE TABLE IF NOT EXISTS runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  mode        TEXT    NOT NULL,
  started_at  TEXT    NOT NULL,
  finished_at TEXT,
  planned     INTEGER NOT NULL DEFAULT 0,
  applied     INTEGER NOT NULL DEFAULT 0,
  skipped     INTEGER NOT NULL DEFAULT 0,
  failed      INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT
);

-- status: planned | applied | skipped | failed | dry_run
-- error_code: таксономия hh (§1.3) — limit_exceeded, too_long_message,
-- already_applied, test_required, resume_visibility_conflict, wrong_state, ...
CREATE TABLE IF NOT EXISTS applications (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  vacancy_id      INTEGER NOT NULL REFERENCES vacancies (id) ON DELETE CASCADE,
  run_id          INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  letter_id       INTEGER REFERENCES letters (id) ON DELETE SET NULL,
  status          TEXT    NOT NULL,
  error_code      TEXT,
  error_message   TEXT,
  screenshot_path TEXT,
  -- Время реальной отправки. Считается ТОЛЬКО для status='applied' и только по
  -- этому полю строится скользящее окно 24ч (§5.1). Не календарные сутки.
  applied_at      TEXT,
  created_at      TEXT    NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_applications_vacancy_applied
  ON applications (vacancy_id) WHERE status = 'applied';
CREATE INDEX IF NOT EXISTS idx_applications_applied_at ON applications (applied_at);

CREATE TABLE IF NOT EXISTS kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
