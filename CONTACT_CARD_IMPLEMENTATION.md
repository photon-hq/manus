# Contact Card Sharing Implementation

## Overview
Implemented automatic contact card sharing when a new message is received from an active connection.

## Changes Made

### 1. Database Schema (`packages/database/prisma/schema.prisma`)
- Added `contactCardShared` boolean field to the `Connection` model
- Defaults to `false`
- Tracks whether the contact card has been shared with each user

### 2. Migration (`packages/database/prisma/migrations/20260214000000_add_contact_card_shared/migration.sql`)
- Created migration to add the `contactCardShared` column to the `connections` table
- **Note**: Migration needs to be deployed when database is running

### 3. iMessage Library (`services/backend/src/lib/imessage.ts`)
- Added `shareContactCard(chatGuid: string)` function
- Uses the SDK's `contacts.shareContactCard()` method
- Includes error handling and logging

### 4. Message Handler (`services/backend/src/routes/imessage-webhook.ts`)
- Added contact card sharing logic after connection validation
- Shares contact card on first message from active connection
- Updates `contactCardShared` flag in database after successful sharing
- Non-blocking: continues processing message even if sharing fails

## How It Works

1. When a message is received from an active connection
2. Check if `contactCardShared` is `false`
3. If not shared yet:
   - Call `shareContactCard(chatGuid)` to share the contact card
   - Update the connection record to set `contactCardShared = true`
   - Log success/failure
4. Continue processing the message normally

## Behavior

- **First message**: Contact card is automatically shared
- **Subsequent messages**: No contact card sharing (already shared)
- **Non-blocking**: If contact card sharing fails, the message is still processed
- **Per-connection**: Each connection tracks its own sharing status

## Testing

To test this feature:
1. Ensure database is running and migration is applied
2. Start the backend service
3. Send a message from a connected phone number
4. The contact card should be shared automatically on the first message
5. Check logs for: `✅ Contact card shared with: <handle>`

## Database Migration

When ready to deploy, run:
```bash
pnpm db:migrate
# or
cd packages/database && pnpm migrate:deploy
```

## Notes

- The `shouldShareContact()` SDK method is NOT used (as requested)
- Contact card is shared directly on first message
- Sharing happens before the message is queued for processing
- The feature is connection-specific, not user-specific
