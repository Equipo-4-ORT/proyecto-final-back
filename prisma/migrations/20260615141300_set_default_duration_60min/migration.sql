-- AlterTable
-- El default de duración por defecto de actividad pasa de 30 a 60 minutos (1 hora).
-- Solo afecta a usuarios nuevos; las filas existentes conservan su valor.
ALTER TABLE "users" ALTER COLUMN "default_duration" SET DEFAULT 60;
