/**
 * Redis-backed rate limiter using INCR + PEXPIRE sliding window (ARCH-002)
 * Shared across all instances — safe for multi-instance deployments.
 */

import { redisConnection } from '@/lib/queue'

interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
}

class RateLimiter {
  private config: RateLimitConfig
  private prefix: string

  constructor(maxRequests: number, windowMs: number, prefix: string) {
    this.config = { maxRequests, windowMs }
    this.prefix = prefix
  }

  async check(identifier: string): Promise<RateLimitResult> {
    const key = `rl:${this.prefix}:${identifier}`
    const now = Date.now()
    const resetAt = now + this.config.windowMs

    try {
      // INCR atomically increments (creates key at 1 if missing)
      const count = await redisConnection.incr(key)
      if (count === 1) {
        // First request in window — set TTL
        await redisConnection.pexpire(key, this.config.windowMs)
      }

      const allowed = count <= this.config.maxRequests
      const remaining = Math.max(0, this.config.maxRequests - count)

      // Get actual TTL to report accurate resetAt
      let ttlMs: number
      try {
        const pttl = await redisConnection.pttl(key)
        ttlMs = pttl > 0 ? pttl : this.config.windowMs
      } catch {
        ttlMs = this.config.windowMs
      }

      return {
        allowed,
        remaining,
        resetAt: now + ttlMs,
      }
    } catch (err) {
      // If Redis is unavailable, fail open (allow request) to avoid a Redis outage
      // blocking all traffic — log the error for alerting
      console.error(`⚠️  Rate limiter Redis error for key ${key}:`, err)
      return {
        allowed: true,
        remaining: this.config.maxRequests,
        resetAt,
      }
    }
  }
}

// Private IP ranges — RFC 1918, loopback, link-local
const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
]

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_PATTERNS.some(pattern => pattern.test(ip))
}

/**
 * Extract the real client IP from a request.
 * Railway (and most reverse proxies) append the real client IP as the LAST entry
 * in X-Forwarded-For, so we take the rightmost non-private IP (SEC-004).
 */
export function getClientIdentifier(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for')
  const realIp = request.headers.get('x-real-ip')

  if (forwarded) {
    // Split and iterate from right to left — last non-private IP is the real one
    const ips = forwarded.split(',').map(ip => ip.trim()).filter(Boolean)
    for (let i = ips.length - 1; i >= 0; i--) {
      if (!isPrivateIp(ips[i])) {
        return ips[i]
      }
    }
  }

  if (realIp && !isPrivateIp(realIp.trim())) {
    return realIp.trim()
  }

  return 'unknown'
}

/**
 * Get client identifier preferring authenticated user ID over IP.
 * Use for routes where users are expected to be logged in.
 */
export function getClientIdentifierForUser(request: Request, userId?: string | null): string {
  if (userId) return `user:${userId}`
  return getClientIdentifier(request)
}

// Rate limiter instances (SEC-004 / ARCH-002)
export const searchRateLimiter = new RateLimiter(60, 60 * 1000, 'search')
export const folderRateLimiter = new RateLimiter(30, 60 * 1000, 'folder')
export const imageRateLimiter = new RateLimiter(100, 60 * 1000, 'image')
export const ingestRateLimiter = new RateLimiter(10, 60 * 1000, 'ingest')
export const defaultRateLimiter = new RateLimiter(100, 60 * 1000, 'default')

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
