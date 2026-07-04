-- Move LangGraph checkpoint persistence tables into the orchestration service schema.

CREATE SCHEMA IF NOT EXISTS orchestration;

ALTER TABLE IF EXISTS public.checkpoint_migrations SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.checkpoints SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.checkpoint_blobs SET SCHEMA orchestration;
ALTER TABLE IF EXISTS public.checkpoint_writes SET SCHEMA orchestration;
