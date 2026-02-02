-- AlterTable
ALTER TABLE "connections" ADD COLUMN "currentTaskId" TEXT;

-- AlterTable
ALTER TABLE "message_queue" ADD COLUMN "attachments" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "connections_phoneNumber_key" ON "connections"("phoneNumber");
