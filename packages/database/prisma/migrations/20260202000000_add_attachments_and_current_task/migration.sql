-- AlterTable
ALTER TABLE "connections" ADD COLUMN     "currentTaskId" TEXT;

-- AlterTable
ALTER TABLE "message_queue" ADD COLUMN     "attachments" JSONB;
