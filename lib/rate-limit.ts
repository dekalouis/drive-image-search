/**
 * Simple in-memory rate limiter using sliding window approach
 * Perfect for single-instance deployments. Can be upgraded to Redis for distributed systems.
 */

interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

/**
 * In-memory rate limiter with sliding window
 */
class RateLimiter {
  private store = new Map<string, RateLimitEntry>()
  private config: RateLimitConfig

  constructor(maxRequests: number, windowMs: number) {
    this.config = { maxRequests, windowMs }
    // Cleanup expired entries every minute
    setInterval(() => this.cleanup(), 60 * 1000)
  }

  async check(identifier: string): Promise<RateLimitResult> {
    const now = Date.now()
    const entry = this.store.get(identifier)

    if (!entry || now >= entry.resetAt) {
      // Create new window
      const resetAt = now + this.config.windowMs
      this.store.set(identifier, { count: 1, resetAt })
      return {
        allowed: true,
        remaining: this.config.maxRequests - 1,
        resetAt,
      }
    }

    if (entry.count >= this.config.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      }
    }

    entry.count++
    return {
      allowed: true,
      remaining: this.config.maxRequests - entry.count,
      resetAt: entry.resetAt,
    }
  }

  private cleanup() {
    const now = Date.now()
    let cleaned = 0
    for (const [key, entry] of this.store.entries()) {
      if (now >= entry.resetAt) {
        this.store.delete(key)
        cleaned++
      }
    }
    if (cleaned > 0) {
      console.log(`🧹 Rate limiter cleanup: removed ${cleaned} expired entries`)
    }
  }
}

// Create rate limiters for different endpoints
export const searchRateLimiter = new RateLimiter(60, 60 * 1000) // 60 requests per minute
export const folderRateLimiter = new RateLimiter(30, 60 * 1000) // 30 requests per minute
export const imageRateLimiter = new RateLimiter(100, 60 * 1000) // 100 requests per minute
export const ingestRateLimiter = new RateLimiter(10, 60 * 1000) // 10 requests per minute (expensive)
export const defaultRateLimiter = new RateLimiter(100, 60 * 1000) // 100 requests per minute

/**
 * Get client identifier from request headers (IP address)
 * Handles X-Forwarded-For and X-Real-IP headers for proxy scenarios
 */
export function getClientIdentifier(request: Request): string {
  // Try to get IP from headers (works with most proxies)
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')
  const ip = forwarded?.split(',')[0]?.trim() || realIp?.trim() || 'unknown'
  
  return ip
}

/**
 * Check rate limit for a given identifier using specified limiter
 */
export async function checkRateLimit(
  limiter: RateLimiter,
  identifier: string
): Promise<RateLimitResult> {
  return await limiter.check(identifier)
}

/**
 * Format rate limit response headers
 */
export function getRateLimitHeaders(result: RateLimitResult, limit: number): Record<string, string> {
  return {
    'X-RateLimit-Limit': limit.toString(),
    'X-RateLimit-Remaining': result.remaining.toString(),
    'X-RateLimit-Reset': (Math.ceil(result.resetAt / 1000)).toString(),
  }
}
