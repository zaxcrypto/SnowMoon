-- SnowMoon Phase 1 Optimistic Concurrency Control for KV Collections
-- Prepared only — DO NOT execute automatically against production without review.

ALTER TABLE public.snowmoon_kv_collections
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

INSERT INTO snowmoon_migrations (id, description)
VALUES (
  '003_kv_versioning_and_locks',
  'Add optimistic concurrency version column to snowmoon_kv_collections to prevent last-writer-wins overwrites'
)
ON CONFLICT (id) DO NOTHING;

