-- Deal Radar schema
-- Target: Neon Postgres 17 (project proud-scene-58982270, branch main, database dealradar)
-- Safe to re-run: all statements are guarded.

CREATE TABLE IF NOT EXISTS vendor (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('llm','media','devtools','hosting','ops','storage')),
  tier         SMALLINT NOT NULL CHECK (tier IN (1,2)),
  website      TEXT,
  service_line TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source (
  id                   BIGSERIAL PRIMARY KEY,
  vendor_id            BIGINT NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  url                  TEXT NOT NULL,
  kind                 TEXT NOT NULL CHECK (kind IN ('rss','api','page')),
  adapter              TEXT NOT NULL CHECK (adapter IN ('rss','hackernews','reddit','llm_page')),
  cadence_minutes      INTEGER NOT NULL DEFAULT 360,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  note                 TEXT,
  last_checked_at      TIMESTAMPTZ,
  last_changed_at      TIMESTAMPTZ,
  content_hash         TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  health               TEXT NOT NULL DEFAULT 'ok' CHECK (health IN ('ok','degraded','failing','disabled')),
  UNIQUE (vendor_id, url)
);

CREATE INDEX IF NOT EXISTS source_due_idx ON source (enabled, last_checked_at);

CREATE TABLE IF NOT EXISTS deal (
  id               BIGSERIAL PRIMARY KEY,
  vendor_id        BIGINT NOT NULL REFERENCES vendor(id) ON DELETE CASCADE,
  source_id        BIGINT REFERENCES source(id) ON DELETE SET NULL,
  title            TEXT NOT NULL,
  summary          TEXT,
  price_now        NUMERIC(12,2),
  price_was        NUMERIC(12,2),
  currency         TEXT NOT NULL DEFAULT 'USD',
  discount_pct     NUMERIC(6,2),
  promo_code       TEXT,
  starts_at        TIMESTAMPTZ,
  ends_at          TIMESTAMPTZ,
  url              TEXT,
  eligibility_note TEXT,
  confidence       NUMERIC(4,3) NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'needs_review'
                   CHECK (status IN ('published','needs_review','rejected','expired')),
  score            NUMERIC(8,3),
  score_breakdown  JSONB,
  fingerprint      TEXT NOT NULL UNIQUE,
  first_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS deal_status_score_idx ON deal (status, score DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS deal_vendor_idx ON deal (vendor_id);
CREATE INDEX IF NOT EXISTS deal_ends_at_idx ON deal (ends_at);

CREATE TABLE IF NOT EXISTS alert (
  id      BIGSERIAL PRIMARY KEY,
  deal_id BIGINT NOT NULL REFERENCES deal(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'telegram',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status  TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','failed')),
  error   TEXT
);

-- Guarantees at most one successful alert per deal per channel, so re-runs never double-notify.
CREATE UNIQUE INDEX IF NOT EXISTS alert_deal_channel_sent_idx
  ON alert (deal_id, channel) WHERE status = 'sent';

CREATE TABLE IF NOT EXISTS target (
  id        BIGSERIAL PRIMARY KEY,
  vendor_id BIGINT REFERENCES vendor(id) ON DELETE CASCADE,
  keyword   TEXT,
  max_price NUMERIC(12,2),
  priority  SMALLINT NOT NULL DEFAULT 3,
  active    BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (vendor_id IS NOT NULL OR keyword IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS run_log (
  id                         BIGSERIAL PRIMARY KEY,
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at                TIMESTAMPTZ,
  sources_checked            INTEGER NOT NULL DEFAULT 0,
  sources_failed             INTEGER NOT NULL DEFAULT 0,
  pages_fetched              INTEGER NOT NULL DEFAULT 0,
  extractions_ok             INTEGER NOT NULL DEFAULT 0,
  extractions_low_confidence INTEGER NOT NULL DEFAULT 0,
  new_deals                  INTEGER NOT NULL DEFAULT 0,
  errors                     JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS run_log_started_idx ON run_log (started_at DESC);
