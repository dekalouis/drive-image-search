# Google Drive Image Searcher

A powerful Next.js application that allows you to search through images in Google Drive folders (public or private) using AI-powered semantic search.

## Features

- 🔗 **Google Drive Integration**: Paste any Google Drive folder URL (public or private when logged in)
- 🖼️ **Instant Image Display**: View thumbnails immediately while processing happens in background
- 🤖 **AI-Powered Captioning**: Uses `gemini-2.0-flash-lite` to generate detailed captions and `gemini-embedding-001` for vector embeddings
- 🔍 **Semantic Search**: Find images using natural language queries with vector similarity
- ⚡ **Real-time Progress**: Live updates on processing status
- 🎯 **Background Processing**: Efficient job queues with BullMQ and Redis

## Getting Started

### Prerequisites

- Node.js >= 20.9.0
- PostgreSQL with pgvector extension
- Redis server
- Google Drive API key
- Google Gemini API key
- Clerk account (for authentication)

### 1. Install Dependencies

```bash
npm install
```

### 2. Set Up Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and configure:

```env
# Database (PostgreSQL with pgvector support)
DATABASE_URL="postgresql://username:password@localhost:5432/drive_searcher?schema=public"

# Redis for job queues
REDIS_URL="redis://localhost:6379"

# Google APIs
GOOGLE_DRIVE_API_KEY="your_google_drive_api_key_here"
GEMINI_API_KEY="your_gemini_api_key_here"

# Clerk Authentication
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY="pk_test_your_publishable_key_here"
CLERK_SECRET_KEY="sk_test_your_secret_key_here"

# Token Encryption (REQUIRED for private folder support)
# Generate with: openssl rand -hex 32
TOKEN_ENCRYPTION_KEY="your_32_byte_hex_key_here"
```

**Important:** Generate the encryption key:
```bash
openssl rand -hex 32
```
Copy the output and paste it as `TOKEN_ENCRYPTION_KEY` in your `.env` file.

### 3. Set Up Database

**Development:**
```bash
# Generate Prisma client and push schema to database
npm run setup-dev
```

**Production — always use migrations, not `db push`:**
```bash
npx prisma migrate deploy
```

> ⚠️ Never use `prisma db push` in production — it can drop columns or indexes not tracked by migrations.

### 4. Reset Database (if needed)

To completely reset the database and clear all data:

```bash
npm run db:reset
```

This will:
- Drop all tables
- Re-run all migrations
- Clear all Redis queues
- Recreate the database schema

### 5. Start the Application

**Terminal 1 - Development Server:**
```bash
npm run dev
```

**Terminal 2 - Background Workers:**
```bash
npm run workers
```

The app will be available at `http://localhost:3000`

## Daily Workflow

**Recommended workflow for development:**

1. Start workers once (they'll keep running):
   ```bash
   npm run workers
   ```

2. Start dev server (in another terminal):
   ```bash
   npm run dev
   ```

3. Add folders via the web interface at `http://localhost:3000`

4. Check worker status:
   ```bash
   npm run workers:status
   ```

## Available Scripts

### Development
- `npm run dev` - Start Next.js development server
- `npm run workers` - Start background job workers
- `npm run start:all` - Start both dev server and workers (uses shell script)

### Database
- `npm run db:generate` - Generate Prisma client
- `npm run db:push` - Push schema to database (dev only — use `migrate deploy` in production)
- `npm run db:migrate` - Create and apply migration
- `npm run db:reset` - **Reset database** (drops all tables, re-runs migrations, clears queues)
- `npm run db:studio` - Open Prisma Studio (database GUI)

### Workers (Production with PM2)
- `npm run workers:start` - Start workers with PM2
- `npm run workers:stop` - Stop workers
- `npm run workers:restart` - Restart workers
- `npm run workers:logs` - View worker logs
- `npm run workers:status` - Check worker status

### Utilities
- `npm run health-check` - Check system health (requires `ADMIN_SECRET_TOKEN` env var)
- `npm run queue:clear` - Clear all job queues
- `npm run folder:status` - Check folder processing status
- `npm run folder:retry` - Retry failed folder processing
- `npm run folder:delete` - Safely delete a folder

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string with pgvector support. For Railway, add `?connection_limit=5&pool_timeout=10` |
| `REDIS_URL` | Yes | Redis connection string for job queues |
| `GOOGLE_DRIVE_API_KEY` | Yes | Google Drive API key for accessing public folders |
| `GEMINI_API_KEY` | Yes | Google AI API key for image captioning and embeddings |
| `TOKEN_ENCRYPTION_KEY` | Yes | 32-byte hex key for encrypting OAuth tokens (generate with `openssl rand -hex 32`) |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Yes | Clerk publishable key for authentication |
| `CLERK_SECRET_KEY` | Yes | Clerk secret key |
| `ADMIN_SECRET_TOKEN` | Yes (production) | Secret token for `/api/health` and `/api/processing-stats` endpoints |
| `MAX_IMAGES_PER_FOLDER` | No | Server-side image limit per folder (default: 200) |
| `NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER` | No | Client-side image limit displayed in the UI (default: 200) |
| `IMAGE_WORKER_CONCURRENCY` | No | Number of images processed in parallel (default: 2) |
| `GEMINI_RATE_LIMIT` | No | Gemini API requests per minute (default: 1000) |
| `OAUTH_TOKEN_TTL_MINUTES` | No | OAuth token TTL stored for background workers (default: 55) |

## Usage

1. Visit `http://localhost:3000`
2. **For public folders:** Paste a Google Drive folder URL (must be shared with "Anyone with the link")
3. **For private folders:** Log in with Google account, then paste the folder URL
4. Watch as images are displayed immediately and processed in the background
5. Use the search box to find images using natural language queries
6. View detailed captions and similarity scores

> **Note on data storage:** AI-generated captions and 768-dimensional vector embeddings are stored permanently in PostgreSQL. Raw image bytes are never stored — images are fetched on-demand from Google Drive.

## Architecture

- **Frontend**: Next.js 15 with React Server Components
- **Database**: PostgreSQL with pgvector for vector similarity search
- **Background Jobs**: BullMQ with Redis for reliable job processing
- **AI**: `gemini-2.0-flash-lite` for image captioning, `gemini-embedding-001` for text embeddings
- **Authentication**: Clerk for user management and OAuth

> **Note:** Workers automatically run `CREATE EXTENSION IF NOT EXISTS vector` on startup.
> Make sure your PostgreSQL instance has pgvector extension installed.

## Railway Deployment

Workers must run as a **separate Railway service** from the Next.js web server. In the Railway dashboard:

1. Create service 1 (web): start command `npm run start`, run migrations with `npm run deploy:migrate`
2. Create service 2 (worker): start command `npm run workers`, same repo and environment variables

A `Procfile` is included for reference:
```
web: npm run start
worker: npm run workers
```

### Post-Deploy Steps (first deploy after security hardening)

After deploying, run this SQL once to clear any tokens encrypted with the old AES-CBC scheme:

```sql
UPDATE folders SET "accessTokenEncrypted" = NULL, "tokenExpiresAt" = NULL;
```

## Troubleshooting

### Database Reset
If you need to start fresh:
```bash
npm run db:reset
```

### Clear Queues
If jobs are stuck:
```bash
npm run queue:clear
```

### Health Check
Check service health (requires `ADMIN_SECRET_TOKEN`):
```bash
npm run health-check
```

### PM2 Issues
If PM2 workers aren't working:
```bash
pm2 stop all
pm2 delete all
pm2 kill
npm run workers:start
```
