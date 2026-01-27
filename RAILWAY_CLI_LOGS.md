# Railway CLI - Viewing Logs Locally

## Quick Commands

### View Latest Deployment Logs (Current Service)
```bash
railway logs
```
Shows logs from the latest deployment of the currently linked service.

### View Logs for Specific Service
```bash
railway logs --service "Service Name"
```
Replace "Service Name" with your actual service name (e.g., "Main project", "Workers").

### View Logs from Specific Deployment
```bash
railway logs <DEPLOYMENT_ID>
```
Get deployment ID from Railway dashboard or `railway status`.

### View Build Logs
```bash
railway logs --build
```
Shows build logs instead of runtime logs.

### View Deployment Logs
```bash
railway logs --deployment
```
Shows deployment process logs.

### View Logs in JSON Format
```bash
railway logs --json
```

### View Logs from Different Environment
```bash
railway logs --environment production
```

## Common Use Cases

### 1. View Latest Logs (Auto-Refresh with Watch)
Since Railway CLI doesn't have `--follow`, use `watch` to auto-refresh:
```bash
watch -n 2 'railway logs | tail -50'
```
This refreshes every 2 seconds showing last 50 lines.

### 2. View Workers Logs
```bash
railway logs --service "Workers"
```
View logs from your workers service.

### 3. View Main App Logs
```bash
railway logs --service "Main project"
```
View logs from your main Next.js application.

### 4. Check Recent Errors
```bash
railway logs | grep -i error
```
Filter logs for errors.

### 5. Search for Specific Image Processing
```bash
railway logs | grep "1CjPBZ-0b3GLU373bXlBvFGIUWaNCzLw-"
```
Search logs for a specific file ID.

### 6. Continuous Log Monitoring (Using Watch)
```bash
watch -n 1 'railway logs --service "Workers" | tail -30'
```
Refresh every second, showing last 30 lines of workers logs.

## List Available Services

To see current service and project:
```bash
railway status
```

To switch services or see all services, use the Railway dashboard or:
```bash
railway link
```
This will let you select a different service.

## Filter Logs by Environment

If you have multiple environments:
```bash
railway logs --environment production
railway logs --environment staging
```

## Other Useful Commands

### Connect to Service Shell
```bash
railway shell
```

### Run Commands in Railway Environment
```bash
railway run npx prisma migrate deploy
railway run npm run build
```

### View Service Details
```bash
railway service
```

## Troubleshooting

### If logs are empty or not showing:
1. Make sure you're in the correct project:
   ```bash
   railway status
   ```

2. Check if services are running:
   ```bash
   railway service list
   ```

3. Try linking to project explicitly:
   ```bash
   railway link
   ```

### If you get "not logged in":
```bash
railway login
```

## Example: Debug Image Processing Issue

```bash
# View workers logs and filter for processing
railway logs --service "Workers" | grep -E "(processing|completed|failed|error)"

# Or watch logs continuously (refresh every 2 seconds)
watch -n 2 'railway logs --service "Workers" | grep -E "(processing|completed|failed|error)" | tail -20'

# Search for specific folder ID
railway logs | grep "cmivjuunt001h13saejwgiuuk"
```

## Alternative: Railway Dashboard

For real-time log streaming, the Railway dashboard is often easier:
1. Go to https://railway.app
2. Select your project
3. Click on a service
4. Click "Logs" tab
5. Logs stream in real-time automatically

The dashboard also provides:
- Log filtering
- Search functionality
- Better formatting
- Service switching
