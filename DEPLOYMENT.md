# Deployment Notes

## Database Migration: Add Triggering Message GUID

**Migration**: `20260211000000_add_triggering_message_guid`

### What Changed
- Added `triggeringMessageGuid` field to `Connection` model
- This field stores the GUID of the user message that triggered the current task
- Used for threading webhook replies to the original user message

### Deployment Steps

#### Option 1: Automatic (Recommended)
The backend service automatically runs migrations on startup via `docker-entrypoint.sh`.

```bash
# Just rebuild and restart services
docker-compose down
docker-compose up --build -d
```

The backend will:
1. Detect pending migrations
2. Run `prisma migrate deploy`
3. Start the service

#### Option 2: Manual Migration
If you prefer to run migrations manually before starting services:

```bash
# Stop services
docker-compose down

# Run migration
cd packages/database
DATABASE_URL=postgresql://postgres:password@localhost:5432/manus_imessage npx prisma migrate deploy

# Start services
docker-compose up -d
```

### Rollback (if needed)
If you need to rollback this migration:

```bash
# Mark as rolled back
cd packages/database
npx prisma migrate resolve --rolled-back "20260211000000_add_triggering_message_guid"

# The field will remain in the database but won't be tracked by Prisma
# To fully remove, you'd need to create a new migration that drops the column
```

### Production Deployment
For production, use `docker-compose.prod.yml`:

```bash
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up --build -d
```

### Verification
After deployment, verify the migration was applied:

```bash
# Check migration status
cd packages/database
npx prisma migrate status

# Should show: "Database schema is up to date!"
```

### What This Enables
- All webhook responses (progress updates, final responses, attachments) are now threaded to the user's original message
- Creates cleaner conversation threads in iMessage
- Each user message starts its own thread of responses
- Follow-up messages update the thread target, so responses thread to the follow-up
