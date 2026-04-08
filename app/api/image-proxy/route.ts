import { type NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { getAuthenticatedDownloadUrl } from "@/lib/drive"
import { imageRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"

// SSRF allowlist — only proxy URLs from trusted Google hosts (SEC-001)
const ALLOWED_HOSTS = [
  'lh3.googleusercontent.com',
  'drive.google.com',
  'googleusercontent.com',
  'googleapis.com',
]

function isAllowedUrl(urlString: string): boolean {
  try {
    const parsed = new URL(urlString)
    if (parsed.protocol !== 'https:') return false
    return ALLOWED_HOSTS.some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`))
  } catch {
    return false
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

    const { userId } = await auth()

    // Try to get Google OAuth token from SSO connection (optional)
    let accessToken: string | null = null
    if (userId) {
      try {
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(userId, 'google')
        if (tokenResponse?.data?.[0]?.token) {
          accessToken = tokenResponse.data[0].token
        }
      } catch {
        console.log("ℹ️ No Google OAuth token available for image, will use API key")
      }
    }

    const { searchParams } = new URL(request.url)
    const imageUrl = searchParams.get("url")
    const fileId = searchParams.get("fileId")

    if (!imageUrl && !fileId) {
      return NextResponse.json({ error: "URL or fileId parameter is required" }, { status: 400 })
    }

    let finalUrl: string

    if (fileId && !imageUrl) {
      // fileId-derived URLs are always googleapis.com — safe
      finalUrl = getAuthenticatedDownloadUrl(fileId)
    } else if (imageUrl) {
      // Validate explicit URL against allowlist (SEC-001)
      if (!isAllowedUrl(imageUrl)) {
        return NextResponse.json({ error: "URL not allowed" }, { status: 400 })
      }
      finalUrl = imageUrl
    } else {
      return NextResponse.json({ error: "No valid image URL" }, { status: 400 })
    }

    console.log(`🖼️ Proxying image: ${fileId || 'unknown'}`)

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000)

    try {
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      }

      if (accessToken) {
        headers.Authorization = `Bearer ${accessToken}`
      }

      const response = await fetch(finalUrl, {
        headers,
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (!response.ok) {
        console.error(`❌ Failed to fetch image ${fileId}: ${response.status} ${response.statusText}`)
        return NextResponse.json({
          error: `Failed to fetch image: ${response.status} ${response.statusText}`
        }, { status: response.status })
      }

      const contentType = response.headers.get('content-type') || ''
      if (!contentType.startsWith('image/')) {
        console.error(`❌ Invalid content type for ${fileId}: ${contentType}`)
        return NextResponse.json({
          error: "The requested resource isn't a valid image",
          contentType,
          fileId
        }, { status: 400 })
      }

      const imageBuffer = await response.arrayBuffer()

      if (imageBuffer.byteLength === 0) {
        console.error(`❌ Empty image data for ${fileId}`)
        return NextResponse.json({ error: "Empty image data" }, { status: 400 })
      }

      console.log(`✅ Successfully proxied image ${fileId}: ${contentType} (${imageBuffer.byteLength} bytes)`)

      return new NextResponse(imageBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600',
          // SEC-010: no Access-Control-Allow-Origin wildcard
        },
      })
    } catch (fetchError) {
      clearTimeout(timeoutId)
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        console.error(`❌ Image fetch timeout for ${fileId}`)
        return NextResponse.json({ error: "Image fetch timeout" }, { status: 408 })
      }
      throw fetchError
    }
  } catch (error) {
    console.error("❌ Image proxy error:", error)
    if (error instanceof Error) {
      if (error.message.includes('ETIMEDOUT')) {
        return NextResponse.json({ error: "Image download timeout" }, { status: 408 })
      }
      if (error.message.includes('ENOTFOUND')) {
        return NextResponse.json({ error: "Image not found" }, { status: 404 })
      }
    }
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
