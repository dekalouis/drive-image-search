# Bug Report - Comprehensive Issue List

## Critical Bugs (P0)

### BUG-001: Private Folders Fail to Process
- **Status:** Active
- **Severity:** Critical
- **Component:** `lib/workers.ts`, `scripts/start-workers.ts`
- **Description:** Hidden/private folders fail to process even when user is logged in with correct Google account
- **Root Cause:** OAuth access token is not persisted and cannot be retrieved by background workers
- **Files Affected:**
  - `scripts/start-workers.ts:76-77` - Recovery sets `accessToken: undefined`
  - `app/api/retry-image/route.ts:150-154` - Retry doesn't pass token
  - `lib/workers.ts` - Workers can't retrieve tokens independently

### BUG-002: Retry Functionality Broken for Private Folders
- **Status:** Active  
- **Severity:** Critical
- **Component:** `app/api/retry-image/route.ts`
- **Description:** The retry-image API endpoint never attempts to get OAuth token from current user
- **Reproduction:** 
  1. Ingest a private folder
  2. Wait for some images to fail
  3. Click "Retry All Failed"
  4. All retries fail with 403/404 errors

---

## High Severity Bugs (P1)

### BUG-003: Token Expiration Not Handled
- **Status:** Active
- **Severity:** High
- **Component:** `lib/gemini.ts`, `lib/workers.ts`
- **Description:** OAuth tokens expire after ~1 hour but no refresh mechanism exists
- **Impact:** Large folders (>100 images) may fail mid-processing

### BUG-004: No Folder Ownership Validation
- **Status:** Active
- **Severity:** High (Security)
- **Component:** `app/api/sync/route.ts`, `app/api/retry-image/route.ts`
- **Description:** Any user can sync or retry any folder by knowing its ID
- **Impact:** Potential unauthorized access to folder operations

### BUG-005: Sync API Uses Wrong User's Token
- **Status:** Active
- **Severity:** High
- **Component:** `app/api/sync/route.ts`
- **Description:** Sync uses current request user's token, not folder owner's token
- **Impact:** User A cannot sync User B's private folder, even if B shared it with A

---

## Medium Severity Bugs (P2)

### BUG-006: Progress Tracking Memory Leak
- **Status:** Active
- **Severity:** Medium
- **Component:** `lib/workers.ts`
- **Description:** `folderProgress` Map is never cleaned up if folder processing is interrupted
- **Location:** Line 48 - `const folderProgress = new Map<...>()`

### BUG-007: Thumbnail Cache Memory Leak
- **Status:** Active
- **Severity:** Medium
- **Component:** `app/api/thumbnail-proxy/route.ts`
- **Description:** Cache cleanup only runs when size > 10000, expired entries accumulate
- **Fix:** Run cleanup on each cache access or use TTL-based eviction

### BUG-008: Duplicate Redis Connections
- **Status:** Active
- **Severity:** Medium
- **Component:** `lib/queue.ts`, `lib/workers.ts`
- **Description:** Both files create separate Redis connections (could be intentional but wasteful)

### BUG-009: Image Limit Mismatch
- **Status:** Active
- **Severity:** Medium
- **Component:** UI vs `.env.example`
- **Description:** 
  - UI says "up to 1,000 images"
  - `.env.example` shows `MAX_IMAGES_PER_FOLDER=200`
- **Location:** `components/url-form.tsx:139`

### BUG-010: Completed Status Despite Failed Images
- **Status:** Active
- **Severity:** Medium
- **Component:** `lib/workers.ts`
- **Description:** Folder marked "completed" even when some images failed
- **Location:** `updateFolderProgress` function doesn't account for failed images

---

## Low Severity Bugs (P3)

### BUG-011: pgvector Fallback Silent Degradation
- **Status:** Active
- **Severity:** Low
- **Component:** `app/api/search/route.ts`
- **Description:** When pgvector isn't available, silently falls back to filename search
- **Impact:** Users don't know semantic search isn't working

### BUG-012: Error Logs Not Captured
- **Status:** Active
- **Severity:** Low
- **Component:** `logs/workers-error-0.log`
- **Description:** Error log file appears to only contain timestamps, no actual errors
- **Impact:** Hard to debug production issues

### BUG-013: No Rate Limiting on Public Endpoints
- **Status:** Active
- **Severity:** Low (Security)
- **Component:** All API routes
- **Description:** No rate limiting implemented - endpoints could be abused

### BUG-014: SVG in Supported Types But May Fail
- **Status:** Needs Verification
- **Severity:** Low
- **Component:** `lib/drive.ts`
- **Description:** SVG is listed as supported but Gemini might not handle all SVGs well
- **Location:** `supportedImageTypes` array includes `'image/svg+xml'`

---

## Recommendations Priority

1. **Immediate (This Week):**
   - BUG-001: Implement token persistence
   - BUG-002: Fix retry API to pass token

2. **Short-term (Next Sprint):**
   - BUG-003: Implement token refresh
   - BUG-004: Add ownership validation
   - BUG-009: Fix image limit documentation

3. **Medium-term:**
   - BUG-005: Consider service account approach
   - BUG-006, BUG-007: Fix memory leaks
   - BUG-010: Fix completion status logic

4. **Long-term:**
   - BUG-013: Implement rate limiting
   - BUG-011: Add user notification for fallback mode
