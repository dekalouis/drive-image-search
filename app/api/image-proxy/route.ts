import { type NextRequest, NextResponse } from "next/server"
import { auth } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { getAuthenticatedDownloadUrl } from "@/lib/drive"

export async function GET(request: NextRequest) {
  try {
    const { userId } = await auth()
    
    // Try to get Google OAuth token from SSO connection (optional)
    let accessToken: string | null = null
    if (userId) {
      try {
        // Use Clerk's API to get OAuth token (fixes deprecation warning)
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(userId, 'google') // Remove 'oauth_' prefix
        
        if (tokenResponse && tokenResponse.data && tokenResponse.data.length > 0 && tokenResponse.data[0].token) {
          accessToken = tokenResponse.data[0].token
        }
      } catch (error) {
        // Token not available - will use API key for public folders
        console.log("ℹ️ No Google OAuth token available for image, will use API key")
      }
    }

    const { searchParams } = new URL(request.url)
    const imageUrl = searchParams.get("url")
    const fileId = searchParams.get("fileId")

    if (!imageUrl && !fileId) {
      return NextResponse.json({ error: "URL or fileId parameter is required" }, { status: 400 })
    }

    let finalUrl = imageUrl

    // If we have a fileId, use the authenticated Google Drive URL
    if (fileId && !imageUrl) {
      finalUrl = getAuthenticatedDownloadUrl(fileId)
    }

    if (!finalUrl) {
      return NextResponse.json({ error: "No valid image URL" }, { status: 400 })
    }

    console.log(`🖼️ Proxying image: ${fileId || 'unknown'}`)

    // Fetch the image with timeout and proper headers
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30000) // 30 second timeout

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

      // Check if the response is actually an image
      const contentType = response.headers.get('content-type') || ''
      if (!contentType.startsWith('image/')) {
        console.error(`❌ Invalid content type for ${fileId}: ${contentType}`)
        return NextResponse.json({ 
          error: "The requested resource isn't a valid image",
          contentType,
          fileId 
        }, { status: 400 })
      }

      // Get the image data
      const imageBuffer = await response.arrayBuffer()

      if (imageBuffer.byteLength === 0) {
        console.error(`❌ Empty image data for ${fileId}`)
        return NextResponse.json({ error: "Empty image data" }, { status: 400 })
      }

      console.log(`✅ Successfully proxied image ${fileId}: ${contentType} (${imageBuffer.byteLength} bytes)`)

      // Return the image with proper headers
      return new NextResponse(imageBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
          'Access-Control-Allow-Origin': '*',
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
    
    // Provide more specific error messages
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