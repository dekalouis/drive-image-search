import { type NextRequest, NextResponse } from "next/server"
import { auth, currentUser } from "@clerk/nextjs/server"
import { clerkClient } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
import { listImagesRecursively, type DriveFile } from "@/lib/drive"
import { queueFolderProcessing } from "@/lib/queue"
import { encrypt } from "@/lib/encryption"
import { ingestRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"

// ARCH-007: OAuth token TTL — Google tokens expire in 3600s; use env override if needed.
// Clerk does not expose the actual expires_in, so we default to 55 min (conservative).
const OAUTH_TOKEN_TTL_MS = (() => {
  const minutes = parseInt(process.env.OAUTH_TOKEN_TTL_MINUTES || '55', 10)
  return (isNaN(minutes) || minutes <= 0 ? 55 : minutes) * 60 * 1000
})()

// Get the maximum images limit from environment variable
const getMaxImagesLimit = (): number | null => {
  const limit = process.env.MAX_IMAGES_PER_FOLDER
  if (!limit) return null

  const parsed = parseInt(limit, 10)
  return isNaN(parsed) || parsed <= 0 ? null : parsed
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting (strict limit for expensive operation)
    const identifier = getClientIdentifier(request)
    const rateLimitResult = await checkRateLimit(ingestRateLimiter, identifier)
    
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers: {
            ...getRateLimitHeaders(rateLimitResult, 10),
            'Retry-After': Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const { userId: clerkUserId } = await auth()
    
    // Try to get Google OAuth token from SSO connection (optional - will be null if user hasn't connected Google)
    let token: string | null = null
    if (clerkUserId) {
      try {
        // Try to get token from SSO connection using Clerk's API
        // Remove 'oauth_' prefix per Clerk deprecation warning
        const client = await clerkClient()
        const tokenResponse = await client.users.getUserOauthAccessToken(clerkUserId, 'google')
        
        if (tokenResponse && tokenResponse.data && tokenResponse.data.length > 0 && tokenResponse.data[0].token) {
          token = tokenResponse.data[0].token
          console.log("✅ Google OAuth token retrieved successfully from SSO connection")
        } else {
          console.log("ℹ️ No Google OAuth token available - user may need to connect Google account via SSO")
        }
      } catch (error) {
        // Token not available - user hasn't connected Google OAuth yet
        // This is fine, we'll use API key for public folders
        console.log("ℹ️ No Google OAuth token available, will use API key for public folders")
        console.log("   Error:", error instanceof Error ? error.message : String(error))
        console.log("   Note: User needs to sign in with Google SSO to access private folders")
      }
    } else {
      console.log("ℹ️ User not authenticated, will use API key for public folders")
    }
    
    const { folderUrl } = await request.json()

    if (!folderUrl) {
      return NextResponse.json({ error: "folderUrl is required" }, { status: 400 })
    }

    // Find or create user if authenticated
    let dbUserId: string | null = null
    if (clerkUserId) {
      console.log(`👤 Authenticated user: ${clerkUserId}`)
      
      // Get full user data from Clerk including email
      const clerkUser = await currentUser()
      const email = clerkUser?.emailAddresses?.[0]?.emailAddress || null
      
      const user = await prisma.user.upsert({
        where: { clerkId: clerkUserId },
        update: { email }, // Update email in case it changed
        create: { clerkId: clerkUserId, email },
      })
      dbUserId = user.id
    }

    // Extract folder ID from URL
    console.log("🔍 Extracting folder ID from URL...")
    const folderIdMatch = folderUrl.match(/\/folders\/([a-zA-Z0-9-_]+)/)
    if (!folderIdMatch) {
      return NextResponse.json({ error: "Invalid Google Drive folder URL" }, { status: 400 })
    }

    const folderId = folderIdMatch[1]
    console.log(`📁 Extracted folder ID: ${folderId}`)

    // Check if folder already exists
    console.log("🔍 Checking if folder already exists in database...")
    const existingFolder = await prisma.folder.findUnique({
      where: { folderId },
    })

    if (existingFolder) {
      console.log(`📁 Folder already exists with status: ${existingFolder.status}`)
      console.log(`   - Database ID: ${existingFolder.id}`)
      console.log(`   - Total Images: ${existingFolder.totalImages}`)
      console.log(`   - Processed Images: ${existingFolder.processedImages}`)
      
      // Sync folder with Google Drive to detect new/deleted images
      console.log("🔄 Syncing folder with Google Drive...")
      const driveResult = await listImagesRecursively(folderId, token || undefined)
      
      if (!driveResult.success) {
        console.log(`❌ Failed to sync folder: ${driveResult.error}`)
        return NextResponse.json({ error: driveResult.error }, { status: 403 })
      }
      
      // Get existing image fileIds from database
      const existingImages = await prisma.image.findMany({
        where: { folderId: existingFolder.id },
        select: { fileId: true },
      })
      const existingFileIds = new Set(existingImages.map(img => img.fileId))
      
      // Filter out unsupported MIME types
      const supportedMimeTypes = [
        'image/jpeg',
        'image/png',
        'image/gif',
        'image/webp',
        'image/bmp',
        'image/svg+xml'
      ]
      
      const supportedDriveImages = driveResult.images.filter(img => 
        img.mimeType && supportedMimeTypes.includes(img.mimeType)
      )
      
      const unsupportedImages = driveResult.images.filter(img => 
        img.mimeType && !supportedMimeTypes.includes(img.mimeType)
      )
      
      if (unsupportedImages.length > 0) {
        console.log(`⚠️  Skipping ${unsupportedImages.length} unsupported image(s) during sync:`)
        unsupportedImages.forEach(img => {
          console.log(`   - ${img.name || 'Unknown'} (${img.mimeType || 'Unknown'})`)
        })
      }
      
      // Find new images (in Drive but not in DB) - only supported types
      const driveFileIds = new Set(supportedDriveImages.map(img => img.id).filter(Boolean))
      const newImages = supportedDriveImages.filter(img => img.id && !existingFileIds.has(img.id))
      
      // Find deleted images (in DB but not in Drive)
      const deletedFileIds = [...existingFileIds].filter(fileId => !driveFileIds.has(fileId))
      
      console.log(`📊 Sync results:`)
      console.log(`   - Images in Drive: ${driveResult.count}`)
      console.log(`   - Images in DB: ${existingImages.length}`)
      console.log(`   - New images to add: ${newImages.length}`)
      console.log(`   - Deleted images to remove: ${deletedFileIds.length}`)
      
      let newImagesAdded = 0
      let deletedImagesRemoved = 0
      
      // Add new images to database
      if (newImages.length > 0) {
        // Check against maximum images limit
        const maxImagesLimit = getMaxImagesLimit()
        const totalAfterSync = existingImages.length - deletedFileIds.length + newImages.length
        if (maxImagesLimit && totalAfterSync > maxImagesLimit) {
          console.log(`❌ Folder would exceed maximum image limit after sync: ${totalAfterSync} > ${maxImagesLimit}`)
          return NextResponse.json({ 
            error: `Adding these images would exceed the limit of ${maxImagesLimit} images per folder!` 
          }, { status: 400 })
        }
        
        const imageData = newImages
          .filter((file): file is DriveFile & { id: string; name: string; mimeType: string } => 
            Boolean(file.id && file.name && file.mimeType))
          .map((file) => ({
            folderId: existingFolder.id,
            fileId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            thumbnailLink: file.thumbnailLink || "",
            webViewLink: file.webViewLink || "",
            size: file.size ? Number.parseInt(file.size) : null,
            md5Checksum: file.md5Checksum || null,
            modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
            etag: file.version || null,
            status: "pending",
          }))
        
        if (imageData.length > 0) {
          await prisma.image.createMany({ data: imageData })
          newImagesAdded = imageData.length
          console.log(`✅ Added ${newImagesAdded} new image records`)
        }
      }
      
      // Remove deleted images from database
      if (deletedFileIds.length > 0) {
        await prisma.image.deleteMany({
          where: {
            folderId: existingFolder.id,
            fileId: { in: deletedFileIds },
          },
        })
        deletedImagesRemoved = deletedFileIds.length
        console.log(`🗑️ Removed ${deletedImagesRemoved} deleted image records`)
      }
      
      // Update folder totals
      const updatedTotalImages = existingImages.length - deletedImagesRemoved + newImagesAdded
      const updatedProcessedImages = await prisma.image.count({
        where: { folderId: existingFolder.id, status: "completed" },
      })
      
      // Determine new status
      let newStatus = existingFolder.status
      if (newImagesAdded > 0) {
        newStatus = "processing" // Need to process new images
      } else if (updatedProcessedImages === updatedTotalImages && updatedTotalImages > 0) {
        newStatus = "completed"
      }
      
      // Update folder record
      await prisma.folder.update({
        where: { id: existingFolder.id },
        data: {
          name: driveResult.folderName,
          totalImages: updatedTotalImages,
          processedImages: updatedProcessedImages,
          status: newStatus,
          // Update token if new one is available
          accessTokenEncrypted: token ? encrypt(token) : undefined,
          tokenExpiresAt: token ? new Date(Date.now() + OAUTH_TOKEN_TTL_MS) : undefined, // ~55 min
        },
      })
      
      // Queue processing if there are new images
      if (newImagesAdded > 0) {
        console.log("🚀 Queueing folder processing for new images...")
        await queueFolderProcessing(existingFolder.id, folderId, token || undefined)
      } else if (existingFolder.status === "failed" || existingFolder.status === "pending") {
        console.log("🔄 Re-queueing folder processing...")
        await queueFolderProcessing(existingFolder.id, folderId, token || undefined)
      }

      return NextResponse.json({
        id: existingFolder.id,
        folderId: existingFolder.folderId,
        name: driveResult.folderName,
        folderUrl: existingFolder.folderUrl,
        status: newStatus,
        totalImages: updatedTotalImages,
        processedImages: updatedProcessedImages,
        createdAt: existingFolder.createdAt.toISOString(),
        newImagesAdded,
        deletedImagesRemoved,
        message: newImagesAdded > 0 || deletedImagesRemoved > 0 
          ? `Folder synced: +${newImagesAdded} new, -${deletedImagesRemoved} removed`
          : "Folder already up to date",
      })
    }

    // Validate folder access and get images (recursively including subfolders)
    console.log("🔍 Validating folder access and listing images recursively...")
    if (clerkUserId && token) {
      console.log(`🔑 Using OAuth token for authenticated access (user: ${clerkUserId})`)
    } else if (clerkUserId && !token) {
      console.log(`⚠️  User is logged in but no OAuth token available - will try public access`)
    } else {
      console.log(`ℹ️  Using API key for public folder access`)
    }
    const result = await listImagesRecursively(folderId, token || undefined)

    if (!result.success) {
      console.log(`❌ Folder validation failed: ${result.error}`)
      return NextResponse.json({ error: result.error }, { status: 403 })
    }

    console.log(`✅ Found ${result.count} images in folder "${result.folderName}"`)
    
    // Filter out unsupported MIME types (should already be filtered, but double-check)
    const supportedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/svg+xml'
    ]
    
    const unsupportedImages = result.images.filter(img => 
      img.mimeType && !supportedMimeTypes.includes(img.mimeType)
    )
    
    if (unsupportedImages.length > 0) {
      console.log(`⚠️  Skipping ${unsupportedImages.length} unsupported image(s):`)
      unsupportedImages.forEach(img => {
        console.log(`   - ${img.name || 'Unknown'} (${img.mimeType || 'Unknown'})`)
      })
    }
    
    const supportedImages = result.images.filter(img => 
      !img.mimeType || supportedMimeTypes.includes(img.mimeType)
    )
    
    // Check against maximum images limit (using supported images only)
    const maxImagesLimit = getMaxImagesLimit()
    if (maxImagesLimit && supportedImages.length > maxImagesLimit) {
      console.log(`❌ Folder exceeds maximum image limit: ${supportedImages.length} > ${maxImagesLimit}`)
      return NextResponse.json({ 
        error: `Your folder has too many images! Make sure that the folder does not contain more than ${maxImagesLimit} images!` 
      }, { status: 400 })
    }
    
    console.log(`📋 Processing ${supportedImages.length} supported images (skipped ${unsupportedImages.length} unsupported):`)
    supportedImages.forEach((img, index: number) => {
      console.log(`   ${index + 1}. ${img.name || 'Unknown'} (${img.mimeType || 'Unknown'}) - ${img.id || 'Unknown'}`)
    })

    if (result.count === 0) {
      console.log("❌ No images found in the folder")
      return NextResponse.json({ error: "No images found in the folder" }, { status: 400 })
    }

    // Create folder record (using supported images count)
    console.log("💾 Creating folder record in database...")
    const folder = await prisma.folder.create({
      data: {
        folderId,
        name: result.folderName,
        folderUrl,
        status: "pending",
        totalImages: supportedImages.length, // Only count supported images
        userId: dbUserId,
        // Store encrypted token for background processing
        accessTokenEncrypted: token ? encrypt(token) : null,
        tokenExpiresAt: token ? new Date(Date.now() + OAUTH_TOKEN_TTL_MS) : null, // ~55 min
      },
    })
    
    console.log(`✅ Created folder record with ID: ${folder.id}`)

    // Create image records (only for supported MIME types)
    console.log("💾 Creating image records in database...")
    const imageData = supportedImages
      .filter((file) => file.id && file.name && file.mimeType) // Filter out files without required fields
      .map((file) => ({
        folderId: folder.id,
        fileId: file.id!, // Non-null assertion since we filtered
        name: file.name!,
        mimeType: file.mimeType!,
        thumbnailLink: file.thumbnailLink || "",
        webViewLink: file.webViewLink || "",
        size: file.size ? Number.parseInt(file.size) : null,
        md5Checksum: file.md5Checksum,
        modifiedTime: file.modifiedTime ? new Date(file.modifiedTime) : null,
        etag: file.version,
        status: "pending",
      }))

    if (imageData.length === 0) {
      console.log("❌ No valid images found after filtering")
      return NextResponse.json({ error: "No valid images found in the folder" }, { status: 400 })
    }

    await prisma.image.createMany({
      data: imageData,
    })
    
    console.log(`✅ Created ${imageData.length} image records`)

    // Queue folder processing
    console.log("🚀 Queueing folder processing job...")
    await queueFolderProcessing(folder.id, folderId, token || undefined)
    console.log("✅ Folder processing job queued successfully")

    return NextResponse.json({
      id: folder.id,
      folderId: folder.folderId,
      name: folder.name,
      folderUrl: folder.folderUrl,
      status: folder.status,
      totalImages: folder.totalImages,
      processedImages: folder.processedImages,
      createdAt: folder.createdAt.toISOString(),
    })
  } catch (error) {
    console.error("❌ Ingest API error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
