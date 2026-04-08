import { type NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { imageRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"
import { validateFolderAccess } from "@/lib/folder-auth"
import { cleanCaption } from "@/lib/caption-utils"

export async function GET(request: NextRequest) {
  try {
    // Rate limiting
    const identifier = getClientIdentifier(request)
    const rateLimitResult = await checkRateLimit(imageRateLimiter, identifier)
    
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers: {
            ...getRateLimitHeaders(rateLimitResult, 100),
            'Retry-After': Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const { searchParams } = new URL(request.url)
    const folderId = searchParams.get("folderId")

    if (!folderId) {
      return NextResponse.json({ error: "folderId parameter is required" }, { status: 400 })
    }

    // Validate folder access (SEC-002)
    const { folder, hasAccess } = await validateFolderAccess(folderId)

    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
    }

    if (!hasAccess) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Get images for this folder
    const images = await prisma.image.findMany({
      where: { folderId },
      select: {
        id: true,
        fileId: true,
        name: true,
        thumbnailLink: true,
        webViewLink: true,
        status: true,
        caption: true,
        error: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    })

    // Update folder progress from actual image counts
    const processedImages = images.filter(img => img.status === "completed").length
    const totalImages = images.length
    
    // Update status based on actual counts
    let status = folder.status
    if (processedImages === totalImages && totalImages > 0) {
      status = "completed"
    } else if (processedImages > 0 || images.some(img => img.status === "processing")) {
      status = "processing"
    }

    // Update folder if counts changed
    if (processedImages !== folder.processedImages || totalImages !== folder.totalImages || status !== folder.status) {
      await prisma.folder.update({
        where: { id: folderId },
        data: { processedImages, totalImages, status },
      })
    }

    // Clean captions for all images
    const cleanedImages = images.map(image => ({
      ...image,
      caption: image.caption ? cleanCaption(image.caption) : undefined
    }))

    return NextResponse.json({
      ...folder,
      totalImages,
      processedImages,
      status,
      images: cleanedImages,
    })
  } catch (error) {
    console.error("Images API error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
