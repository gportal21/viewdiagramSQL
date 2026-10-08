-- Ejemplo: esquema de anuncios (basado en el diagrama "maracuyads")
-- Pega aquí tu propio SQL o importa un archivo .sql

CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TYPE ad_status AS ENUM ('draft', 'pending_review', 'active', 'paused', 'rejected');
CREATE TYPE media_type AS ENUM ('image', 'video', 'gif');

CREATE DOMAIN email AS citext
  CHECK (VALUE ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$');

CREATE DOMAIN ruc AS varchar(11)
  CHECK (VALUE ~ '^(10|15|17|20)\d{9}$');

CREATE TYPE dimensions AS (
  width_px  int,
  height_px int
);

CREATE TABLE company (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_name    varchar(150) NOT NULL,
  legal_name    varchar(200) NOT NULL,
  ruc           ruc NOT NULL UNIQUE,
  contact_email email,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth."user" (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         email NOT NULL UNIQUE,
  name          varchar(100) NOT NULL,
  password_hash varchar(60) NOT NULL,
  company_id    uuid REFERENCES company (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.session (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth."user" (id) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE TABLE auth.refresh_token (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   char(64) NOT NULL UNIQUE,
  session_id   uuid NOT NULL,
  consumed_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ONLY auth.refresh_token
  ADD CONSTRAINT refresh_token_session_fk
  FOREIGN KEY (session_id) REFERENCES auth.session (id) ON DELETE CASCADE;

CREATE TABLE ad (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  uploaded_by_id uuid NOT NULL REFERENCES auth."user" (id),
  company_id     uuid NOT NULL REFERENCES company (id) ON DELETE CASCADE,
  title          varchar(160) NOT NULL,
  description    text,
  media_type     media_type NOT NULL,
  status         ad_status NOT NULL DEFAULT 'draft',
  tags           text[] NOT NULL DEFAULT '{}',
  s3_bucket      varchar(255) NOT NULL,
  s3_key         varchar(1024) NOT NULL,
  mime_type      varchar(100) NOT NULL,
  file_size      bigint NOT NULL CHECK (file_size > 0),
  size           dimensions,
  duration_ms    int,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (s3_bucket, s3_key)
);

CREATE INDEX ad_company_status_idx ON ad (company_id, status, created_at DESC);
CREATE INDEX ad_tags_idx ON ad USING gin (tags);

CREATE MATERIALIZED VIEW company_ad_stats AS
SELECT c.id AS company_id,
       c.trade_name,
       count(a.id) FILTER (WHERE a.status = 'active') AS active_ads,
       sum(a.file_size) AS total_bytes
FROM company c
LEFT JOIN ad a ON a.company_id = c.id
GROUP BY c.id, c.trade_name;

COMMENT ON TABLE ad IS 'Anuncios subidos por los usuarios de una empresa';
COMMENT ON COLUMN ad.s3_key IS 'Ruta del archivo dentro del bucket';
COMMENT ON TYPE ad_status IS 'Ciclo de vida de un anuncio';
