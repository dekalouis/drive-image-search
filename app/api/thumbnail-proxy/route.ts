import { type NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { getFreshThumbnailUrl } from "@/lib/drive"
import { prisma } from "@/lib/prisma"

// In-memory cache for thumbnail URLs (simple TTL cache)
const thumbnailCache = new Map<string, { url: string; expiresAt: number }>()
const CACHE_TTL_MS = 2 * 60 * 60 * 1000 // 2 hours
let accessesSinceCleanup = 0
const CLEANUP_INTERVAL = 100 // Clean every 100 accesses

function cleanupExpiredEntries() {
  const now = Date.now()
  let cleaned = 0
  const maxCleanupBatch = 100
  
  for (const [key, value] of thumbnailCache.entries()) {
    if (value.expiresAt < now) {
      thumbnailCache.delete(key)
      cleaned++
      if (cleaned >= maxCleanupBatch) break
    }
  }
  
  if (cleaned > 0) {
    console.log(`🧹 Thumbnail cache cleanup: removed ${cleaned} expired entries (total: ${thumbnailCache.size})`)
  }
}

function getCachedThumbnailUrl(fileId: string, size: number): string | null {
  accessesSinceCleanup++
  
  // Periodic cleanup
  if (accessesSinceCleanup >= CLEANUP_INTERVAL) {
    cleanupExpiredEntries()
    accessesSinceCleanup = 0
  }
  
  const cacheKey = `${fileId}-${size}`
  const cached = thumbnailCache.get(cacheKey)
  
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url
  }
  
  // Clean up expired entry
  if (cached) {
    thumbnailCache.delete(cacheKey)
  }
  
  return null
}

function setCachedThumbnailUrl(fileId: string, size: number, url: string): void {
  const cacheKey = `${fileId}-${size}`
  thumbnailCache.set(cacheKey, {
    url,
    expiresAt: Date.now() + CACHE_TTL_MS,
  })
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const fileId = searchParams.get("fileId")
    const sizeParam = searchParams.get("size")
    const size = sizeParam ? parseInt(sizeParam, 10) : 220

    if (!fileId) {
      return NextResponse.json({ error: "fileId parameter is required" }, { status: 400 })
    }
    
    // Get auth info - try current user first
    let userId: string | null = null
    let clerkUserId: string | null = null
    try {
      const authResult = await auth()
      clerkUserId = authResult?.userId || null
      console.log(`🔍 Thumbnail request - current userId: ${clerkUserId || 'null'}, fileId: ${fileId.substring(0, 10)}...`)
    } catch (authError) {
      console.log(`⚠️ Auth error in thumbnail-proxy: ${authError instanceof Error ? authError.message : String(authError)}`)
    }
    
    // If no current user, try to find the folder owner from the database
    // This handles cases where the folder was created by a logged-in user but current session isn't available
    if (!clerkUserId) {
      try {
        // Find the image to get its folder, then get the folder's user
        const image = await prisma.image.findUnique({
          where: { fileId },
          select: {
            folder: {
              select: {
                userId: true,
                user: {
                  select: {
                    clerkId: true,
                  },
                },
              },
            },
          },
        })
        
        if (image?.folder?.user?.clerkId) {
          clerkUserId = image.folder.user.clerkId
          console.log(`🔍 Found folder owner from DB: ${clerkUserId.substring(0, 10)}... for fileId: ${fileId.substring(0, 10)}...`)
        }
      } catch (dbError) {
        console.log(`⚠️ Error looking up folder owner: ${dbError instanceof Error ? dbError.message : String(dbError)}`)
      }
    }
    
    // Try to get Google OAuth token from SSO connection (optional)
    let accessToken: string | null = null
    if (clerkUserId) {
      try {
        // Use Clerk's API to get OAuth token (fixes deprecation warning)
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(clerkUserId, 'google') // Remove 'oauth_' prefix
        
        if (tokenResponse && tokenResponse.data && tokenResponse.data.length > 0 && tokenResponse.data[0].token) {
          accessToken = tokenResponse.data[0].token
          console.log(`✅ OAuth token retrieved for thumbnail request (fileId: ${fileId.substring(0, 10)}...)`)
        } else {
          console.log(`ℹ️ No OAuth token in response for user ${clerkUserId.substring(0, 10)}... (fileId: ${fileId.substring(0, 10)}...)`)
        }
      } catch (error) {
        // Token not available - will use API key for public folders
        console.log(`ℹ️ No Google OAuth token available for thumbnail (fileId: ${fileId.substring(0, 10)}...), will use API key`)
        console.log(`   Error: ${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      console.log(`ℹ️ No userId found (current or from DB), using API key for thumbnail (fileId: ${fileId.substring(0, 10)}...)`)
    }

    if (isNaN(size) || size < 32 || size > 1600) {
      return NextResponse.json({ error: "Invalid size parameter (32-1600)" }, { status: 400 })
    }

    // Check cache first
    let thumbnailUrl = getCachedThumbnailUrl(fileId, size)
    
    if (!thumbnailUrl) {
      // Fetch fresh thumbnail URL from Google Drive API (pass OAuth token for private files)
      thumbnailUrl = await getFreshThumbnailUrl(fileId, size, accessToken || undefined)
      
      if (!thumbnailUrl) {
        console.error(`❌ No thumbnail available for file ${fileId}`)
        return NextResponse.json({ error: "Thumbnail not available" }, { status: 404 })
      }
      
      // Cache the URL
      setCachedThumbnailUrl(fileId, size, thumbnailUrl)
    }

    // Fetch the actual thumbnail image
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000) // 10 second timeout (reduced from 15s)

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
        // If the cached URL failed, try fetching a fresh one
        if (getCachedThumbnailUrl(fileId, size)) {
          thumbnailCache.delete(`${fileId}-${size}`)
          const freshUrl = await getFreshThumbnailUrl(fileId, size, accessToken || undefined)
          
          if (freshUrl) {
            setCachedThumbnailUrl(fileId, size, freshUrl)
            const retryResponse = await fetch(freshUrl, {
              headers,
            })
            
            if (retryResponse.ok) {
              const imageBuffer = await retryResponse.arrayBuffer()
              const contentType = retryResponse.headers.get('content-type') || 'image/jpeg'
              
              return new NextResponse(imageBuffer, {
                status: 200,
                headers: {
                  'Content-Type': contentType,
                  'Cache-Control': 'public, max-age=7200', // 2 hours
                  'Access-Control-Allow-Origin': '*',
                },
              })
            }
          }
        }
        
        console.error(`❌ Failed to fetch thumbnail for ${fileId}: ${response.status}`)
        return NextResponse.json({ 
          error: `Failed to fetch thumbnail: ${response.status}` 
        }, { status: response.status })
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
          'Cache-Control': 'public, max-age=7200', // 2 hours
          'Access-Control-Allow-Origin': '*',
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


