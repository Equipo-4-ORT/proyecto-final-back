-- AlterTable
ALTER TABLE "users" ADD COLUMN     "jira_cloud_id" TEXT,
ADD COLUMN     "jira_connected_at" TIMESTAMP(3),
ADD COLUMN     "jira_last_sync_at" TIMESTAMP(3),
ADD COLUMN     "jira_reconnect_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "jira_refresh_token" TEXT,
ADD COLUMN     "jira_site_url" TEXT;

-- AlterTable
ALTER TABLE "daily_activities" ADD COLUMN     "external_id" TEXT;

-- CreateTable
CREATE TABLE "jira_oauth_states" (
    "state" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jira_oauth_states_pkey" PRIMARY KEY ("state")
);

-- CreateIndex
CREATE INDEX "jira_oauth_states_user_id_idx" ON "jira_oauth_states"("user_id");

-- CreateIndex
CREATE INDEX "daily_activities_user_id_source_start_time_idx" ON "daily_activities"("user_id", "source", "start_time");

-- CreateIndex
CREATE UNIQUE INDEX "daily_activities_user_id_source_external_id_key" ON "daily_activities"("user_id", "source", "external_id");

-- AddForeignKey
ALTER TABLE "jira_oauth_states" ADD CONSTRAINT "jira_oauth_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
