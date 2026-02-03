# Handle Support: Phone Numbers & iCloud Emails

This system supports both **phone numbers** and **iCloud email addresses** as user identifiers.

## Overview

Users can connect via:
- **Phone Number**: `+1234567890` (SMS or iMessage)
- **iCloud Email**: `user@icloud.com` (iMessage only)

## Implementation Details

### Database Schema

The `phoneNumber` field in the database is a misnomer - it actually stores **handles** (phone numbers OR emails):

```prisma
model Connection {
  phoneNumber String @unique  // Can be phone (+1234567890) or iCloud email (user@icloud.com)
  // ...
}
```

### Chat GUID Format

Apple's iMessage uses chat GUIDs to identify conversations:

```
any;-;+1234567890        // Phone number (auto-detects SMS vs iMessage)
any;-;user@icloud.com    // iCloud email (iMessage only)
iMessage;-;user@icloud.com  // Explicit iMessage via email
SMS;-;+1234567890        // Explicit SMS
```

We use the `any` prefix to let the system auto-detect the service type.

### Queue Names (BullMQ/Redis)

Queue names must be Redis-safe (no special characters). We sanitize handles:

```typescript
// Phone number: +1234567890 → 1234567890
// iCloud email: user@icloud.com → user-at-icloud-com

sanitizeHandle("+1234567890")     // → "1234567890"
sanitizeHandle("user@icloud.com") // → "user-at-icloud-com"
```

**Queue naming pattern**: `messages-{sanitizedHandle}`

Examples:
- `messages-1234567890` (phone)
- `messages-user-at-icloud-com` (email)

### Code Locations

**Utility Functions** (`packages/shared/src/utils.ts`):
- `sanitizeHandle(handle: string)` - Sanitize for queue names
- `isEmail(handle: string)` - Check if handle is email
- `isPhoneNumber(handle: string)` - Check if handle is phone

**iMessage SDK** (`services/backend/src/lib/imessage.ts`):
- All functions accept `handle` parameter (phone or email)
- Uses `any;-;{handle}` format for chat GUIDs

**Event Listener** (`services/backend/src/routes/imessage-webhook.ts`):
- Extracts handle from chatGuid: `chatGuid.split(';-;')[1]`
- Creates sanitized queues per handle
- Stores in database with original format (unsanitized)

**Worker** (`services/worker/src/index.ts`):
- Processes messages from sanitized queues
- Uses original handle format for API calls
- Database lookups use unsanitized handle

## Important Notes

1. **Database Storage**: Always store the **original, unsanitized** handle
2. **Queue Names**: Always use **sanitized** handle for Redis/BullMQ
3. **API Calls**: Always use **original** handle for iMessage SDK
4. **Lookup Key**: The `phoneNumber` field is the primary lookup key

## Testing

### Phone Number Flow
```
User texts: +1234567890
→ chatGuid: any;-;+1234567890
→ Database: phoneNumber = "+1234567890"
→ Queue: messages-1234567890
→ SDK calls: handle = "+1234567890"
```

### iCloud Email Flow
```
User iMessages: user@icloud.com
→ chatGuid: any;-;user@icloud.com
→ Database: phoneNumber = "user@icloud.com"
→ Queue: messages-user-at-icloud-com
→ SDK calls: handle = "user@icloud.com"
```

## Migration Notes

If you have existing data with only phone numbers, no migration needed. The system is backward compatible and will automatically handle both formats going forward.
