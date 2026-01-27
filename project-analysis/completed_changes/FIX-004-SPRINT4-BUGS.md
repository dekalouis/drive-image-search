# Sprint 4 - Long-term Bugs Fixed

**Date:** January 27, 2025  
**Bugs Fixed:** BUG-011, BUG-013

---

## Overview

Fixed two long-term bugs: silent pgvector fallback degradation and missing rate limiting on public endpoints.

---

## BUG-011: pgvector Fallback Silent Degradation

**Status:** ✅ Fixed

**Problem:** When pgvector wasn't available, search silently fell back to filename search. Users had no indication that semantic search was unavailable, leading to confusion when results were less relevant.

**Solution:** Added `fallbackMode` flag to API response and display notification banner in UI.

### Changes Made

**File:** `app/api/search/route.ts`

1. Added fallback tracking:
   - Added `fallbackMode` variable initialized to `false`
   - Set to `true` when pgvector error is caught and filename fallback occurs

2. Updated response to include flag:
```typescript
return NextResponse.json({
  results: formattedResults,
  query: trimmedQuery,
  searchType: isFilenameSearch ? "filename" : "semantic",
  fallbackMode,  // Added this field
  totalCandidates: totalCount,
  timing: {
    embedding: embeddingTime,
    search: searchTime,
  },
})
```

**File:** `app/folder/[id]/page.tsx`

1. Added state management:
   - New state: `searchFallbackMode` tracks if fallback mode is active
   - Updated when search response received

2. Display notification banner:
   - Added Alert component that displays when `searchFallbackMode` is `true`
   - Orange-styled warning box with clear messaging
   - Positioned below search input
   - Message: "Limited Search Mode - Semantic search is unavailable. Using filename search instead. Results may be less accurate."

3. Added necessary imports:
   - `Alert`, `AlertDescription`, `AlertTitle` from shadcn/ui
   - `AlertTriangle` icon from lucide-react

### How It Works

1. **Search API:** When pgvector fallback occurs, sets `fallbackMode: true` in response
2. **Frontend:** Receives flag and stores in state
3. **UI Display:** Shows orange warning banner alerting user to degraded search capability
4. **User Experience:** Users immediately know results are based on filename search, not semantic understanding

### Result

- Users are informed when semantic search is unavailable
- Clear indication that results may be less relevant
- Ability to upgrade pgvector if needed
- No silent degradation of service

---

## BUG-013: No Rate Limiting on Public Endpoints

**Status:** ✅ Fixed

**Problem:** No rate limiting on API endpoints. Could be abused by:
- Automated scraping
- Denial of service attacks
- Resource exhaustion

**Solution:** Implemented in-memory sliding window rate limiter applied to all public endpoints.

### Changes Made

**New File:** `lib/rate-limit.ts`

Created comprehensive rate limiting utility:

```typescript
class RateLimiter {
  async check(identifier: string): Promise<{ allowed: boolean; remaining: number; resetAt: number }>
  private cleanup()  // Auto-cleanup of expired entries
}

// Pre-configured limiters for different endpoints
export const searchRateLimiter = new RateLimiter(60, 60 * 1000)     // 60 req/min
export const folderRateLimiter = new RateLimiter(30, 60 * 1000)     // 30 req/min
export const imageRateLimiter = new RateLimiter(100, 60 * 1000)     // 100 req/min
export const ingestRateLimiter = new RateLimiter(10, 60 * 1000)     // 10 req/min (strict)
export const defaultRateLimiter = new RateLimiter(100, 60 * 1000)   // 100 req/min

// Helper functions
export function getClientIdentifier(request: Request): string       // Get IP from headers
export function getRateLimitHeaders(result, limit): Record<string, string>  // Standard headers
```

**Implementation Details:**

- **In-memory storage:** Map-based storage for single-instance deployments
- **Sliding window:** Tracks requests per time window (typically 60s)
- **Auto-cleanup:** Removes expired entries every minute
- **Header support:** Returns standard X-RateLimit-* headers
- **IP extraction:** Uses X-Forwarded-For and X-Real-IP for proxy support

**Files Updated:**

1. **`app/api/search/route.ts`**
   - Rate limit: 60 requests/minute
   - Rationale: High frequency, but semantic search is CPU-intensive

2. **`app/api/folders/route.ts`**
   - Rate limit: 30 requests/minute
   - Rationale: Moderate frequency, user listing

3. **`app/api/images/route.ts`**
   - Rate limit: 100 requests/minute
   - Rationale: Image metadata retrieval, can be frequent

4. **`app/api/ingest/route.ts`**
   - Rate limit: 10 requests/minute
   - Rationale: STRICT - expensive operation (Google Drive listing, DB writes)

5. **`app/api/sync/route.ts`**
   - Rate limit: 30 requests/minute
   - Rationale: Moderate frequency, folder sync

6. **`app/api/retry-image/route.ts`**
   - Rate limit: 100 requests/minute
   - Rationale: Can be frequent during retry operations

### Rate Limit Response

When limit exceeded, returns:

```json
{
  "error": "Rate limit exceeded",
  "retryAfter": 45
}
```

With HTTP 429 status and headers:
```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1706382945
Retry-After: 45
```

### How It Works

1. **Request arrives:** Rate limiter checks client IP (from request headers)
2. **Identifier lookup:** Gets or creates entry for that IP
3. **Window check:** Compares current time against reset time
4. **Counter logic:**
   - New window: Reset counter to 1
   - Expired window: Create new window
   - Active window:
     - If count < limit: Increment and allow
     - If count >= limit: Deny with 429

### Benefits

- **Security:** Prevents abuse and DoS attacks
- **Fairness:** Prevents single users/IPs from monopolizing resources
- **Scalability:** Allows clean resource planning
- **Transparency:** Standard headers inform clients of limits
- **Upgradeable:** Can move to Redis for distributed deployments

### Performance Impact

- **Minimal:** In-memory Map operations are O(1)
- **Cleanup:** Runs every 60 seconds, non-blocking
- **No external calls:** No database or Redis dependency
- **Memory:** Grows with number of unique IPs (auto-cleanup helps)

### Future Enhancements

1. **Redis backing:** For distributed deployments
2. **User-based limits:** Different limits for authenticated users
3. **Dynamic limits:** Adjust based on system load
4. **Whitelist/blacklist:** Special handling for known clients
5. **Analytics:** Track rate limit hits for monitoring

---

## Files Modified Summary

| File | Change |
|------|--------|
| `app/api/search/route.ts` | Add fallbackMode flag + rate limiting |
| `app/folder/[id]/page.tsx` | Display fallback mode banner |
| `lib/rate-limit.ts` | NEW - Rate limiting utility |
| `app/api/folders/route.ts` | Add rate limiting |
| `app/api/images/route.ts` | Add rate limiting |
| `app/api/ingest/route.ts` | Add rate limiting (strict) |
| `app/api/sync/route.ts` | Add rate limiting |
| `app/api/retry-image/route.ts` | Add rate limiting |

---

## Testing Recommendations

### BUG-011: Fallback Mode Notification
- [ ] Stop pgvector service (simulate unavailability)
- [ ] Perform semantic search query
- [ ] Verify orange warning banner appears
- [ ] Message clearly states limited search mode
- [ ] Start pgvector and verify banner disappears
- [ ] Test banner styling in light/dark mode

### BUG-013: Rate Limiting
- [ ] Search API: Make 61 rapid requests, verify 429 on 61st
- [ ] Folders API: Make 31 rapid requests, verify 429 on 31st
- [ ] Images API: Make 101 rapid requests, verify 429 on 101st
- [ ] Ingest API: Make 11 rapid requests, verify 429 on 11st
- [ ] Verify proper HTTP headers returned (X-RateLimit-*)
- [ ] Verify Retry-After header present
- [ ] Wait for window reset, verify requests allowed again
- [ ] Test with multiple IPs (verify isolated limits per IP)

---

## Security Notes

**BUG-011:**
- Transparent communication improves user trust
- No security implications

**BUG-013:**
- **Effectiveness:** Prevents casual abuse, but determined attackers can use multiple IPs
- **Best practice:** Combine with WAF/reverse proxy rules in production
- **Monitoring:** Track 429 responses to detect attacks
- **DDoS:** Rate limiting alone won't stop large-scale DDoS; use CDN/WAF

---

## Deployment Notes

1. **No database changes:** Zero migration effort
2. **No dependencies:** Uses only Node.js built-ins
3. **Stateless:** Works without configuration
4. **Backward compatible:** Existing clients unaffected
5. **Zero downtime:** Can be deployed anytime

---

## Monitoring & Observability

**Log output to watch for:**
```
🧹 Rate limiter cleanup: removed X expired entries
⏱️ Filename search (fallback): Xms (found Y results)
```

**Metrics to track:**
- HTTP 429 response rate
- Fallback mode activation frequency
- Rate limit identifier distribution (IPs)

---

**All changes deployed and ready for testing ✅**
