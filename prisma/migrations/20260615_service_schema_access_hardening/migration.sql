-- Service schemas are backend-owned. The frontend uses Supabase directly only
-- for Auth, so do not expose application tables to Data API roles by default.

DO $$
DECLARE
  schema_name text;
  service_schemas text[] := ARRAY[
    'admin',
    'collaboration',
    'identity',
    'intake',
    'integration',
    'memory',
    'notifications',
    'orchestration',
    'projects',
    'scheduling'
  ];
BEGIN
  FOREACH schema_name IN ARRAY service_schemas LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM anon, authenticated', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA %I FROM anon, authenticated', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA %I FROM anon, authenticated', schema_name);
    EXECUTE format('REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA %I FROM anon, authenticated', schema_name);

    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON TABLES FROM anon, authenticated', schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON SEQUENCES FROM anon, authenticated', schema_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I REVOKE ALL ON FUNCTIONS FROM anon, authenticated', schema_name);
  END LOOP;
END $$;
