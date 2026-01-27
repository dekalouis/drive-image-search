import { prisma } from "../lib/prisma"
import { queueImageBatch } from "../lib/queue"

/**
 * Process remaining pending images in a folder without resetting completed ones
 * Usage: npx tsx scripts/process-remaining-images.ts <folderId>
 */
async function processRemainingImages(folderId: string) {
  console.log(`🔄 Processing remaining images for folder: ${folderId}`)
  
  try {
    // Find the folder by database ID or Google folder ID
    const folder = await prisma.folder.findFirst({
      where: {
        OR: [
          { id: folderId },
          { folderId: folderId }
        ]
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
          }
        }
      }
    })
    
    if (!folder) {
      console.log(`❌ Folder not found: ${folderId}`)
      console.log(`   Try using the database ID or Google folder ID`)
      return
    }
    
    const pendingImages = folder.images
    console.log(`📁 Found folder: ${folder.id}`)
    console.log(`   Name: ${folder.name || folder.folderId}`)
    console.log(`   Status: ${folder.status}`)
    console.log(`   Total Images: ${folder.totalImages}`)
    console.log(`   Processed Images: ${await prisma.image.count({ where: { folderId: folder.id, status: "completed" } })}`)
    console.log(`   Pending Images: ${pendingImages.length}`)
    
    if (pendingImages.length === 0) {
      console.log(`✅ No pending images to process!`)
      return
    }
    
    // Update folder status to processing if it's not already
    if (folder.status !== "processing") {
      await prisma.folder.update({
        where: { id: folder.id },
        data: { status: "processing" },
      })
      console.log(`📝 Updated folder status to "processing"`)
    }
    
    // Queue image processing jobs in batches of 5
    const batchSize = 5
    let queuedBatches = 0
    
    for (let i = 0; i < pendingImages.length; i += batchSize) {
      const batch = pendingImages.slice(i, i + batchSize)
      const batchData = batch.map(img => ({
        imageId: img.id,
        fileId: img.fileId,
        etag: img.etag || "unknown",
        folderId: folder.id,
        mimeType: img.mimeType,
        name: img.name
      }))
      
      await queueImageBatch({
        images: batchData,
        folderId: folder.id,
        accessToken: undefined // Will be retrieved by workers if needed
      })
      queuedBatches++
      console.log(`✅ Queued batch ${queuedBatches} with ${batch.length} images`)
    }
    
    console.log(`\n🎉 Successfully queued ${queuedBatches} batches (${pendingImages.length} images)`)
    console.log(`   Workers will process these images in the background`)
    
  } catch (error) {
    console.error("❌ Error processing remaining images:", error)
    throw error
  }
  
  process.exit(0)
}

// Get folder ID from command line argument
const folderId = process.argv[2]
if (!folderId) {
  console.log("❌ Please provide a folder ID as argument")
  console.log("Usage: npx tsx scripts/process-remaining-images.ts <folderId>")
  console.log("   folderId can be the database ID or Google folder ID")
  process.exit(1)
}

processRemainingImages(folderId)

