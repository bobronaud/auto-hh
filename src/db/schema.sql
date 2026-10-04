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
  -- Была ли в карточке выдачи кнопка «Откликнуться». Её отсутствие — сильный
  -- признак, что откликнуться нельзя: уже откликались, отказ, архив, внешний сайт.
  -- Не приговор (вёрстка может меняться), поэтому такие вакансии не отбрасываются,
  -- а уходят в конец очереди.
  can_apply_from_list      INTEGER,
  snippet                  TEXT,
  description              TEXT,
  raw_json                 TEXT,
  found_at                 TEXT    NOT NULL,
  detail_fetched_at        TEXT,
  -- Убрана из очереди руками (нерелевантная или проблемная). Отдельная колонка, а не
  -- строка в applications (инвариант 11) и не archived: upsert при сборе перезаписывает
  -- archived, а эту колонку не трогает, поэтому вакансия не возвращается в очередь.
  dismissed_at             TEXT
);
CREATE INDEX IF NOT EXISTS idx_vacancies_found_at ON vacancies (found_at);

-- Отсеянные фильтром «не фронтенд» — только для анализа по базе: какие заголовки
-- выпадают и не пора ли расширить scoring.keywords. Отдельная таблица, а не строка
-- в vacancies: всё в vacancies — кандидат в очередь, и отсеянная вакансия оказалась
-- бы там же, где живые. UI её не читает.
CREATE TABLE IF NOT EXISTS dropped_vacancies (
  hh_id         TEXT    PRIMARY KEY,
  title         TEXT    NOT NULL,
  company       TEXT,
  url           TEXT    NOT NULL,
  area          TEXT,
  snippet       TEXT,
  reason        TEXT    NOT NULL,
  first_seen_at TEXT    NOT NULL,
  last_seen_at  TEXT    NOT NULL,
  -- Сколько сборов её видели: одна и та же вакансия висит в выдаче неделями.
  seen_count    INTEGER NOT NULL DEFAULT 1
);

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

-- status: planned | applied | skipped | failed | dry_run | needs_human
--
-- needs_human — вакансия, которую нельзя откликнуть автоматически: вопросы
-- работодателя, тестовое задание, отклик на внешнем сайте. Не ошибка и не пропуск:
-- это очередь ручной работы, её видно в UI и по ней можно пройтись самому.
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
  -- Для needs_human: employer_questions | test_required | relocation |
  -- external_apply | unrecognised_form. Плюс отметка «разобрано вручную».
  needs_human_reason TEXT,
  resolved_at        TEXT,
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

-- Ответы на вопросы работодателя, как они ушли в форму (с 05.10). Пишутся и для
-- пробного прогона: форма не отправлена, и других следов того, что модель ответила,
-- нет. answer — читаемый вид: подписи вариантов, а не value из hh.
CREATE TABLE IF NOT EXISTS form_answers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  vacancy_id     INTEGER NOT NULL REFERENCES vacancies(id),
  position       INTEGER NOT NULL,
  question       TEXT    NOT NULL,
  kind           TEXT    NOT NULL,
  answer         TEXT    NOT NULL,
  created_at     TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_form_answers_application ON form_answers (application_id);
