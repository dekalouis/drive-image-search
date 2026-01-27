import { type NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"

// Helper function to clean captions
function cleanCaption(caption?: string): string | undefined {
  if (!caption) return undefined
  
  // Handle HTML-encoded JSON strings
  let cleanedCaption = caption
  
  // Decode HTML entities first
  if (caption.includes('&quot;')) {
    cleanedCaption = caption.replace(/&quot;/g, '"')
  }
  
  // Remove markdown code blocks if present
  if (cleanedCaption.startsWith('```json') && cleanedCaption.endsWith('```')) {
    cleanedCaption = cleanedCaption.replace(/^```json\n/, '').replace(/\n```$/, '')
  }
  
  // If caption contains JSON structure, extract just the caption text
  if (cleanedCaption.includes('"caption"')) {
    try {
      const parsed = JSON.parse(cleanedCaption)
      return parsed.caption || caption
    } catch {
      // If parsing fails, return as is
      return caption
    }
  }
  
  return caption
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const folderId = searchParams.get("folderId")

    if (!folderId) {
      return NextResponse.json({ error: "folderId parameter is required" }, { status: 400 })
    }

    // Get folder data
    const folder = await prisma.folder.findUnique({
      where: { id: folderId },
      select: {
        id: true,
        folderId: true,
        status: true,
        totalImages: true,
        processedImages: true,
      },
    })

    if (!folder) {
      return NextResponse.json({ error: "Folder not found" }, { status: 404 })
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
