# Security & Architecture Hardening — Change Summary

**Date:** 2026-02-26
**Based on:** Production Readiness Audit rev2
**Scope:** All P1 (critical), P2 (pre-scale), and P3 (pre-launch) issues

---

## Overview

All 13 security issues and 13 architectural/README issues from the production audit have been resolved across two sessions. No new dependencies were added — all fixes use packages already present in the project.

---

## P1 — Critical: Fix Before Any Production Exposure

### SEC-001 — SSRF in `/api/image-proxy`
**File:** `app/api/image-proxy/route.ts`

Added an `isAllowedUrl()` function that validates every proxied URL against an explicit allowlist of trusted Google domains (`lh3.googleusercontent.com`, `drive.google.com`, `googleusercontent.com`, `googleapis.com`). Any URL not on the list — including internal network addresses and cloud metadata endpoints — is rejected with HTTP 400. HTTPS is also enforced.

### SEC-002 — Missing Authorization on `/api/images` and `/api/search`
**Files:** `app/api/images/route.ts`, `app/api/search/route.ts`

Both endpoints now call `validateFolderAccess(folderId)` (from the existing `lib/folder-auth.ts`) before returning any data. The helper allows access when: (a) the folder has no owner (anonymous/public), or (b) the requesting user is the owner. Requests that fail the check get HTTP 403. Anonymous folder flows are unaffected.

### SEC-003 — AES-256-CBC Without Authentication
**File:** `lib/encryption.ts`

Replaced AES-256-CBC (vulnerable to padding oracle attacks) with AES-256-GCM, which provides authenticated encryption. The new ciphertext format is `iv_hex:authTag_hex:ciphertext_hex` (3 colon-separated parts vs the old 2-part format). The `encrypt()` and `decrypt()` function signatures are unchanged.

> **Post-deploy action required:** Existing CBC-encrypted tokens in the database are unreadable with the new scheme. After deploying, run:
> ```sql
> UPDATE folders SET "accessTokenEncrypted" = NULL, "tokenExpiresAt" = NULL;
> ```
> Google OAuth tokens expire in ~1 hour anyway, so users will re-authenticate automatically.

### SEC-004 — IP Spoofing Bypasses Rate Limiter
**File:** `lib/rate-limit.ts`

Changed `getClientIdentifier()` to take the **rightmost non-private IP** from `X-Forwarded-For`. Railway (like most reverse proxies) appends the real client IP at the end of the header; the leftmost entry is fully user-controlled. A `isPrivateIp()` helper filters RFC 1918 / loopback / link-local addresses. Also added `getClientIdentifierForUser()` which prefers authenticated user ID over IP for routes where users are expected to be logged in.

### SEC-005 — OAuth Tokens in Plain Text in Redis Queue Payloads
**Files:** `lib/queue.ts`, `lib/workers.ts`

Tokens are now encrypted with AES-256-GCM before being written to BullMQ job data, and decrypted by a `decryptQueueToken()` helper in `lib/workers.ts` at the start of each job. The queue data field is renamed from `accessToken` to `accessTokenEncrypted` to make the contract explicit. `queueImageBatch()` also accepts the legacy `accessToken` plain-text field for callers that decrypt from DB (e.g. `start-workers.ts`) and re-encrypts it transparently.

### SEC-006 — Middleware Fails Open When Clerk Keys Are Missing
**File:** `middleware.ts`

When Clerk environment variables are absent, the middleware now returns HTTP 503 (`Service unavailable: authentication not configured`) instead of silently passing all requests through. The `/api/health` endpoint is exempted so infrastructure monitoring still works during a misconfiguration.

### SEC-009 — Folder Ownership Hijacking in `/api/ingest`
**File:** `app/api/ingest/route.ts`

Removed the block (lines 115–119) that automatically linked an ownerless folder to any authenticated user who submitted the same URL. Ownerless folders remain ownerless. This prevents User B from stealing User A's anonymously-created folder.

### SEC-010 — CORS Wildcard on Proxy Endpoints
**Files:** `app/api/image-proxy/route.ts`, `app/api/thumbnail-proxy/route.ts`

Removed `Access-Control-Allow-Origin: *` from all proxy responses. Same-origin requests do not require this header. Its presence combined with the SSRF vulnerability allowed any malicious webpage to read proxied content via CORS.

### ARCH-013 — Workers Not Started in Production
**Files:** `nixpacks.toml`, `Procfile` (new)

`nixpacks.toml` now documents that workers must be a separate Railway service. A `Procfile` was created with `web: npm run start` and `worker: npm run workers` for platforms that support multi-process declarations.

---

## P2 — Pre-Scale: Fix Before Multi-User Load

### SEC-007 — Health and Stats Endpoints Expose Internal Details
**Files:** `lib/admin-auth.ts` (new), `app/api/health/route.ts`, `app/api/processing-stats/route.ts`

Created a shared `checkAdminAuth(request)` helper that validates an `X-Admin-Token` request header against the `ADMIN_SECRET_TOKEN` environment variable. Both endpoints now call this at the top of the handler and return HTTP 401 if the token is missing or wrong.

### SEC-008 — No Rate Limiting on Proxy Endpoints
**Files:** `app/api/thumbnail-proxy/route.ts`, `app/api/image-proxy/route.ts`

Applied the existing `imageRateLimiter` (100 req/min) as the first check in both proxy handlers.

### SEC-011 — No Security Headers
**File:** `next.config.ts`

Added a `headers()` export that sets the following headers on all routes:
- `X-Frame-Options: DENY` — clickjacking protection
- `X-Content-Type-Options: nosniff` — prevents MIME-type sniffing
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` — enforces HTTPS
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: camera=(), microphone=(), geolocation=()`

### SEC-012 — Layout Renders Without Auth in Production
**File:** `app/layout.tsx`

In `NODE_ENV=production`, a missing or invalid Clerk publishable key now throws an error at render time rather than silently rendering the app without an auth provider. In development the existing fallback behaviour (render without ClerkProvider) is preserved for convenience.

### SEC-013 — `deploy-migrate.sh` Exits 0 on Migration Failure
**File:** `scripts/deploy-migrate.sh`

Changed the failure branch from `exit 0` to `exit 1`. Railway will now abort the deployment if `prisma migrate deploy` fails, preventing the app from starting with an incompatible schema.

### ARCH-001 — Stats API Imports Workers Module (Starts Workers in Web Process)
**Files:** `lib/processing-stats.ts` (new), `app/api/processing-stats/route.ts`

Created `lib/processing-stats.ts` with `getProcessingStatsFromDB()` that reads progress from PostgreSQL image counts and queue stats from Redis, without importing `lib/workers.ts`. The processing-stats route now imports from this new module instead of from workers, preventing BullMQ Worker objects from being instantiated in the Next.js web process.

### ARCH-002 — In-Memory Rate Limiter Breaks Under Multi-Instance Deployments
**File:** `lib/rate-limit.ts`

Replaced the `Map`-based in-memory `RateLimiter` class with a Redis sliding window implementation using `INCR` + `PEXPIRE`. Each rate-limit window is stored as a Redis key with a TTL. The same exported limiters (`searchRateLimiter`, `folderRateLimiter`, `imageRateLimiter`, etc.) and `checkRateLimit()` / `getRateLimitHeaders()` functions are preserved — all call sites are unchanged.

### ARCH-003 — In-Memory Thumbnail Cache
**File:** `app/api/thumbnail-proxy/route.ts`

Replaced the in-memory `thumbnailCache` Map with Redis `SET`/`GET` using `thumb:${fileId}:${size}` keys and a 2-hour TTL (`EX`). Cache hits and misses are non-fatal (Redis errors are caught and treated as cache misses).

### ARCH-004 — SIGTERM Doesn't Close Workers Gracefully
**Files:** `lib/workers.ts`, `scripts/start-workers.ts`

Added a shared `shutdown(signal)` async function in `lib/workers.ts` that awaits `folderWorker.close()` and `imageWorker.close()` before exiting. Both `SIGINT` and `SIGTERM` are now handled identically. The old `SIGTERM` handler in `scripts/start-workers.ts` (which called `process.exit(0)` without closing workers) was removed.

### ARCH-005 — Recursive Folder Scan Has No Depth or File Limit
**File:** `lib/drive.ts`

Added `MAX_DEPTH = 10` and `MAX_FILES = 1000` constants to `scanFolder()`. The function now passes `depth` through recursive calls and returns early when either limit is hit, logging a warning. Pagination also stops when `MAX_FILES` is reached.

### ARCH-006 — No DB Connection Pooling Configuration
**Files:** `.env.example`, `README.md`

Documented the recommended `DATABASE_URL` parameters for Railway: `?connection_limit=5&pool_timeout=10`. Added an explanatory note in `.env.example` and in the README environment variables table.

---

## P3 — Pre-Launch: Improvements

### ARCH-007 — Hardcoded 55-Minute Token Expiry
**Files:** `app/api/ingest/route.ts`, `.env.example`

The hard-coded `55 * 60 * 1000` ms literal is replaced with `OAUTH_TOKEN_TTL_MS`, a module-level constant that reads from the `OAUTH_TOKEN_TTL_MINUTES` environment variable (default: 55). Clerk does not expose the actual `expires_in` from Google's token response, so this remains a best-effort setting — but it is now operator-configurable without a code change.

### ARCH-008 — Unused Schema Models (`DriveFolder`, `FolderScan`)
**File:** `prisma/schema.prisma`

Removed the `DriveFolder` and `FolderScan` models and the `folderScans` relation from `User`. These were defined for multi-user folder deduplication but were never referenced in application code. A comment is left in the schema reminding operators to create and apply a migration to drop the corresponding tables:
```bash
npx prisma migrate dev --name remove-unused-drive-folder-models
```

### ARCH-009 — No Query Length Limit on Search
**File:** `app/api/search/route.ts`

Added a `MAX_QUERY_LENGTH = 500` constant. Queries longer than 500 characters are rejected with HTTP 400 before any embedding API call is made.

### ARCH-010 — Aggressive 2-Second Polling (already fixed in P2)
**File:** `app/folder/[id]/page.tsx`

Polling interval changed from 2 s to 5 s. The `useEffect` now skips setting the interval entirely when the folder status is `completed`, `completed_with_errors`, or `failed`, eliminating unnecessary requests once processing finishes.

### ARCH-011 — Duplicate Redis Connections
**Files:** `lib/queue.ts`, `lib/workers.ts`

`lib/queue.ts` now exports the Redis connection as `redisConnection`. `lib/workers.ts` imports and reuses this connection instead of creating a second `IORedis` instance with identical configuration. This reduces open connections from 2 to 1 per worker process, and is also reused by `lib/rate-limit.ts` and `app/api/thumbnail-proxy/route.ts`.

### ARCH-012 — `cleanCaption` Duplicated in 3 Files
**Files:** `lib/caption-utils.ts` (new), `app/api/search/route.ts`, `app/api/images/route.ts`, `components/image-card.tsx`

Extracted the `cleanCaption()` function into `lib/caption-utils.ts`. All three previous copies have been replaced with an import from the shared module.

### README-001 — Wrong AI Model Name
**File:** `README.md`

Replaced all references to "Gemini 2.5 Flash" with the correct model identifiers: `gemini-2.0-flash-lite` (captioning) and `gemini-embedding-001` (embeddings).

### README-002 — Missing `NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER`
**File:** `README.md`

Added `NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER` to the environment variables table with a description clarifying it controls the client-side limit displayed in the URL submission form.

### README-003 — False Privacy Statement
**File:** `README.md`

Replaced the misleading "not stored permanently" claim with an accurate statement: AI-generated captions and 768-dimensional vector embeddings are stored permanently in PostgreSQL. Raw image bytes are never stored.

### README-004 — `health-check` Script Referenced but Missing
**Files:** `scripts/health-check.ts` (new)

Created the missing script. It calls `GET /api/health` with the `X-Admin-Token` header and prints a human-readable status summary including queue counts. Exits with code 1 if the system is unhealthy or unreachable.

### README-005 — Production Setup Uses `db:push` Instead of Migrations
**File:** `README.md`

Updated the "Set Up Database" section to distinguish between development (`npm run setup-dev`) and production (`npx prisma migrate deploy`). Added a prominent warning that `prisma db push` should not be used in production as it can silently drop schema objects not tracked by migrations.

---

## New Files Created

| File | Purpose |
|------|---------|
| `lib/admin-auth.ts` | `checkAdminAuth()` helper — validates `X-Admin-Token` header |
| `lib/caption-utils.ts` | Shared `cleanCaption()` utility (deduplicates 3 copies) |
| `lib/processing-stats.ts` | `getProcessingStatsFromDB()` — reads stats from DB/Redis, no worker import |
| `scripts/health-check.ts` | CLI health check script for `npm run health-check` |
| `Procfile` | `web` + `worker` process declarations for Railway / Heroku |

## Modified Files Summary

| File | Changes |
|------|---------|
| `middleware.ts` | Fail-closed (503) when Clerk keys are absent |
| `next.config.ts` | Security headers on all routes |
| `lib/encryption.ts` | AES-256-GCM replacing AES-256-CBC |
| `lib/rate-limit.ts` | Redis sliding window + rightmost-IP extraction |
| `lib/queue.ts` | Encrypt tokens in payloads; export `redisConnection` |
| `lib/workers.ts` | Decrypt tokens; SIGTERM; shared Redis connection; no own IORedis instance |
| `lib/drive.ts` | `MAX_DEPTH=10` and `MAX_FILES=1000` in recursive scan |
| `prisma/schema.prisma` | Removed `DriveFolder` and `FolderScan` models |
| `app/api/ingest/route.ts` | Removed ownership hijacking; configurable token TTL |
| `app/api/images/route.ts` | `validateFolderAccess`; shared `cleanCaption` |
| `app/api/search/route.ts` | `validateFolderAccess`; 500-char query limit; shared `cleanCaption` |
| `app/api/image-proxy/route.ts` | SSRF allowlist; rate limit; no CORS wildcard |
| `app/api/thumbnail-proxy/route.ts` | Redis URL cache; rate limit; no CORS wildcard |
| `app/api/health/route.ts` | Admin token required |
| `app/api/processing-stats/route.ts` | Admin token; DB-based stats (no worker import) |
| `app/layout.tsx` | Throws in production if Clerk keys are missing |
| `app/folder/[id]/page.tsx` | Stops polling at terminal state; 5 s interval |
| `components/image-card.tsx` | Uses shared `cleanCaption` |
| `scripts/start-workers.ts` | Removed redundant SIGTERM handler |
| `scripts/deploy-migrate.sh` | `exit 1` on migration failure |
| `scripts/health-check.ts` | Created (was missing, referenced in package.json) |
| `nixpacks.toml` | Documents worker-as-separate-service requirement |
| `.env.example` | Added `ADMIN_SECRET_TOKEN`, `OAUTH_TOKEN_TTL_MINUTES`, DB pooling note |
| `README.md` | Fixed model name, env var table, privacy claim, deployment instructions |

---

## Verification Checklist

After deploying, confirm the following manually:

- [ ] No Clerk keys → server returns 503 (not a rendered page)
- [ ] `curl /api/image-proxy?url=http://169.254.169.254/` → 400
- [ ] `curl /api/images?folderId=<other_user_folder>` → 403
- [ ] `curl /api/health` without token → 401
- [ ] `curl -H "x-admin-token: $ADMIN_SECRET_TOKEN" /api/health` → 200
- [ ] Response headers include `X-Frame-Options: DENY` and `X-Content-Type-Options: nosniff`
- [ ] Submit a folder URL as a logged-in user for a folder created anonymously → ownership NOT transferred
- [ ] Workers start and stop cleanly on SIGTERM (Railway restart test)
- [ ] Run `UPDATE folders SET "accessTokenEncrypted" = NULL, "tokenExpiresAt" = NULL;` after first deploy
