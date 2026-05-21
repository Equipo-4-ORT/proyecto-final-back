/*
  Warnings:

  - The values [EDITED,APPROVED] on the enum `ReportStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `ai_summary` on the `reports` table. All the data in the column will be lost.
  - You are about to drop the column `final_content` on the `reports` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ReportStatus_new" AS ENUM ('PENDING', 'SENT');
ALTER TABLE "public"."reports" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reports" ALTER COLUMN "status" TYPE "ReportStatus_new" USING ("status"::text::"ReportStatus_new");
ALTER TYPE "ReportStatus" RENAME TO "ReportStatus_old";
ALTER TYPE "ReportStatus_new" RENAME TO "ReportStatus";
DROP TYPE "public"."ReportStatus_old";
ALTER TABLE "reports" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "reports" DROP COLUMN "ai_summary",
DROP COLUMN "final_content",
ADD COLUMN     "sent_at" TIMESTAMP(3),
ADD COLUMN     "xlsx_url" VARCHAR(255);
