import { type NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { getFreshThumbnailUrl } from "@/lib/drive"
import { prisma } from "@/lib/prisma"
import { imageRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"
import { redisConnection } from "@/lib/queue"

const CACHE_TTL_SECONDS = 2 * 60 * 60 // 2 hours

async function getCachedThumbnailUrl(fileId: string, size: number): Promise<string | null> {
  try {
    return await redisConnection.get(`thumb:${fileId}:${size}`)
  } catch {
    return null
  }
}

async function setCachedThumbnailUrl(fileId: string, size: number, url: string): Promise<void> {
  try {
    await redisConnection.set(`thumb:${fileId}:${size}`, url, 'EX', CACHE_TTL_SECONDS)
  } catch {
    // Non-fatal — cache miss on next request
  }
}

async function deleteCachedThumbnailUrl(fileId: string, size: number): Promise<void> {
  try {
    await redisConnection.del(`thumb:${fileId}:${size}`)
  } catch {
    // Non-fatal
  }
}

export async function GET(request: NextRequest) {
  try {
    // Rate limiting (SEC-008)
    const identifier = getClientIdentifier(request)
    const rateLimitResult = await checkRateLimit(imageRateLimiter, identifier)
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded', retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000) },
        {
          status: 429,
          headers: {
            ...getRateLimitHeaders(rateLimitResult, 100),
            'Retry-After': Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000).toString(),
          },
        }
      )
    }

    const { searchParams } = new URL(request.url)
    const fileId = searchParams.get("fileId")
    const sizeParam = searchParams.get("size")
    const size = sizeParam ? parseInt(sizeParam, 10) : 220

    if (!fileId) {
      return NextResponse.json({ error: "fileId parameter is required" }, { status: 400 })
    }

    if (isNaN(size) || size < 32 || size > 1600) {
      return NextResponse.json({ error: "Invalid size parameter (32-1600)" }, { status: 400 })
    }

    // Get auth info — try current user first
    let clerkUserId: string | null = null
    try {
      const authResult = await auth()
      clerkUserId = authResult?.userId || null
    } catch (authError) {
      console.log(`⚠️ Auth error in thumbnail-proxy: ${authError instanceof Error ? authError.message : String(authError)}`)
    }

    // If no current user, look up folder owner from DB
    if (!clerkUserId) {
      try {
        const image = await prisma.image.findUnique({
          where: { fileId },
          select: {
            folder: {
              select: {
                userId: true,
                user: { select: { clerkId: true } },
              },
            },
          },
        })
        if (image?.folder?.user?.clerkId) {
          clerkUserId = image.folder.user.clerkId
        }
      } catch (dbError) {
        console.log(`⚠️ Error looking up folder owner: ${dbError instanceof Error ? dbError.message : String(dbError)}`)
      }
    }

    // Try to get Google OAuth token
    let accessToken: string | null = null
    if (clerkUserId) {
      try {
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(clerkUserId, 'google')
        if (tokenResponse?.data?.[0]?.token) {
          accessToken = tokenResponse.data[0].token
        }
      } catch {
        console.log(`ℹ️ No Google OAuth token available for thumbnail (fileId: ${fileId.substring(0, 10)}...)`)
      }
    }

    // Check Redis cache first (ARCH-003)
    let thumbnailUrl = await getCachedThumbnailUrl(fileId, size)

    if (!thumbnailUrl) {
      thumbnailUrl = await getFreshThumbnailUrl(fileId, size, accessToken || undefined)

      if (!thumbnailUrl) {
        console.error(`❌ No thumbnail available for file ${fileId}`)
        return NextResponse.json({ error: "Thumbnail not available" }, { status: 404 })
      }

      await setCachedThumbnailUrl(fileId, size, thumbnailUrl)
    }

    // Fetch the actual thumbnail image
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      }

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`
      }

      const response = await fetch(thumbnailUrl, {
        headers,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        // Cached URL may have expired — fetch a fresh one
        await deleteCachedThumbnailUrl(fileId, size)
        const freshUrl = await getFreshThumbnailUrl(fileId, size, accessToken || undefined)

        if (freshUrl) {
          await setCachedThumbnailUrl(fileId, size, freshUrl)
          const retryResponse = await fetch(freshUrl, { headers })

          if (retryResponse.ok) {
            const imageBuffer = await retryResponse.arrayBuffer()
            const contentType = retryResponse.headers.get('content-type') || 'image/jpeg'

            return new NextResponse(imageBuffer, {
              status: 200,
              headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=7200',
                // SEC-010: no Access-Control-Allow-Origin wildcard
              },
            })
          }
        }

        console.error(`❌ Failed to fetch thumbnail for ${fileId}: ${response.status}`)
        return NextResponse.json({ error: `Failed to fetch thumbnail: ${response.status}` }, { status: response.status })
      }

      const contentType = response.headers.get('content-type') || 'image/jpeg'
      const imageBuffer = await response.arrayBuffer()

      if (imageBuffer.byteLength === 0) {
        console.error(`❌ Empty thumbnail data for ${fileId}`)
        return NextResponse.json({ error: "Empty thumbnail data" }, { status: 400 })
      }

      return new NextResponse(imageBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=7200',
          // SEC-010: no Access-Control-Allow-Origin wildcard
        },
      })
    } catch (fetchError) {
      clearTimeout(timeoutId)
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error(`❌ Thumbnail fetch timeout for ${fileId}`)
        return NextResponse.json({ error: "Thumbnail fetch timeout" }, { status: 408 })
      }
      throw fetchError
    }
  } catch (error) {
    console.error("❌ Thumbnail proxy error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
