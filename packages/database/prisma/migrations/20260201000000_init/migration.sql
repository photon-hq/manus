-- CreateEnum
CREATE TYPE "Status" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "MessageType" AS ENUM ('SCHEDULED', 'WEBHOOK', 'MANUAL');

-- CreateEnum
CREATE TYPE "QueueStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "connections" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "manusApiKey" TEXT,
    "photonApiKey" TEXT,
    "webhookId" TEXT,
    "status" "Status" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "activatedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manus_messages" (
    "messageGuid" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "messageType" "MessageType" NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manus_messages_pkey" PRIMARY KEY ("messageGuid")
);

-- CreateTable
CREATE TABLE "message_queue" (
    "id" SERIAL NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "messageGuid" TEXT NOT NULL,
    "messageText" TEXT NOT NULL,
    "status" "QueueStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "message_queue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "connections_connectionId_key" ON "connections"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "connections_photonApiKey_key" ON "connections"("photonApiKey");

-- CreateIndex
CREATE INDEX "connections_phoneNumber_idx" ON "connections"("phoneNumber");

-- CreateIndex
CREATE INDEX "connections_photonApiKey_idx" ON "connections"("photonApiKey");

-- CreateIndex
CREATE INDEX "connections_status_idx" ON "connections"("status");

-- CreateIndex
CREATE INDEX "manus_messages_phoneNumber_sentAt_idx" ON "manus_messages"("phoneNumber", "sentAt");

-- CreateIndex
CREATE INDEX "message_queue_phoneNumber_status_createdAt_idx" ON "message_queue"("phoneNumber", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "manus_messages" ADD CONSTRAINT "manus_messages_phoneNumber_fkey" FOREIGN KEY ("phoneNumber") REFERENCES "connections"("phoneNumber") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_queue" ADD CONSTRAINT "message_queue_phoneNumber_fkey" FOREIGN KEY ("phoneNumber") REFERENCES "connections"("phoneNumber") ON DELETE RESTRICT ON UPDATE CASCADE;
