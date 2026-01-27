# Railway Database Reset Guide

This guide explains how to reset your database on Railway deployment.

## Option 1: Using Railway CLI (Recommended)

### Prerequisites
1. Install Railway CLI:
   ```bash
   npm i -g @railway/cli
   ```

2. Login to Railway:
   ```bash
   railway login
   ```

### Reset Database

**Method A: Run Prisma Reset Command**
```bash
# Link to your Railway project
railway link

# Run database reset (this will drop all tables and re-run migrations)
railway run npm run db:reset
```

**Method B: Run Prisma Migrate Reset Directly**
```bash
railway run npx prisma migrate reset --force
```

**Method C: Apply Migrations Only (if you just want to update schema)**
```bash
# Apply pending migrations (like removing tags column)
railway run npx prisma migrate deploy
```

---

## Option 2: Using Railway Web Interface

1. Go to your Railway project dashboard
2. Click on your **PostgreSQL service** (or database service)
3. Go to the **"Data"** tab
4. Click **"Reset Database"** (if available)
   - ⚠️ **Warning:** This will delete ALL data

**OR**

1. Go to your **main application service**
2. Click on **"Deployments"** tab
3. Click **"New Deployment"** → **"One-off Command"**
4. Run:
   ```bash
   npx prisma migrate reset --force
   ```
   or
   ```bash
   npm run db:reset
   ```

---

## Option 3: Direct Database Connection (Advanced)

### Connect via Railway CLI
```bash
# Get database connection string
railway variables

# Or connect directly
railway connect postgres
```

### Then run SQL commands:
```sql
-- Drop all tables (destructive!)
DROP SCHEMA public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO postgres;
GRANT ALL ON SCHEMA public TO public;
```

### Then re-run migrations:
```bash
railway run npx prisma migrate deploy
```

---

## Option 4: Just Apply New Migrations (Non-Destructive)

If you only want to apply the new migration (removing tags column) without resetting everything:

```bash
railway run npx prisma migrate deploy
```

This will:
- ✅ Apply the `remove_tags_column` migration
- ✅ Keep all existing data
- ✅ Only drop the `tags` column

---

## Recommended Approach for Your Current Situation

Since you just want to remove the `tags` column and clean up the schema:

### Step 1: Apply Migration (Non-Destructive)
```bash
railway run npx prisma migrate deploy
```

This will:
- Apply the `remove_tags_column` migration
- Drop the `tags` column
- Keep all your existing folders and images

### Step 2: Verify Migration
```bash
# Check migration status
railway run npx prisma migrate status
```

---

## Full Reset (If You Want to Start Fresh)

⚠️ **WARNING:** This will delete ALL data (folders, images, users, etc.)

```bash
railway run npm run db:reset
```

This will:
1. Drop all tables
2. Re-run all migrations from scratch
3. Clear all Redis queues
4. Recreate the database schema

---

## Troubleshooting

### Migration Fails
If migration fails, check:
```bash
# Check migration status
railway run npx prisma migrate status

# Check database connection
railway run npx prisma db pull
```

### Connection Issues
```bash
# Verify DATABASE_URL is set
railway variables

# Test connection
railway run npx prisma db execute --stdin <<< "SELECT 1;"
```

### Permission Issues
If you get permission errors:
1. Check Railway service permissions
2. Ensure DATABASE_URL has correct credentials
3. Verify pgvector extension is installed:
   ```bash
   railway run npx prisma db execute --stdin <<< "CREATE EXTENSION IF NOT EXISTS vector;"
   ```

---

## Quick Reference

| Command | Purpose | Destructive? |
|--------|---------|-------------|
| `railway run npx prisma migrate deploy` | Apply pending migrations | ❌ No (safe) |
| `railway run npm run db:reset` | Full reset (drop all, re-migrate) | ✅ Yes |
| `railway run npx prisma migrate reset --force` | Full reset (Prisma only) | ✅ Yes |
| `railway run npx prisma migrate status` | Check migration status | ❌ No |

---

## For Your Current Tags Removal

**Recommended command:**
```bash
railway run npx prisma migrate deploy
```

This safely applies the `remove_tags_column` migration without losing any data.
