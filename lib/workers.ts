import { Worker, type Job } from "bullmq"
import IORedis from "ioredis"
import { prisma } from "@/lib/prisma"
import { ensureCaptionVectorIndex } from "@/lib/db-init"
import { captionImage, generateCaptionEmbedding, generateBatchEmbeddings, geminiRateLimiter } from "@/lib/gemini"
import type { FolderJobData, ImageJobData, ImageBatchJobData } from "@/lib/queue"
import { queueImageBatch } from "@/lib/queue"

// Redis connection for workers with reconnection logic
const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  // Reconnection settings for Railway restarts
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000) // Max 3 second delay
    console.log(`🔄 Redis reconnecting... attempt ${times}, delay ${delay}ms`)
    return delay
  },
  reconnectOnError: (err) => {
    console.log(`🔄 Redis reconnect on error: ${err.message}`)
    return true // Always try to reconnect
  },
  enableReadyCheck: true,
  lazyConnect: false,
})

// Add connection event logging
connection.on("connect", () => {
  console.log("🔗 Worker Redis connected successfully")
})

connection.on("error", (error) => {
  console.error("❌ Worker Redis connection error:", error)
})

connection.on("ready", () => {
  console.log("✅ Worker Redis ready for operations")
})

connection.on("reconnecting", () => {
  console.log("🔄 Worker Redis reconnecting...")
})

connection.on("close", () => {
  console.log("⚠️ Worker Redis connection closed")
})

// Progress tracking for folders
const folderProgress = new Map<string, { startTime: number; totalImages: number; processedImages: number }>()

// Cleanup stale progress entries
async function cleanupStaleProgress() {
  const now = Date.now()
  const maxAge = 30 * 60 * 1000 // 30 minutes
  
  for (const [folderId, data] of folderProgress.entries()) {
    // Remove entries older than maxAge
    if (now - data.startTime > maxAge) {
      console.log(`🧹 Cleaning up stale progress for folder ${folderId} (age: ${Math.round((now - data.startTime) / 60000)} minutes)`)
      folderProgress.delete(folderId)
      continue
    }
    
    // Check if folder is still processing in DB
    try {
      const folder = await prisma.folder.findUnique({
        where: { id: folderId },
        select: { status: true }
      })
      
      if (!folder || folder.status !== 'processing') {
        console.log(`🧹 Cleaning up progress for folder ${folderId} (status: ${folder?.status || 'not found'})`)
        folderProgress.delete(folderId)
      }
    } catch (error) {
      console.warn(`⚠️ Error checking folder status during cleanup: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupStaleProgress, 5 * 60 * 1000)

// Export progress tracking for external monitoring
export function getFolderProgress() {
  const progress = Array.from(folderProgress.entries()).map(([folderId, data]) => {
    const elapsedTime = Date.now() - data.startTime
    const imagesPerMinute = data.processedImages > 0 ? (data.processedImages / (elapsedTime / 60000)) : 0
    const avgTimePerImage = data.processedImages > 0 ? elapsedTime / data.processedImages : 0
    const remainingImages = data.totalImages - data.processedImages
    const estimatedTimeRemaining = remainingImages * avgTimePerImage
    const progressPercent = Math.round((data.processedImages / data.totalImages) * 100)

    return {
      folderId,
      totalImages: data.totalImages,
      processedImages: data.processedImages,
      progressPercent,
      elapsedTime: Math.round(elapsedTime / 1000),
      imagesPerMinute: Math.round(imagesPerMinute),
      avgTimePerImage: Math.round(avgTimePerImage),
      estimatedTimeRemaining: Math.round(estimatedTimeRemaining / 1000),
      startTime: new Date(data.startTime).toISOString(),
    }
  })

  return progress
}

// Get overall processing statistics
export async function getProcessingStats() {
  const progress = getFolderProgress()
  
  // Get queue statistics
  const { getQueueStats } = await import("@/lib/queue")
  const queueStats = await getQueueStats()
  
  // Calculate overall metrics
  const totalImages = progress.reduce((sum, p) => sum + p.totalImages, 0)
  const totalProcessed = progress.reduce((sum, p) => sum + p.processedImages, 0)
  const overallProgress = totalImages > 0 ? Math.round((totalProcessed / totalImages) * 100) : 0
  
  const avgImagesPerMinute = progress.length > 0 
    ? progress.reduce((sum, p) => sum + p.imagesPerMinute, 0) / progress.length 
    : 0

  return {
    folders: progress,
    queueStats,
    overall: {
      totalImages,
      totalProcessed,
      overallProgress,
      avgImagesPerMinute: Math.round(avgImagesPerMinute),
      activeFolders: progress.length,
    }
  }
}

// Folder worker - processes folder analysis jobs
export const folderWorker = new Worker(
  "folders",
  async (job: Job<FolderJobData>) => {
    const startTime = Date.now()
    console.log(`🎯 Folder worker received job: ${job.id} (${job.name})`)
    console.log(`📋 Job data:`, job.data)
    
      const { folderId, googleFolderId, accessToken } = job.data

    console.log(`🚀 Starting folder processing: ${googleFolderId} at ${new Date().toISOString()}`)

    try {
      // Update folder status to processing
      await prisma.folder.update({
        where: { id: folderId },
        data: { status: "processing" },
      })

      // Get all pending images for this folder
      const images = await prisma.image.findMany({
        where: {
          folderId,
          status: "pending",
        },
        select: {
          id: true,
          fileId: true,
          etag: true,
          mimeType: true,
          name: true,
        },
      })

      console.log(`📊 Found ${images.length} images to process for folder ${googleFolderId}`)

      // Initialize progress tracking
      folderProgress.set(folderId, {
        startTime,
        totalImages: images.length,
        processedImages: 0,
      })

      // Queue image processing jobs
      // Use batch processing for speed (5 images per batch to mirror Test project)
      const batchSize = 5
      let queuedBatches = 0
      
      for (let i = 0; i < images.length; i += batchSize) {
        const batch = images.slice(i, i + batchSize)
        const batchData = batch.map(img => ({
          imageId: img.id,
          fileId: img.fileId,
          etag: img.etag || "unknown",
          folderId,
          mimeType: img.mimeType,
          name: img.name
        }))
        
        await queueImageBatch({
          images: batchData,
          folderId,
          accessToken
        })
        queuedBatches++
      }

      const queueTime = Date.now() - startTime
      console.log(`✅ Queued ${queuedBatches} batches (${images.length} images) for folder ${googleFolderId}`)
      console.log(`⏱️  Queue time: ${queueTime}ms`)

      // Check if all images are already processed
      const totalImages = await prisma.image.count({
        where: { folderId },
      })

      const processedImages = await prisma.image.count({
        where: { folderId, status: "completed" },
      })

      if (processedImages === totalImages) {
        await prisma.folder.update({
          where: { id: folderId },
          data: { status: "completed" },
        })
        console.log(`🎉 Folder ${googleFolderId} already completed!`)
      }

      return { success: true, queuedImages: images.length, queuedBatches, queueTime }
    } catch (error) {
      console.error(`❌ Folder processing failed for ${googleFolderId}:`, error)

      await prisma.folder.update({
        where: { id: folderId },
        data: { status: "failed" },
      })

      throw error
    }
  },
  {
    connection,
    concurrency: 2, // Lower to reduce memory/CPU spikes on Railway
    // Stalled job handling - critical for Railway restarts
    lockDuration: 120000, // 2 minutes - jobs can take time for large folders
    stalledInterval: 30000, // Check for stalled jobs every 30 seconds
    maxStalledCount: 3, // Retry stalled jobs up to 3 times
  },
)

// Helper function to generate caption for a single image
async function processImageCaption(image: { imageId: string, fileId: string, etag: string, folderId: string, mimeType?: string, name?: string, accessToken?: string }): Promise<{ success: boolean; imageId: string; fileId: string; caption?: string; error?: string }> {
  const { imageId, fileId, mimeType: providedMimeType, accessToken } = image
  
  try {
    // Get image mime type if not provided
    let mimeType = providedMimeType
    if (!mimeType) {
      const dbImage = await prisma.image.findUnique({
        where: { id: imageId },
        select: { mimeType: true },
      })
      if (dbImage) {
        mimeType = dbImage.mimeType
      }
    }

    if (!mimeType) {
      throw new Error("Image MIME type not found")
    }

    // Rate limiting for Gemini
    await geminiRateLimiter.waitIfNeeded()

    // Generate caption only
    const { caption } = await captionImage(fileId, mimeType, accessToken)

    return {
      success: true,
      imageId,
      fileId,
      caption,
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    return {
      success: false,
      imageId,
      fileId,
      error: errorMessage,
    }
  }
}

// Helper function to generate embedding for a caption and store it
async function processImageEmbedding(imageId: string, folderId: string, caption: string, embedding: number[]) {
  try {
    // Update image with results - try with pgvector, fallback to regular update if unavailable
    const dbUpdateStart = Date.now()
    try {
      // Ensure pgvector + HNSW index exist before we attempt to persist embeddings
      await ensureCaptionVectorIndex()

      // Update with vector embedding using raw SQL for pgvector
      const vectorString = `[${embedding.join(',')}]`
      await prisma.$executeRaw`
        UPDATE images 
        SET 
          status = 'completed',
          caption = ${caption},
          "captionVec" = ${vectorString}::vector,
          "updatedAt" = NOW()
        WHERE id = ${imageId}
      `
    } catch (error: any) {
      // If pgvector is not available, save without embedding
      const errorMessage = error?.message || String(error)
      if (errorMessage.includes('pgvector') || errorMessage.includes('vector') || errorMessage.includes('extension')) {
        console.warn(`⚠️  pgvector not available for ${imageId}, saving without embedding: ${errorMessage}`)
        
        // Fallback: Update without vector embedding
        await prisma.image.update({
          where: { id: imageId },
          data: {
            status: 'completed',
            caption,
            updatedAt: new Date(),
          },
        })
      } else {
        // Re-throw non-pgvector errors
        throw error
      }
    }
    const dbUpdateTime = Date.now() - dbUpdateStart

    // Update folder progress
    await updateFolderProgress(folderId)

    return {
      success: true,
      imageId,
      dbUpdateTime
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`❌ Failed to store embedding for ${imageId}: ${errorMessage}`)

    // Update progress even for failed images
    const currentProgress = folderProgress.get(folderId)
    if (currentProgress) {
      currentProgress.processedImages += 1
      folderProgress.set(folderId, currentProgress)
    }

    // Update database to mark image as failed
    await prisma.image.update({
      where: { id: imageId },
      data: { 
        status: 'failed',
        error: errorMessage.substring(0, 500)
      }
    })

    return {
      success: false,
      imageId,
      error: errorMessage,
    }
  }
}

// Helper function to process a single image (used inside batch or single job)
async function processImage(image: { imageId: string, fileId: string, etag: string, folderId: string, mimeType?: string, name?: string, accessToken?: string }) {
  const { imageId, fileId, etag, folderId, accessToken } = image
  const startTime = Date.now()
  
  console.log(`🚀 Starting image processing: ${fileId} (etag: ${etag})`)

  try {
    // ETag-based deduplication: Skip if image already processed and unchanged
    const existingImage = await prisma.image.findUnique({
      where: { id: imageId },
      select: { status: true, etag: true, caption: true }
    })

    if (existingImage?.status === 'completed' && existingImage.etag === etag && existingImage.caption) {
      console.log(`⏭️  Skipping unchanged image: ${fileId} (etag: ${etag})`)
      
      // Still update progress tracking
      const currentProgress = folderProgress.get(folderId)
      if (currentProgress) {
        currentProgress.processedImages += 1
        folderProgress.set(folderId, currentProgress)
      }
      
      return { success: true, skipped: true, imageId }
    }

    // Update image status to processing (skip if batch, as it adds overhead, but safer for tracking)
    await prisma.image.update({
      where: { id: imageId },
      data: { status: "processing" },
    })

    // Get image details if not provided
    let mimeType = image.mimeType
    let name = image.name
    
    if (!mimeType || !name) {
      const dbImage = await prisma.image.findUnique({
        where: { id: imageId },
        select: { mimeType: true, name: true },
      })
      if (dbImage) {
        mimeType = dbImage.mimeType
        name = dbImage.name
      }
    }

    if (!mimeType || !name) {
      throw new Error("Image not found or details missing")
    }

    // Safety check: Skip unsupported MIME types (shouldn't happen if filtering works, but double-check)
    const supportedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/svg+xml'
    ]
    
    if (!supportedMimeTypes.includes(mimeType)) {
      console.log(`⚠️  Skipping unsupported MIME type: ${mimeType} for ${name}`)
      await prisma.image.update({
        where: { id: imageId },
        data: { 
          status: "failed",
          error: `Unsupported MIME type: ${mimeType}. Gemini only supports: ${supportedMimeTypes.join(', ')}`
        },
      })
      return { success: false, error: `Unsupported MIME type: ${mimeType}` }
    }

    console.log(`📥 Downloading/Processing image: ${name}`)

    // Rate limiting
    await geminiRateLimiter.waitIfNeeded()

    // Generate caption using full image analysis
    const captioningStart = Date.now()
    const { caption } = await captionImage(fileId, mimeType, accessToken)
    const captioningTime = Date.now() - captioningStart

    console.log(`📝 Generated caption for ${name}`)
    console.log(`⏱️  Captioning time: ${captioningTime}ms`)

    // Generate embedding for the caption
    const embeddingStart = Date.now()
    const embedding = await generateCaptionEmbedding(caption)
    const embeddingTime = Date.now() - embeddingStart

    // Update image with results - try with pgvector, fallback to regular update if unavailable
    const dbUpdateStart = Date.now()
    try {
      // Ensure pgvector + HNSW index exist before we attempt to persist embeddings
      await ensureCaptionVectorIndex()

      // Update with vector embedding using raw SQL for pgvector
      const vectorString = `[${embedding.join(',')}]`
      await prisma.$executeRaw`
        UPDATE images 
        SET 
          status = 'completed',
          caption = ${caption},
          "captionVec" = ${vectorString}::vector,
          "updatedAt" = NOW()
        WHERE id = ${imageId}
      `
    } catch (error: any) {
      // If pgvector is not available, save without embedding
      const errorMessage = error?.message || String(error)
      if (errorMessage.includes('pgvector') || errorMessage.includes('vector') || errorMessage.includes('extension')) {
        console.warn(`⚠️  pgvector not available for ${fileId}, saving without embedding: ${errorMessage}`)
        
        // Fallback: Update without vector embedding
        await prisma.image.update({
          where: { id: imageId },
          data: {
            status: 'completed',
            caption,
            updatedAt: new Date(),
          },
        })
      } else {
        // Re-throw non-pgvector errors
        throw error
      }
    }
    const dbUpdateTime = Date.now() - dbUpdateStart

    // Update folder progress (can be done in batch later, but keeping per image for granular UI updates)
    await updateFolderProgress(folderId)

    const totalTime = Date.now() - startTime
    console.log(`✅ Completed processing image: ${fileId} in ${totalTime}ms`)

    return {
      success: true,
      imageId,
      fileId,
      caption: caption.substring(0, 100),
      processingTime: totalTime,
      captioningTime,
      embeddingTime,
      dbUpdateTime
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    console.error(`❌ Image processing failed for ${fileId}: ${errorMessage}`)
    
    // Update progress even for failed images so UI doesn't get stuck
    const currentProgress = folderProgress.get(folderId)
    if (currentProgress) {
      currentProgress.processedImages += 1
      folderProgress.set(folderId, currentProgress)
      
      // Check if folder is complete
      if (currentProgress.processedImages >= currentProgress.totalImages) {
        folderProgress.delete(folderId)
        
        // Update folder status in database
        await prisma.folder.update({
          where: { id: folderId },
          data: { 
            status: 'completed',
            processedImages: currentProgress.totalImages
          }
        })
      }
    }

    // Update database to mark image as failed
    await prisma.image.update({
      where: { id: imageId },
      data: { 
        status: 'failed',
        error: errorMessage.substring(0, 500)
      }
    })

    // Return error result instead of throwing - allows batch processing to continue
    return {
      success: false,
      imageId,
      fileId,
      error: errorMessage,
      processingTime: Date.now() - startTime
    }
  }
}

// Image worker - processes both single and batch jobs
export const imageWorker = new Worker(
  "images", 
  async (job: Job) => {
    console.log(`🎯 Image worker received job: ${job.id} (${job.name})`)
    
    if (job.name === 'batch-caption') {
      // Process batch of images with optimized two-phase approach
      const { images, folderId, accessToken } = job.data as ImageBatchJobData
      console.log(`📦 Processing batch of ${images.length} images for folder ${folderId}`)
      
      const batchStart = Date.now()
      
      // Phase 1: Generate captions in parallel
      console.log(`📝 Phase 1: Generating captions for ${images.length} images`)
      const captionResults = await Promise.all(
        images.map(img => processImageCaption({ ...img, accessToken }))
      )
      
      const captionTime = Date.now() - batchStart
      console.log(`⏱️  Caption generation time: ${captionTime}ms`)
      
      // Phase 2: Batch generate embeddings for successful captions
      const successfulCaptions = captionResults.filter((r): r is typeof captionResults[0] & { caption: string } => 
        r.success && r.caption !== undefined
      )
      if (successfulCaptions.length > 0) {
        console.log(`🧮 Phase 2: Generating ${successfulCaptions.length} batch embeddings`)
        
        // Rate limit before batch embedding to avoid 429 errors
        await geminiRateLimiter.waitIfNeeded()
        
        const textsToEmbed = successfulCaptions.map(r => r.caption)
        const embeddings = await generateBatchEmbeddings(textsToEmbed)
        
        const embeddingTime = Date.now() - batchStart - captionTime
        console.log(`⏱️  Batch embedding time: ${embeddingTime}ms`)
        
        // Phase 3: Store embeddings in database
        console.log(`💾 Phase 3: Storing ${successfulCaptions.length} embeddings`)
        
        const storageResults = await Promise.all(
          successfulCaptions.map((result, idx) => 
            processImageEmbedding(result.imageId, folderId, result.caption, embeddings[idx])
          )
        )
        
        const storageTime = Date.now() - batchStart - captionTime - embeddingTime
        console.log(`⏱️  Storage time: ${storageTime}ms`)
        
        // Track failures from embedding phase
        const storageFailures = storageResults.filter(r => !r.success)
        
        // Count totals
        const failedCaptions = captionResults.length - successfulCaptions.length
        const totalFailed = failedCaptions + storageFailures.length
        const totalSuccess = successfulCaptions.length - storageFailures.length
        
        console.log(`✅ Batch completed: ${totalSuccess} successful, ${totalFailed} failed (${Date.now() - batchStart}ms total)`)
        
        if (totalFailed > 0) {
          console.log(`❌ Failed images in batch:`)
          captionResults.filter(r => !r.success).forEach(f => console.log(`   Caption failure - ${f.fileId}: ${f.error}`))
          storageFailures.forEach(f => console.log(`   Storage failure - ${f.imageId}: ${f.error}`))
        }
        
        return { success: true, processed: totalSuccess, failed: totalFailed }
      } else {
        // All captions failed
        const failCount = captionResults.filter(r => !r.success).length
        console.log(`✅ Batch completed: 0 successful, ${failCount} failed (all caption generation failed)`)
        
        return { success: false, processed: 0, failed: failCount }
      }
      
    } else {
      // Process single image (legacy/retry)
      const data = job.data as ImageJobData
      return await processImage({
        imageId: data.imageId,
        fileId: data.fileId,
        etag: data.etag,
        folderId: data.folderId,
        accessToken: data.accessToken
      })
    }
  },
  {
    connection,
    concurrency: Number(process.env.IMAGE_WORKER_CONCURRENCY) || 2, // Configurable, default 2 to avoid API throttling
    // Stalled job handling - critical for Railway restarts
    lockDuration: 300000, // 5 minutes - image processing can take time
    stalledInterval: 30000, // Check for stalled jobs every 30 seconds
    maxStalledCount: 3, // Retry stalled jobs up to 3 times
  },
)

// Helper function to update folder progress
async function updateFolderProgress(folderId: string) {
  const [totalImages, processedImages, failedImages] = await Promise.all([
    prisma.image.count({
      where: { folderId },
    }),
    prisma.image.count({
      where: { folderId, status: "completed" },
    }),
    prisma.image.count({
      where: { folderId, status: "failed" },
    }),
  ])

  // Determine status based on processed + failed vs total
  let status: string
  if (processedImages + failedImages >= totalImages) {
    // All images have been attempted
    status = failedImages > 0 ? "completed_with_errors" : "completed"
  } else {
    status = "processing"
  }

  await prisma.folder.update({
    where: { id: folderId },
    data: {
      processedImages,
      status,
    },
  })

  // Get progress tracking data
  const progress = folderProgress.get(folderId)
  if (progress) {
    const elapsedTime = Date.now() - progress.startTime
    const imagesPerMinute = processedImages > 0 ? (processedImages / (elapsedTime / 60000)) : 0

    console.log(`📈 Folder Progress Update:`)
    console.log(`   - Progress: ${processedImages}/${totalImages} images (${Math.round((processedImages/totalImages)*100)}%)`)
    console.log(`   - Failed: ${failedImages}`)
    console.log(`   - Status: ${status}`)
    console.log(`   - Elapsed time: ${Math.round(elapsedTime/1000)}s`)
    console.log(`   - Processing speed: ${Math.round(imagesPerMinute)} images/minute`)
    
    if (status === "completed" || status === "completed_with_errors") {
      console.log(`🎉 Folder completed! Total time: ${Math.round(elapsedTime/1000)}s`)
      folderProgress.delete(folderId) // Clean up progress tracking
    }
  } else {
    console.log(`Updated folder progress: ${processedImages}/${totalImages} (failed: ${failedImages}, status: ${status})`)
  }
}

// Worker event handlers
folderWorker.on("completed", (job) => {
  console.log(`✅ Folder job ${job.id} completed`)
})

folderWorker.on("failed", (job, err) => {
  console.error(`❌ Folder job ${job?.id} failed:`, err)
})

folderWorker.on("ready", () => {
  console.log("🚀 Folder worker is ready to process jobs")
})

folderWorker.on("stalled", (jobId) => {
  console.warn(`⚠️ Folder job ${jobId} stalled - will be retried`)
})

folderWorker.on("error", (err) => {
  console.error(`❌ Folder worker error:`, err)
})

imageWorker.on("completed", (job) => {
  console.log(`✅ Image job ${job.id} completed`)
})

imageWorker.on("failed", (job, err) => {
  console.error(`❌ Image job ${job?.id} failed:`, err)
})

imageWorker.on("ready", () => {
  console.log("🚀 Image worker is ready to process jobs")
})

imageWorker.on("stalled", (jobId) => {
  console.warn(`⚠️ Image job ${jobId} stalled - will be retried`)
})

imageWorker.on("active", (job) => {
  console.log(`🔄 Image job ${job.id} is now active (${job.name})`)
})

imageWorker.on("error", (err) => {
  console.error(`❌ Image worker error:`, err)
})

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("Shutting down workers...")
  await Promise.all([folderWorker.close(), imageWorker.close()])
  process.exit(0)
})
