# Railway PostgreSQL pgvector Setup Guide

## Problem

If you see errors like:
```
ERROR: extension "vector" is not available
DETAIL: Could not open extension control file "/usr/share/postgresql/16/extension/vector.control"
```

This means your Railway PostgreSQL database doesn't have the pgvector extension installed.

## Solution Options

### Option 1: Use Railway's pgvector Template (Recommended)

Railway provides PostgreSQL templates with pgvector pre-installed:

1. **Go to Railway Dashboard** → Your Project
2. **Add a new PostgreSQL service** using one of these templates:
   - **PostgreSQL 18 with pgvector**: https://railway.com/deploy/pgvector-pg18
   - **PostgreSQL 17 with pgvector**: https://railway.com/deploy/pgvector-pg17
   - **PostgreSQL 16 with pgvector**: https://railway.com/deploy/pgvector

3. **Update your DATABASE_URL**:
   - Copy the new `DATABASE_URL` from the new PostgreSQL service
   - Update it in your main application service environment variables

4. **Run migrations**:
   ```bash
   railway run npx prisma migrate deploy
   ```

5. **Delete the old PostgreSQL service** (if you created a new one)

### Option 2: Enable pgvector Manually (If using existing PostgreSQL)

If you want to keep your existing PostgreSQL service:

1. **Go to Railway Dashboard** → Your PostgreSQL service
2. **Click on the "Query" tab** (or "Data" → "Query")
3. **Run this SQL command**:
   ```sql
   CREATE EXTENSION IF NOT EXISTS vector;
   ```
4. **Verify it's enabled**:
   ```sql
   SELECT * FROM pg_extension WHERE extname = 'vector';
   ```

**Note**: This only works if Railway's PostgreSQL instance has pgvector installed. If you get an error, you'll need to use Option 1.

### Option 3: Reset Database with pgvector Template

If you're okay with losing existing data:

1. **Create a new PostgreSQL service** using the pgvector template (see Option 1)
2. **Update DATABASE_URL** in your application
3. **Run migrations**:
   ```bash
   railway run npx prisma migrate deploy
   ```
4. **Re-sync your folders** (they'll need to be re-processed)

## Verification

After enabling pgvector, verify it's working:

```bash
railway run npx prisma studio
```

Or connect via Railway's Query tab and run:
```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
```

You should see:
```
 extname | extversion
---------+------------
 vector  | 0.5.0      (or similar version)
```

## What Happens Without pgvector?

The application will still work, but with limited functionality:

- ✅ **Image processing**: Works (captions and tags are saved)
- ✅ **Filename search**: Works perfectly
- ❌ **Semantic search**: Falls back to filename search
- ❌ **Vector embeddings**: Not stored (but captions/tags still saved)

## Troubleshooting

### Migration fails with pgvector error

If migrations fail because pgvector isn't available:

1. Enable pgvector first (Option 1 or 2 above)
2. Then run migrations:
   ```bash
   railway run npx prisma migrate deploy
   ```

### "Extension already exists" error

This is fine - it means pgvector is already enabled. You can ignore this message.

### SSL connection issues

If you get SSL errors when connecting, add `?sslmode=require` to your `DATABASE_URL`:
```
postgresql://user:pass@host:port/db?sslmode=require
```

## Next Steps

Once pgvector is enabled:

1. ✅ Your migrations will run successfully
2. ✅ Image processing will store vector embeddings
3. ✅ Semantic search will work
4. ✅ Existing images will get embeddings on next processing/retry

The application automatically detects if pgvector is available and handles it gracefully.

