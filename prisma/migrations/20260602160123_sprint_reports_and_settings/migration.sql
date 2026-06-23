-- AlterTable
ALTER TABLE "reports" ADD COLUMN     "total_hours" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "avoid_overlaps" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "work_end_time" TEXT NOT NULL DEFAULT '18:00',
ADD COLUMN     "work_start_time" TEXT NOT NULL DEFAULT '09:00';
