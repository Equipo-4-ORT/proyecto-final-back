-- Consolidates changes applied via `prisma db push` that were not captured in migration files.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "default_duration" INTEGER NOT NULL DEFAULT 30;

CREATE INDEX IF NOT EXISTS "users_status_role_work_end_time_idx" ON "users"("status", "role", "work_end_time");

ALTER TABLE "reports" ADD COLUMN IF NOT EXISTS "content" JSONB;

ALTER TABLE "daily_activities" ADD COLUMN IF NOT EXISTS "file_type" TEXT;
