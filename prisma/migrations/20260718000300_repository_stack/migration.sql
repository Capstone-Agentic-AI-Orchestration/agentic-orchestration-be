-- Persist the chosen tech-stack variant per repository (nest/node, next/react, expo/react-native).
ALTER TABLE "projects"."repositories" ADD COLUMN IF NOT EXISTS "stack" TEXT;
