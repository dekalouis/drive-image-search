# Critical Issues - Google Drive Image Searcher

## Summary

This document outlines critical bugs that are causing the application to fail in specific scenarios, particularly around **private/hidden folder access**.

---

## 1. Access Token Not Persisted for Background Workers (CRITICAL)

**Impact:** Private/hidden folders fail to process even when user is logged in correctly.

### Problem

The OAuth access token obtained during folder ingestion is passed to the queue but:

1. **Not stored permanently** - Token exists only in job data
2. **Lost on worker restart** - If workers restart, queued jobs lose their token
3. **Recovery ignores tokens** - The `recoverPendingImages()` function in `start-workers.ts` sets `accessToken: undefined`

### Location

```typescript
// scripts/start-workers.ts:76-77
await queueImageBatch({
  images: batchData,
  folderId: folder.id,
  accessToken: undefined // Will be retrieved by workers if needed
})
```

The comment says "Will be retrieved by workers if needed" but **workers never retrieve the token**!

### Root Cause

The architecture assumes tokens can be retrieved later, but:
- Workers run as separate processes without user session context
- Clerk's `getUserOauthAccessToken` requires active session
- No mechanism exists to store/refresh tokens for background processing

### Fix Required

Option A: Store encrypted refresh tokens in database
Option B: Implement service account authentication for Drive access
Option C: Require all folders to be public (limited functionality)

---

## 2. Retry API Never Passes Access Token

**Impact:** Retrying failed images for private folders will always fail.

### Problem

```typescript
// app/api/retry-image/route.ts:150-154
await queueImageBatch({
  images: batchData,
  folderId: folder.id,
  accessToken: undefined  // Token is NEVER passed
})
```

The retry endpoint doesn't attempt to get the user's OAuth token before re-queuing.

### Fix Required

```typescript
// Should be:
const { userId } = await auth()
let accessToken = undefined
if (userId) {
  const client = await clerkClient()
  const tokenResponse = await client.users.getUserOauthAccessToken(userId, 'google')
  accessToken = tokenResponse?.data?.[0]?.token
}

await queueImageBatch({
  images: batchData,
  folderId: folder.id,
  accessToken
})
```

---

## 3. Token Expiration During Long Jobs

**Impact:** Processing may fail mid-way for large folders.

### Problem

- OAuth tokens typically expire in 1 hour
- Large folders (200+ images) can take longer than 1 hour to process
- No token refresh mechanism exists in workers

### Location

```typescript
// lib/gemini.ts - downloadWithRetry uses token directly
if (accessToken) {
  headers.Authorization = `Bearer ${accessToken}`
}
```

### Fix Required

Store refresh tokens and implement automatic token refresh before API calls.

---

## 4. Folder Ownership Not Validated

**Impact:** Security vulnerability - any user can sync/retry any folder.

### Problem

The sync and retry APIs don't verify the requesting user owns the folder:

```typescript
// app/api/sync/route.ts
const folder = await prisma.folder.findUnique({
  where: { id: folderId },  // No user check!
})
```

### Fix Required

```typescript
const folder = await prisma.folder.findUnique({
  where: { 
    id: folderId,
    OR: [
      { userId: dbUserId },
      { userId: null }  // Allow anonymous folders
    ]
  },
})
```

---

## 5. Progress Tracking Lost on Worker Restart

**Impact:** UI shows stale/incorrect progress after worker restarts.

### Problem

```typescript
// lib/workers.ts:48
const folderProgress = new Map<string, { startTime: number; ... }>()
```

This in-memory Map is lost when workers restart.

### Fix Required

Store progress in Redis or database instead of in-memory Map.

---

## Next Steps

1. **Immediate:** Fix retry API to pass access token
2. **Short-term:** Implement token storage in database
3. **Medium-term:** Add folder ownership validation
4. **Long-term:** Consider service account approach for more reliable access
