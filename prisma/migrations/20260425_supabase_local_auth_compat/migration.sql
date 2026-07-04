-- Local Supabase compatibility primitives.
-- Supabase provisions these roles, schemas, tables, and functions for hosted
-- projects. The local pgvector Postgres container used by docker-compose does
-- not, but later migrations depend on them for profile foreign keys and RLS.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
  END IF;
END
$$;

CREATE SCHEMA IF NOT EXISTS auth;

CREATE TABLE IF NOT EXISTS auth.users (
  id UUID NOT NULL,
  email TEXT,
  encrypted_password TEXT,
  email_confirmed_at TIMESTAMPTZ,
  invited_at TIMESTAMPTZ,
  confirmation_token TEXT,
  confirmation_sent_at TIMESTAMPTZ,
  recovery_token TEXT,
  recovery_sent_at TIMESTAMPTZ,
  email_change_token_new TEXT,
  email_change TEXT,
  email_change_sent_at TIMESTAMPTZ,
  last_sign_in_at TIMESTAMPTZ,
  raw_app_meta_data JSONB NOT NULL DEFAULT '{}',
  raw_user_meta_data JSONB NOT NULL DEFAULT '{}',
  is_super_admin BOOLEAN,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  phone TEXT,
  phone_confirmed_at TIMESTAMPTZ,
  phone_change TEXT,
  phone_change_token TEXT,
  phone_change_sent_at TIMESTAMPTZ,
  confirmed_at TIMESTAMPTZ GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
  email_change_token_current TEXT,
  email_change_confirm_status SMALLINT DEFAULT 0,
  banned_until TIMESTAMPTZ,
  reauthentication_token TEXT,
  reauthentication_sent_at TIMESTAMPTZ,
  is_sso_user BOOLEAN NOT NULL DEFAULT false,
  deleted_at TIMESTAMPTZ,

  CONSTRAINT users_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key
  ON auth.users (email)
  WHERE email IS NOT NULL;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT SELECT ON auth.users TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
