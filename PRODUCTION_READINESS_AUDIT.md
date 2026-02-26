# Production Readiness Audit

**Date:** 2026-02-26
**Revision:** 2 (deepened second pass — components, scripts, headers, IDOR, CORS, deployment)
**Scope:** Full codebase review — every `.ts`, `.tsx`, `.sh`, `.js`, `.sql`, and config file. Security vulnerabilities, architectural gaps, production issues, and README accuracy.

---

## Executive Summary

The application works locally and the core feature set is sound. However, there are **13 security issues** (6 critical/high, 7 medium) that must be fixed before going live, along with several architectural gaps that will cause reliability problems under real load. The README also contains inaccuracies that could confuse operators.

---

## Part 1: Critical Security Vulnerabilities

### SEC-001 — SSRF via Unvalidated URL in `/api/image-proxy`
**Severity: Critical**

`/api/image-proxy/route.ts` accepts an arbitrary `url` query parameter and proxies whatever URL is provided without any validation:

```ts
const imageUrl = searchParams.get("url")
// ...
let finalUrl = imageUrl
const response = await fetch(finalUrl, ...)
```

An attacker can use the server as a proxy to reach:
- Internal services (Redis, Postgres, admin panels)
- Cloud provider metadata endpoints (`169.254.169.254` for AWS/GCP credentials)
- Any URL on the internet

**Fix:** Validate that the URL is a known Google domain (e.g. `lh3.googleusercontent.com`, `drive.google.com`) before proxying. Reject all other URLs with a 400 response.

---

### SEC-002 — Missing Authorization on `/api/images` and `/api/search`
**Severity: Critical**

Both endpoints accept a `folderId` parameter and return data for **any folder, regardless of ownership**. There is no authentication or authorization check:

- `/api/images` returns all images, captions, and error details for any folder
- `/api/search` searches the vector embeddings of any folder

A user who knows (or guesses) another user's folder ID can read all their data, including AI-generated captions of private images.

**Fix:** Add ownership validation to both routes. The folder should belong to the requesting user, or must be explicitly marked public (no `userId`). Use the existing `validateFolderAccess` helper.

---

### SEC-003 — AES-256-CBC Without Authentication (Padding Oracle Risk)
**Severity: High**

`lib/encryption.ts` uses AES-256-CBC without a MAC or HMAC:

```ts
const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv)
```

CBC mode without authentication is vulnerable to padding oracle attacks. An attacker who can trigger decryption errors repeatedly can recover plaintext or forge ciphertexts.

**Fix:** Replace with AES-256-GCM, which provides authenticated encryption:
```ts
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
// Store and verify the auth tag
```

---

### SEC-004 — IP Spoofing Bypasses Rate Limiter
**Severity: High**

The rate limiter key is extracted from the `X-Forwarded-For` header, which is fully user-controllable:

```ts
const forwarded = request.headers.get('x-forwarded-for')
const ip = forwarded?.split(',')[0]?.trim() || ...
```

Any client can send `X-Forwarded-For: <random_IP>` to bypass rate limits entirely, making all rate limiting ineffective.

**Fix:** In production, trust only the rightmost IP added by a trusted proxy (Railway/Cloudflare), or configure the trusted proxy count and take `forwarded.split(',').at(-N)`. Alternatively, use user ID or Clerk session as the rate limit key for authenticated routes.

---

### SEC-005 — OAuth Access Tokens Stored in Plain Text in Redis
**Severity: High**

Google OAuth access tokens are passed as plain text in BullMQ job payloads:

```ts
// lib/queue.ts
export interface FolderJobData {
  accessToken?: string   // plain text in Redis
}
```

BullMQ stores job data in Redis. If Redis is exposed (no auth, or a breach), all access tokens are readable. Redis is also accessible via `npm run queue:clear` and similar scripts.

**Fix:** Use the already-existing `encrypt()`/`decrypt()` functions before storing access tokens in queue job data. Decrypt them in the worker before use.

---

### SEC-006 — Middleware Fails Open When Clerk Keys Are Missing
**Severity: High**

```ts
const clerkHandler = (clerkPublishableKey && clerkSecretKey)
  ? clerkMiddleware()
  : null

if (!clerkHandler) {
  return NextResponse.next()  // all requests pass through unauthenticated
}
```

If Clerk environment variables are accidentally unset or missing in a deployment, the middleware becomes a no-op and all requests bypass authentication. This is a fail-open design that should be fail-closed.

**Fix:** If Clerk keys are missing, return a 503 or throw at startup rather than silently allowing all traffic through.

---

### SEC-007 — Health and Stats Endpoints Expose Internal Infrastructure Details
**Severity: Medium**

`/api/health` and `/api/processing-stats` are completely unauthenticated and expose:
- Redis connection status
- Queue sizes (waiting, active, failed counts)
- Per-folder processing progress
- Internal error messages

**Fix:** Restrict these to admin users or protect them with a shared secret header (e.g. `X-Admin-Token`).

---

### SEC-008 — No Rate Limiting on Proxy Endpoints
**Severity: Medium**

`/api/thumbnail-proxy` and `/api/image-proxy` have no rate limiting. Each request downloads a full image from Google and streams it back. A single client can hammer these endpoints to exhaust server bandwidth and memory.

**Fix:** Add rate limiting (the existing `imageRateLimiter` is suitable) to both proxy endpoints.

---

### SEC-009 — Folder Ownership Hijacking via `/api/ingest`
**Severity: High**

When a folder already exists without an owner (created anonymously), any logged-in user who submits the same folder URL can silently claim ownership:

```ts
// app/api/ingest/route.ts:115-119
if (dbUserId && !existingFolder.userId) {
  await prisma.folder.update({
    where: { id: existingFolder.id },
    data: { userId: dbUserId },
  })
}
```

The original anonymous user who created the folder loses access since `validateFolderAccess` checks `folder.userId === dbUserId`. This is a privilege escalation where User B steals User A's folder.

**Fix:** Do not automatically link existing ownerless folders to authenticated users. Instead, create a new folder record for the authenticated user, or require explicit confirmation.

---

### SEC-010 — CORS Wildcard `Access-Control-Allow-Origin: *` on Proxy Endpoints
**Severity: Medium**

Both `/api/thumbnail-proxy` and `/api/image-proxy` return `Access-Control-Allow-Origin: '*'`:

```ts
'Access-Control-Allow-Origin': '*',
```

Combined with the SSRF issue (SEC-001), this means any malicious webpage can use your server as an open proxy and read the response contents (since CORS allows it). Even after fixing the SSRF, the wildcard CORS policy on endpoints that proxy authenticated content is unnecessarily permissive.

**Fix:** Remove the wildcard CORS header. Same-origin requests don't need it. If cross-origin is needed, restrict to your own domain.

---

### SEC-011 — No Security Headers (CSP, X-Frame-Options, X-Content-Type-Options)
**Severity: Medium**

The application sets zero security headers. Missing:

- **`Content-Security-Policy`**: No CSP means the app is more exposed to XSS (though no current XSS vectors were found, this is defense-in-depth)
- **`X-Frame-Options: DENY`**: No clickjacking protection — the app can be embedded in iframes
- **`X-Content-Type-Options: nosniff`**: The proxy endpoints serve arbitrary content types from Google Drive; without `nosniff`, browsers may MIME-sniff image responses as HTML
- **`Strict-Transport-Security`**: No HSTS header to enforce HTTPS

**Fix:** Add security headers in the Next.js middleware or `next.config.ts`:
```ts
// next.config.ts
headers: async () => [{
  source: '/(.*)',
  headers: [
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ],
}]
```

---

### SEC-012 — Layout Renders Without Auth When Clerk Keys Are Missing
**Severity: Medium**

`app/layout.tsx` has a dual rendering path: if Clerk keys are missing or invalid, the entire app renders without `ClerkProvider`, making all `useAuth()` calls return `undefined`/`false`. The `UrlForm` component will treat the user as anonymous, and anonymous folders will be created without any ownership.

Combined with SEC-006 (middleware fails open), this means a Clerk misconfiguration makes the entire app accessible without any authentication, and all folders become ownerless and globally visible.

**Fix:** In production, refuse to render if Clerk is not properly configured. Show an error page instead.

---

### SEC-013 — `deploy-migrate.sh` Exits 0 on Migration Failure
**Severity: Medium**

```bash
# deploy-migrate.sh:23
  exit 0  # Exits successfully even when migration fails!
```

If a database migration fails during deployment, the script exits with code 0 (success). Railway will then start the application with a potentially incompatible database schema, leading to runtime errors or data corruption.

**Fix:** Exit with code 1 on migration failure, or at minimum log a critical alert. The application should not start with a broken schema.

---

## Part 2: Architectural / Production Issues

### ARCH-001 — `processing-stats` API Imports Worker Module
**Severity: High**

```ts
// app/api/processing-stats/route.ts
import { getProcessingStats } from "@/lib/workers"
```

`lib/workers.ts` instantiates BullMQ `Worker` objects at module load time, starting actual worker processes. This means the Next.js web server unintentionally starts image-processing workers when the `/api/processing-stats` endpoint is first hit. Workers and the API server should be entirely separate processes.

**Fix:** Move `getFolderProgress()` and `getProcessingStats()` out of `lib/workers.ts` into a separate module that reads state from Redis/DB rather than from in-process memory.

---

### ARCH-002 — In-Memory Rate Limiter Breaks Under Multi-Instance Deployments
**Severity: High**

`lib/rate-limit.ts` uses a `Map` stored in process memory. In any horizontally-scaled deployment (multiple Railway replicas, auto-scaling), each instance has its own independent counter. A client can make 10 × N requests per minute where N is the number of instances before hitting any limit.

**Fix:** Replace with a Redis-based rate limiter (e.g. `ioredis` + Lua script, or `@upstash/ratelimit`). Redis is already a dependency.

---

### ARCH-003 — In-Memory Thumbnail Cache Doesn't Persist or Scale
**Severity: Medium**

`/api/thumbnail-proxy` maintains an in-memory `thumbnailCache` Map with 2-hour TTL. This:
1. Is wiped on every restart
2. Is not shared across instances
3. Grows without a hard upper bound (only periodic cleanup every 100 accesses)

**Fix:** Store thumbnail URL cache in Redis with TTL, or use HTTP `Cache-Control` headers to let a CDN/reverse proxy cache responses.

---

### ARCH-004 — Incomplete SIGTERM Handling in Workers
**Severity: Medium**

`lib/workers.ts` only handles SIGINT and performs a graceful shutdown of workers:
```ts
process.on("SIGINT", async () => {
  await Promise.all([folderWorker.close(), imageWorker.close()])
  process.exit(0)
})
```

`scripts/start-workers.ts` has a SIGTERM handler but it calls `process.exit(0)` **without** closing the workers first:
```ts
process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...")
  process.exit(0)  // Workers not closed!
})
```

When Railway sends SIGTERM, the workers are killed mid-job without BullMQ's graceful shutdown, causing stalled jobs and lost progress.

**Fix:** Add a proper SIGTERM handler in `lib/workers.ts` (identical to SIGINT) and update `start-workers.ts` to import and call the graceful shutdown.

---

### ARCH-005 — Recursive Folder Scan Has No Depth Limit
**Severity: Medium**

`listImagesRecursively` in `lib/drive.ts` recursively scans all subfolders with no maximum depth or total-file limit per scan. A deeply nested folder structure could cause:
- Stack overflow (deep recursion)
- Thousands of Drive API calls
- Long ingest request times (the route waits for the full scan before responding)

**Fix:** Add a `maxDepth` parameter (default 5) and a `maxFiles` hard limit. Return early once reached.

---

### ARCH-006 — No Database Connection Pooling Configuration
**Severity: Medium**

`lib/prisma.ts` creates a bare `PrismaClient` without connection pool settings:

```ts
export const prisma = globalForPrisma.prisma ?? new PrismaClient()
```

In serverless/edge environments, each cold-start creates a new connection pool, quickly exhausting PostgreSQL's `max_connections`. Railway's PostgreSQL defaults to 100 connections; with multiple instances this fills up fast.

**Fix:** Configure `connection_limit` in the `DATABASE_URL` or use PgBouncer. For Railway, set `?connection_limit=5&pool_timeout=10` in the DATABASE_URL.

---

### ARCH-007 — Hardcoded 55-Minute Token Expiry Is Inaccurate
**Severity: Medium**

```ts
tokenExpiresAt: token ? new Date(Date.now() + 55 * 60 * 1000) : null, // ~55 min
```

Google OAuth tokens typically expire in 1 hour, but the actual expiry should come from the token itself (the `expires_in` field returned by OAuth). A hardcoded 55-minute window may be too long or too short depending on when the token was issued.

**Fix:** Parse the actual `expires_in` value from the Clerk token response and store the real expiry.

---

### ARCH-008 — Unused Schema Models (`DriveFolder`, `FolderScan`)
**Severity: Low**

The Prisma schema defines `DriveFolder` and `FolderScan` models for multi-user folder deduplication, but no application code uses them. They add dead schema weight and confusion.

**Fix:** Either implement the deduplication feature or remove these models and their migrations to reduce schema complexity.

---

### ARCH-009 — No Input Length Validation on Search Query
**Severity: Low**

`/api/search` passes the query string directly to Gemini's embedding API without any maximum length check. Very long queries could cause Gemini API errors or inflated costs.

**Fix:** Add a maximum query length (e.g. 500 characters) and return a 400 if exceeded.

---

### ARCH-010 — Polling Interval Is Too Aggressive (2 seconds)
**Severity: Low**

`app/folder/[id]/page.tsx` polls `/api/images` every 2 seconds:

```ts
const interval = setInterval(fetchFolderData, 2000)
```

With multiple users viewing folders simultaneously, this generates constant database load. There's no exponential backoff when the folder reaches a terminal state (completed/failed).

**Fix:** Implement Server-Sent Events (SSE) or stop polling once status is `completed`/`failed`. At minimum, apply exponential backoff after the first few polls.

---

### ARCH-011 — Duplicate Redis Connections
**Severity: Low**

`lib/queue.ts` and `lib/workers.ts` each create their own Redis connection with identical configuration. If both are imported (which happens when `processing-stats` imports `workers`), the process opens 2+ Redis connections unnecessarily.

**Fix:** Share a single Redis connection module. Export the connection from one place and import it in both `queue.ts` and `workers.ts`.

---

### ARCH-012 — `cleanCaption` Function Duplicated 3 Times
**Severity: Low**

The `cleanCaption` helper function is copy-pasted identically in:
- `app/api/search/route.ts`
- `app/api/images/route.ts`
- `components/image-card.tsx`

Bugs fixed in one copy won't be fixed in others.

**Fix:** Extract to a shared utility module (e.g. `lib/caption-utils.ts`) and import everywhere.

---

### ARCH-013 — `nixpacks.toml` Only Starts Next.js, Not Workers
**Severity: High (for Railway deployment)**

```toml
[start]
cmd = "npm run start"
```

The deployment only starts the Next.js web server. Workers are not started, so **no image processing will happen in production**. The README mentions `pm2` for workers, but the Railway deployment config doesn't include it.

**Fix:** For Railway, either:
1. Run workers as a separate Railway service (recommended)
2. Use a Procfile with separate `web` and `worker` processes
3. Modify the start command to run both: `npm run start & npm run workers`

---

## Part 3: README Inaccuracies

### README-001 — Wrong AI Model Name
The README states: **"Uses Gemini 2.5 Flash to generate detailed captions and tags"**

The code actually uses:
- `gemini-2.0-flash-lite` for image captioning (`lib/gemini.ts:186`)
- `gemini-embedding-001` for embeddings (`lib/gemini.ts:273`)

### README-002 — Missing Environment Variable
`NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER` is used in the frontend (`url-form.tsx:138`) but is missing from the README's Environment Variables table. Operators who set only `MAX_IMAGES_PER_FOLDER` will see the default (200) displayed in the UI regardless.

### README-003 — Misleading Privacy Statement
The README UI form says: **"Images are processed securely and not stored permanently"**

This is false. Image captions and 768-dimensional vector embeddings are stored permanently in PostgreSQL. Only the raw image bytes are not stored.

### README-004 — `health-check` Script Is Referenced but Doesn't Exist
The README and `package.json` both reference `npm run health-check` → `tsx scripts/health-check.ts`, but `scripts/health-check.ts` does not exist in the repository.

### README-005 — Setup Instructions Use `db:push` Instead of Migrations
The README instructs `npm run setup-dev` which calls `prisma db push`. In production, `db push` can drop columns or indexes not tracked by migrations. The README should instruct production operators to use `prisma migrate deploy` instead.

---

## Part 4: Remediation Plan

### Priority 1 — Fix Before Any Production Exposure (Blocking)

| ID | Issue | Action |
|----|-------|--------|
| SEC-001 | SSRF in image-proxy | Allowlist Google domains; reject all other URLs |
| SEC-002 | Unauth access to `/api/images` and `/api/search` | Add `validateFolderAccess` to both routes |
| SEC-003 | CBC encryption without auth | Migrate to AES-256-GCM |
| SEC-004 | IP spoofing bypasses rate limiter | Trust only rightmost proxy IP or use user ID |
| SEC-005 | OAuth tokens in plain text in Redis | Encrypt tokens before queuing |
| SEC-006 | Middleware fails open | Throw/return 503 if Clerk keys missing |
| SEC-009 | Folder ownership hijacking | Don't auto-link ownerless folders to new users |
| SEC-010 | CORS wildcard on proxy endpoints | Remove `Access-Control-Allow-Origin: *` |
| ARCH-013 | Workers not started in production | Configure Railway to run workers as separate service |

### Priority 2 — Fix Before Scaling or Multi-User Load

| ID | Issue | Action |
|----|-------|--------|
| SEC-007 | Health/stats endpoints unauthenticated | Add admin token or auth check |
| SEC-008 | No rate limit on proxy endpoints | Apply `imageRateLimiter` to both proxies |
| SEC-011 | No security headers | Add CSP, X-Frame-Options, nosniff, HSTS in next.config |
| SEC-012 | Layout renders without auth | Show error page if Clerk is not configured |
| SEC-013 | Deploy script exits 0 on failure | Exit 1 on migration failure |
| ARCH-001 | Stats API imports workers module | Extract stats reader to DB/Redis-based module |
| ARCH-002 | In-memory rate limiter | Replace with Redis-backed rate limiter |
| ARCH-003 | In-memory thumbnail cache | Use Redis or CDN-level caching |
| ARCH-004 | SIGTERM doesn't close workers | Fix graceful shutdown in both workers.ts and start-workers.ts |
| ARCH-005 | Unlimited recursive scan | Add maxDepth and maxFiles limits |
| ARCH-006 | No DB connection pooling | Set connection_limit in DATABASE_URL |

### Priority 3 — Improvements Before Public Launch

| ID | Issue | Action |
|----|-------|--------|
| ARCH-007 | Hardcoded token expiry | Use actual `expires_in` from token |
| ARCH-008 | Unused schema models | Remove or implement DriveFolder/FolderScan |
| ARCH-009 | No query length limit | Add 500-char max; return 400 |
| ARCH-010 | Aggressive polling | Switch to SSE or stop polling at terminal state |
| ARCH-011 | Duplicate Redis connections | Share single connection module |
| ARCH-012 | Duplicated `cleanCaption` | Extract to shared utility |
| README-001 | Wrong model name | Update README to `gemini-2.0-flash-lite` |
| README-002 | Missing env var | Add `NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER` to table |
| README-003 | False privacy claim | Clarify captions/embeddings are stored |
| README-004 | Missing script file | Create `scripts/health-check.ts` or remove reference |
| README-005 | db:push in production | Update setup to use `prisma migrate deploy` |

---

## Verified Safe Areas

The following areas were checked and found to be sound:

- **No XSS vectors**: No use of `dangerouslySetInnerHTML`, `innerHTML`, or unescaped rendering. React's default escaping handles all user-visible text.
- **No SQL injection**: All database queries use Prisma's parameterized tagged templates (`$queryRaw`). The two `$executeRawUnsafe` calls in `db-init.ts` use static strings with no user input.
- **No eval or code injection**: No use of `eval()`, `new Function()`, or dynamic code execution.
- **Google Drive API query injection**: The folder ID regex `[a-zA-Z0-9-_]+` limits the character set, preventing injection into Drive API queries.
- **`.env` properly gitignored**: The `.gitignore` excludes `.env` files, preventing accidental secret commits.
- **Clerk token handling**: Clerk's server-side `auth()` and `currentUser()` are used correctly. Token validation is delegated to Clerk's middleware.
- **Image upload/storage**: No raw image bytes are stored server-side. Images are only processed in memory and discarded.
- **Dependencies**: No obviously vulnerable packages detected. Dependencies are modern and actively maintained.

---

## Quick-Win Checklist

These can be done in a single session before any other work:

- [ ] Add SSRF domain allowlist to `/api/image-proxy` (SEC-001)
- [ ] Add `validateFolderAccess` to `/api/images` and `/api/search` (SEC-002)
- [ ] Remove folder ownership auto-linking in `/api/ingest` (SEC-009)
- [ ] Remove `Access-Control-Allow-Origin: *` from proxy responses (SEC-010)
- [ ] Add security headers in `next.config.ts` (SEC-011)
- [ ] Fix SIGTERM handler in `lib/workers.ts` and `start-workers.ts` (ARCH-004)
- [ ] Add rate limiting to `/api/thumbnail-proxy` and `/api/image-proxy` (SEC-008)
- [ ] Add query length check in `/api/search` (ARCH-009)
- [ ] Fix `deploy-migrate.sh` to exit 1 on failure (SEC-013)
- [ ] Stop polling in `folder/[id]/page.tsx` when status is terminal (ARCH-010)
- [ ] Fix the README inaccuracies (README-001 through README-005)
