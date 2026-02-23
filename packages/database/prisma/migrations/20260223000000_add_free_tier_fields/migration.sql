-- AlterTable
ALTER TABLE "connections" ADD COLUMN "tasksUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "connections" ADD COLUMN "pendingMessage" TEXT;
