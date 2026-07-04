-- Add missing columns to Artifact table
ALTER TABLE "Artifact" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'llm';
