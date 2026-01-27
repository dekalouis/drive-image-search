# Railway Deployment Guide

## Pre-Deploy Command

For the **main project** (not workers or Prisma DB service), use one of these options:

### Option 1: Use the migration script (Recommended)
```bash
npm run deploy:migrate
```
or directly:
```bash
./scripts/deploy-migrate.sh
```

This script:
- Checks if DATABASE_URL is available
- Runs `prisma migrate deploy` to apply pending migrations
- Exits gracefully if DATABASE_URL is missing (won't block deployment)
- Uses bash (no dependencies needed)

### Option 2: Direct Prisma command
```bash
npx prisma migrate deploy
```

**Note:** If you get connection errors, the script will exit gracefully and won't block deployment.

**Important:** Use `prisma migrate deploy` (not `prisma db push`) for production deployments. The `db push` command is for development only.

## Railway Service Configuration

### Main Project Service
- **Pre-deploy command:** `npm run deploy:migrate` or `npx prisma migrate deploy`
- **Start command:** `npm run build && npm run start`
- **Environment variables needed:**
  - `DATABASE_URL` (from Railway PostgreSQL service)
  - `REDIS_URL` (from Railway Redis service)
  - `GOOGLE_DRIVE_API_KEY`
  - `GEMINI_API_KEY`
  - `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (optional, for auth)
  - `CLERK_SECRET_KEY` (optional, for auth)

### Workers Service
- **Pre-deploy command:** (none needed)
- **Start command:** `npm run workers`
- **Environment variables needed:**
  - `DATABASE_URL`
  - `REDIS_URL`
  - `GOOGLE_DRIVE_API_KEY`
  - `GEMINI_API_KEY`
  - (No Clerk keys needed)

### Prisma DB Service
- **Pre-deploy command:** (none needed - this is just the database)
- **Start command:** (none - it's a managed database)
- **Environment variables:** (managed by Railway)

## Troubleshooting

### Pre-deploy command fails with "DATABASE_URL not set"
- Make sure the PostgreSQL service is provisioned and linked to your main project
- Check that `DATABASE_URL` is available in the service's environment variables
- The migration script will skip gracefully if DATABASE_URL is missing

### Pre-deploy command fails with connection errors
- Ensure the PostgreSQL service is running and accessible
- Check that the database credentials in `DATABASE_URL` are correct
- Verify network connectivity between services

### Migrations fail
- Check that all migration files are committed to git
- Ensure the database has the `vector` extension enabled (should be in migration)
- Run `npx prisma migrate status` to see pending migrations
- **If you see pgvector errors**: See [RAILWAY_PGVECTOR_SETUP.md](./RAILWAY_PGVECTOR_SETUP.md) for detailed setup instructions

### Workers stop processing after Railway restart
Railway may restart services periodically, causing workers to lose their connections. This can leave jobs "stalled".

**Symptoms:**
- Processing stops midway (e.g., 10/20 images processed)
- No new jobs are being processed
- Logs show "Workers running - Folder: true, Image: true" but no activity

**Solutions:**

1. **Check health endpoint:**
   ```bash
   curl https://your-app.up.railway.app/api/health
   ```

2. **Recover stalled jobs locally:**
   ```bash
   railway run npx tsx scripts/recover-jobs.ts
   ```

3. **Retry pending/failed images via API:**
   ```bash
   curl -X POST https://your-app.up.railway.app/api/retry-image \
     -H "Content-Type: application/json" \
     -d '{"folderId": "your-folder-id"}'
   ```

4. **Restart the Workers service** in Railway dashboard

**Prevention:** The workers now have:
- Automatic reconnection to Redis
- Stalled job detection and recovery (every 30 seconds)
- Proper lock duration settings

### Image processing stuck on "processing" status
If images are stuck with status "processing" for more than 5 minutes:

1. Run the recovery script:
   ```bash
   railway run npx tsx scripts/recover-jobs.ts
   ```

2. This will:
   - Reset stuck images to "pending"
   - Queue them for reprocessing
   - Update folder progress counts

## Health Check

The `/api/health` endpoint checks:
- Database connectivity
- Redis/Queue connectivity
- Queue statistics

Use this for Railway's health check configuration.

## Notes

- The `postinstall` script automatically runs `prisma generate` after `npm install`
- Migrations are applied during pre-deploy, before the app starts
- If migrations fail, the deployment will continue (the script exits with code 0)
- You can manually run migrations later if needed: `railway run npx prisma migrate deploy`
