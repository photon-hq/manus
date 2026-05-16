-- AlterTable: Replace text-only pendingMessage with structured JSON pendingData
-- Migrates any existing pendingMessage values into the new JSON column

-- Step 1: Add the new column
ALTER TABLE "connections" ADD COLUMN "pendingData" JSONB;

-- Step 2: Migrate any existing pendingMessage values into pendingData as {messageText: "..."}
UPDATE "connections"
SET "pendingData" = jsonb_build_object('messageText', "pendingMessage")
WHERE "pendingMessage" IS NOT NULL;

-- Step 3: Drop the old column
ALTER TABLE "connections" DROP COLUMN "pendingMessage";
