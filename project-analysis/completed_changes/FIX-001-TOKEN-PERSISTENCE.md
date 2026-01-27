# Completed Changes - Fix Critical Token Issues (BUG-001 & BUG-002)

## Summary

Fixed critical issues where private/hidden Google Drive folders fail to process even when users are properly authenticated. The root cause was that OAuth access tokens were not persisted, causing them to be lost on worker restarts and unavailable in the retry API.

## Changes Made

### 1. Created Encryption Helper (`lib/encryption.ts`)

**Status:** ✅ Completed

New file with AES-256-CBC encryption/decryption functions:
- `encrypt(text: string): string` - Encrypts tokens with AES-256-CBC
- `decrypt(text: string): string` - Decrypts encrypted tokens
- Uses `TOKEN_ENCRYPTION_KEY` environment variable (must be 32 bytes in hex format)
- Returns encrypted data as `iv:encryptedData` format (both in hex)

**Security Notes:**
- Uses random IV for each encryption
- Validates encryption key length
- Proper error handling for missing/invalid keys

### 2. Updated Prisma Schema (`prisma/schema.prisma`)

**Status:** ✅ Completed

Added to `Folder` model:
```prisma
accessTokenEncrypted  String?   // Encrypted Google OAuth access token
tokenExpiresAt        DateTime? // Token expiration time
```

Migration created: `prisma/migrations/add_token_storage/migration.sql`

**Migration SQL:**
```sql
ALTER TABLE "folders" ADD COLUMN "accessTokenEncrypted" TEXT,
ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);
```

### 3. Updated Ingest API (`app/api/ingest/route.ts`)

**Status:** ✅ Completed

**Changes:**
- Added import: `import { encrypt } from "@/lib/encryption"`
- When creating new folder (line ~321): Now stores encrypted token with 55-minute expiry
  ```typescript
  accessTokenEncrypted: token ? encrypt(token) : null,
  tokenExpiresAt: token ? new Date(Date.now() + 55 * 60 * 1000) : null,
  ```
- When updating existing folder (line ~221): Updates token if new one available

**Impact:** Private folders now have their access token persisted for background processing

### 4. Updated Worker Recovery (`scripts/start-workers.ts`)

**Status:** ✅ Completed

**Changes:**
- Added import: `import { decrypt } from "../lib/encryption"`
- Updated Prisma query to include `accessTokenEncrypted` and `tokenExpiresAt` fields
- Before queueing batches, now retrieves and decrypts stored token:
  ```typescript
  if (folder.accessTokenEncrypted && folder.tokenExpiresAt) {
    if (new Date() < folder.tokenExpiresAt) {
      try {
        accessToken = decrypt(folder.accessTokenEncrypted)
        console.log(`🔑 Using stored token for folder ${folder.folderId}`)
      } catch (e) {
        console.warn(`⚠️  Failed to decrypt token for folder ${folder.folderId}`)
      }
    }
  }
  ```
- Passes token to `queueImageBatch` instead of `undefined`

**Impact:** Worker recovery now passes stored tokens when re-queuing pending images

### 5. Updated Retry API (`app/api/retry-image/route.ts`)

**Status:** ✅ Completed

**Changes:**
- Added imports: 
  - `import { auth } from "@clerk/nextjs/server"`
  - `import { clerkClient } from "@clerk/nextjs/server"`
  - `import { decrypt } from "@/lib/encryption"`

- At start of POST handler: Attempts to get current user's OAuth token
  ```typescript
  const { userId } = await auth()
  let accessToken: string | undefined = undefined
  if (userId) {
    try {
      const client = await clerkClient()
      const tokenResponse = await client.users.getUserOauthAccessToken(userId, 'google')
      if (tokenResponse?.data?.[0]?.token) {
        accessToken = tokenResponse.data[0].token
      }
    } catch (e) {
      console.log("ℹ️  No OAuth token from current user")
    }
  }
  ```

- In folder batch retry (folderId path): Falls back to stored token if no user token
  ```typescript
  if (!accessToken && folder.accessTokenEncrypted && folder.tokenExpiresAt) {
    if (new Date() < folder.tokenExpiresAt) {
      try {
        accessToken = decrypt(folder.accessTokenEncrypted)
      } catch (e) {
        console.warn("⚠️  Failed to decrypt stored token")
      }
    }
  }
  ```

- Passes token to both single image queue and batch queue

**Impact:** Retry functionality now works for private folders

### 6. Updated Environment Example (`.env.example`)

**Status:** ✅ Completed

Added:
```env
# Token Encryption (generate with: openssl rand -hex 32)
TOKEN_ENCRYPTION_KEY=your_32_byte_hex_key_here
```

**Setup Instructions:**
Users must generate a 32-byte hex key and add to their `.env` file:
```bash
openssl rand -hex 32
```

## Testing Recommendations

### Manual Testing Steps

1. **Setup:**
   - Generate `TOKEN_ENCRYPTION_KEY`: `openssl rand -hex 32`
   - Add to `.env`
   - Run migration: `npx prisma migrate deploy`

2. **Test Private Folder Ingest:**
   - Log in with Google account connected to private folder
   - Submit private folder URL
   - Verify images start processing
   - Check database: `SELECT accessTokenEncrypted, tokenExpiresAt FROM folders WHERE id = '...';` should have values

3. **Test Worker Recovery:**
   - Stop workers mid-processing
   - Start workers again
   - Verify pending images are re-queued with token
   - Check logs for: `🔑 Using stored token for folder`

4. **Test Retry Functionality:**
   - Ingest private folder
   - Wait for some images to fail
   - Click "Retry All Failed"
   - Verify retries proceed with token
   - Check logs for: `✅ Using current user's OAuth token for retry` or `✅ Using stored token for retry`

5. **Test Token Expiration:**
   - Manually set `tokenExpiresAt` to past timestamp
   - Trigger recovery/retry
   - Verify graceful fallback (uses undefined, attempts public access)

### Automated Tests to Create

- [ ] Encryption/decryption roundtrip tests
- [ ] Token persistence in database
- [ ] Recovery uses stored token
- [ ] Retry uses user token or stored token
- [ ] Token expiration handling
- [ ] Public folder access still works without token

## Issues Fixed

| Bug | Issue | Fix |
|-----|-------|-----|
| BUG-001 | Private folders fail to process | Tokens now persisted in DB |
| BUG-002 | Retry broken for private folders | Retry API now gets token from user or storage |

## Files Changed

| File | Lines Changed | Type |
|------|---------------|------|
| `lib/encryption.ts` | New file (51 lines) | New Implementation |
| `prisma/schema.prisma` | 2 fields added | Schema Update |
| `prisma/migrations/add_token_storage/migration.sql` | New migration | Database Migration |
| `app/api/ingest/route.ts` | +13 lines | Feature Enhancement |
| `scripts/start-workers.ts` | +35 lines | Bug Fix |
| `app/api/retry-image/route.ts` | +52 lines | Bug Fix |
| `.env.example` | +2 lines | Configuration |

## Security Considerations

1. **Encryption Key Management:**
   - Must be stored securely in production environment
   - Should NOT be committed to git
   - Must be 32 bytes (64 hex characters)
   - Different key for different environments recommended

2. **Token Storage:**
   - Tokens are encrypted at rest in database
   - Still limited to 55-minute validity (matches Google's typical expiry)
   - No refresh token is stored (by design)

3. **Future Improvements:**
   - Implement token refresh logic for long-running jobs
   - Add token rotation mechanism
   - Monitor token usage for security audits

## Deployment Notes

1. Generate encryption key in production environment
2. Update `.env` with `TOKEN_ENCRYPTION_KEY`
3. Run database migration: `npx prisma migrate deploy`
4. Restart all services (API and workers)
5. Verify private folders work after deployment

## Rollback Plan

If issues occur:
1. Old data without `accessTokenEncrypted` will still work (nullable fields)
2. Retry will use current user's token
3. No data loss on rollback
4. Can safely remove `accessTokenEncrypted` fields if needed

## Next Steps

1. Add unit tests for encryption functions
2. Add integration tests for token persistence flow
3. Monitor logs for token decryption errors in production
4. Implement token refresh for very large folders (5+ hours processing)
5. Consider implementing service account approach as long-term solution
