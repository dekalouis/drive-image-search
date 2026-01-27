# Sprint 2 - P1 Bugs Fixed

**Date:** January 27, 2025  
**Bugs Fixed:** BUG-003, BUG-004, BUG-009

---

## Overview

Fixed three high-priority bugs focusing on token expiration handling, security validation, and UI/configuration consistency.

---

## BUG-003: Token Expiration Not Handled

**Status:** ✅ Fixed

**Problem:** OAuth tokens expire after ~1 hour but processing continued silently using expired tokens.

**Solution:** Added token expiration checking with warnings and graceful degradation.

### Changes Made

**File:** `lib/encryption.ts`

Added `isTokenExpired()` helper function that checks if a token is expired or about to expire within a configurable buffer period (default 5 minutes):

```typescript
export function isTokenExpired(expiresAt: Date | null, bufferMinutes: number = 5): boolean {
  if (!expiresAt) return true
  const bufferMs = bufferMinutes * 60 * 1000
  return new Date() >= new Date(expiresAt.getTime() - bufferMs)
}
```

### How It Works

1. **Token Expiration Checking:** Before using stored tokens, the system checks if they're expired
2. **Buffer Period:** 5-minute buffer before actual expiry to prevent edge cases
3. **Graceful Fallback:** Expired tokens are not used; system falls back to public access (API key)
4. **Logging:** Clear warnings logged when tokens are expired

### Files Using This

- `scripts/start-workers.ts` - Checks token expiry during recovery
- `app/api/retry-image/route.ts` - Checks token expiry during retry operations

---

## BUG-004: No Folder Ownership Validation

**Status:** ✅ Fixed

**Problem:** Security vulnerability - any user could sync or retry any folder by knowing its ID.

**Solution:** Implemented folder ownership validation across all folder operations.

### Changes Made

**New File:** `lib/folder-auth.ts`

Created `validateFolderAccess()` function that validates:
- If folder exists
- If current user is the owner OR folder is public (no owner)

```typescript
export async function validateFolderAccess(folderId: string): Promise<{
  folder: any | null
  dbUserId: string | null
  hasAccess: boolean
}> {
  // Gets current user from Clerk
  // Gets folder from database
  // Allows access only if folder.userId is null OR matches current user
}
```

### Updated Files

1. **`app/api/sync/route.ts`**
   - Now imports `validateFolderAccess`
   - Validates access before syncing
   - Returns 403 if access denied

2. **`app/api/retry-image/route.ts`**
   - Validates access for single image retry (checks parent folder)
   - Validates access for batch retry (checks folder directly)
   - Returns 403 if access denied

### Access Rules

✅ **Access Allowed:**
- Folder has no owner (public/anonymous)
- Current user is the folder owner

❌ **Access Denied:**
- User is not the owner (403)
- Folder doesn't exist (404)

---

## BUG-009: Image Limit Mismatch

**Status:** ✅ Fixed

**Problem:** UI displayed "up to 1,000 images" but `.env.example` configured `MAX_IMAGES_PER_FOLDER=200`.

**Solution:** Use environment variable in UI with fallback.

### Changes Made

1. **File:** `components/url-form.tsx` (line 138)
   
   **Before:**
   ```tsx
   Folders with up to 1,000 images are supported.
   ```
   
   **After:**
   ```tsx
   Folders with up to {process.env.NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER || '200'} images are supported.
   ```

2. **File:** `.env.example`
   
   Added public version of limit variable:
   ```env
   NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER=200
   ```

### Result

- UI now displays the configured limit from environment
- Falls back to 200 if variable not set
- Can be changed via environment configuration

---

## Files Modified Summary

| File | Type | Change |
|------|------|--------|
| `lib/encryption.ts` | MODIFIED | Added `isTokenExpired()` function |
| `lib/folder-auth.ts` | NEW | Created folder access validation |
| `app/api/sync/route.ts` | MODIFIED | Added ownership validation |
| `app/api/retry-image/route.ts` | MODIFIED | Added ownership validation |
| `components/url-form.tsx` | MODIFIED | Use env var for image limit |
| `.env.example` | MODIFIED | Added NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER |

---

## Testing Recommendations

### BUG-003: Token Expiration
- [ ] Test with token about to expire (verify 5-minute buffer works)
- [ ] Verify logs show token expiry warnings
- [ ] Verify fallback to public access works gracefully

### BUG-004: Folder Ownership
- [ ] Create folder with User A
- [ ] Try to sync with User B (should fail with 403)
- [ ] Try to retry with User B (should fail with 403)
- [ ] Verify User A can still sync/retry their own folder
- [ ] Verify anonymous folders can be accessed by anyone

### BUG-009: Image Limit
- [ ] Verify UI shows correct limit from environment
- [ ] Test with different MAX_IMAGES_PER_FOLDER values
- [ ] Verify fallback to 200 when not set

---

## Security Impact

**BUG-004 Fix:** Significant security improvement
- Prevents unauthorized folder operations
- Ensures only folder owners can perform admin operations
- Maintains backward compatibility with anonymous/public folders

---

## Configuration

Users deploying these changes should:

1. Update `.env` with public variable:
   ```env
   NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER=200
   ```

2. No database migration needed
3. No API changes for users
4. Improved security with ownership validation

---

## Known Limitations

- **Token Refresh:** Current implementation doesn't refresh expired tokens. Full refresh requires storing Clerk refresh tokens (future enhancement)
- **Folder Sharing:** Shared folders still require public access; invite-based sharing not implemented

---

**All changes deployed and ready for testing ✅**
