-- SnowMoon Phase 13 Least-Privilege RLS & Role Grant Hardening (PostgreSQL / Supabase)
-- Run manually in Supabase SQL Editor if not already enforced. Do NOT create permissive anon/authenticated policies.

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'snowmoon_migrations',
    'snowmoon_customers',
    'snowmoon_workers',
    'snowmoon_workforce_jobs',
    'snowmoon_intents',
    'snowmoon_outlayer_calls',
    'snowmoon_verifications',
    'snowmoon_settlements',
    'snowmoon_kv_collections'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM anon;', tbl);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM authenticated;', tbl);
    EXECUTE format('GRANT ALL ON TABLE public.%I TO service_role;', tbl);
  END LOOP;
END $$;

INSERT INTO snowmoon_migrations (id, description)
VALUES ('002_rls_hardening', 'Enforce FORCE ROW LEVEL SECURITY and revoke anon/authenticated/PUBLIC grants on all 9 SnowMoon tables')
ON CONFLICT (id) DO NOTHING;

-- Read-only verification queries (run after applying):
-- SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname LIKE 'snowmoon_%';
-- SELECT schemaname, tablename, policyname, roles, cmd FROM pg_policies WHERE tablename LIKE 'snowmoon_%';
-- SELECT grantee, table_name, privilege_type FROM information_schema.role_table_grants WHERE table_name LIKE 'snowmoon_%' AND grantee IN ('anon', 'authenticated', 'service_role');

