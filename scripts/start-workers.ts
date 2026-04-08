import { folderWorker, imageWorker } from "../lib/workers"
import { prisma } from "../lib/prisma"
import { queueImageBatch } from "../lib/queue"
import { decrypt } from "../lib/encryption"

// Prevent overlapping recoveries
let isRecovering = false

// Check for pending images and re-queue them
async function recoverPendingImages() {
  if (isRecovering) return
  isRecovering = true
  try {
    console.log("🔍 Checking for pending images to recover...")
    
    // Find folders with pending images
    const foldersWithPending = await prisma.folder.findMany({
      where: {
        status: { in: ["processing", "pending"] },
        images: {
          some: {
            status: "pending"
          }
        }
      },
      include: {
        images: {
          where: {
            status: "pending"
          },
          select: {
            id: true,
            fileId: true,
            etag: true,
            mimeType: true,
            name: true,
          },
          take: 500, // higher limit for larger folders
        }
      }
    })

    if (foldersWithPending.length === 0) {
      console.log("✅ No pending images found")
      return
    }

    console.log(`📋 Found ${foldersWithPending.length} folders with pending images`)

    for (const folder of foldersWithPending) {
      if (folder.images.length === 0) continue

      console.log(`🔄 Re-queuing ${folder.images.length} pending images for folder ${folder.folderId}`)

      // Update folder status to processing
      await prisma.folder.update({
        where: { id: folder.id },
        data: { status: "processing" },
      })

      // Queue images in batches of 5
      const batchSize = 5
      for (let i = 0; i < folder.images.length; i += batchSize) {
        const batch = folder.images.slice(i, i + batchSize)
        const batchData = batch.map(img => ({
          imageId: img.id,
          fileId: img.fileId,
          etag: img.etag || "unknown",
          folderId: folder.id,
          mimeType: img.mimeType,
          name: img.name
        }))
        
        // Get stored token if available
        let accessToken: string | undefined = undefined
        if (folder.accessTokenEncrypted && folder.tokenExpiresAt) {
          if (new Date() < folder.tokenExpiresAt) {
            try {
              accessToken = decrypt(folder.accessTokenEncrypted)
              console.log(`🔑 Using stored token for folder ${folder.folderId}`)
            } catch (e) {
              console.warn(`⚠️  Failed to decrypt token for folder ${folder.folderId}`)
            }
          } else {
            console.warn(`⚠️  Token expired for folder ${folder.folderId}`)
          }
        }
        
        await queueImageBatch({
          images: batchData,
          folderId: folder.id,
          accessToken // Now properly set!
        })
      }

      console.log(`✅ Re-queued ${folder.images.length} images for folder ${folder.folderId}`)
    }

    console.log("✅ Recovery complete")
  } catch (error) {
    console.error("❌ Error recovering pending images:", error)
    // Don't throw - allow workers to start even if recovery fails
  } finally {
    isRecovering = false
  }
}

// Run recovery on startup
recoverPendingImages().then(() => {
  console.log("Starting BullMQ workers...")
  console.log("- Folder worker: processing folders and queuing image jobs")
  console.log("- Image worker: processing individual images with AI captioning")
  console.log("Press Ctrl+C to stop workers")
})

// Periodic recovery: re-queue any stuck pending images every 60s
setInterval(() => {
  recoverPendingImages()
}, 60000)

// Keep the process alive - workers handle SIGINT/SIGTERM in lib/workers.ts
// These handlers just ensure clean exit after workers close

// Log worker status
setInterval(() => {
  console.log(`Workers running - Folder: ${folderWorker.isRunning()}, Image: ${imageWorker.isRunning()}`)
}, 30000) // Log every 30 seconds
