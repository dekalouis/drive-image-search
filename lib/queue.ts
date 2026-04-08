import { Queue } from "bullmq"
import IORedis from "ioredis"
import { encrypt } from "@/lib/encryption"

// Redis connection with reconnection logic for Railway restarts
const connection = new IORedis(process.env.REDIS_URL || "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  // Reconnection settings for Railway restarts
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 100, 3000) // Max 3 second delay
    console.log(`🔄 Queue Redis reconnecting... attempt ${times}, delay ${delay}ms`)
    return delay
  },
  reconnectOnError: (err) => {
    console.log(`🔄 Queue Redis reconnect on error: ${err.message}`)
    return true // Always try to reconnect
  },
  enableReadyCheck: true,
  lazyConnect: false,
})

// Add connection event logging
connection.on("connect", () => {
  console.log("🔗 Queue Redis connected successfully")
})

connection.on("error", (error) => {
  console.error("❌ Queue Redis connection error:", error)
})

connection.on("ready", () => {
  console.log("✅ Queue Redis ready for operations")
})

connection.on("reconnecting", () => {
  console.log("🔄 Queue Redis reconnecting...")
})

connection.on("close", () => {
  console.log("⚠️ Queue Redis connection closed")
})

// Export connection for shared use (rate limiter, thumbnail cache, etc.)
export { connection as redisConnection }

// Queue configurations
export const folderQueue = new Queue("folders", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 50,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
})

export const imageQueue = new Queue("images", {
  connection,
  defaultJobOptions: {
    removeOnComplete: 100,
    removeOnFail: 100,
    attempts: 3,
    backoff: {
      type: "exponential",
      delay: 2000,
    },
  },
})

// Queue event logging will be handled in the workers

// Job data interfaces
export interface FolderJobData {
  folderId: string
  googleFolderId: string
  /** AES-256-GCM encrypted access token (iv:authTag:ciphertext) — SEC-005 */
  accessTokenEncrypted?: string
}

export interface ImageJobData {
  imageId: string
  fileId: string
  etag: string
  folderId: string
  /** AES-256-GCM encrypted access token (iv:authTag:ciphertext) — SEC-005 */
  accessTokenEncrypted?: string
}

export interface ImageBatchJobData {
  images: Array<{
    imageId: string
    fileId: string
    etag: string
    folderId: string
    mimeType: string
    name: string
  }>
  folderId: string
  /** AES-256-GCM encrypted access token (iv:authTag:ciphertext) — SEC-005 */
  accessTokenEncrypted?: string
}

// Queue folder processing job
export async function queueFolderProcessing(folderId: string, googleFolderId: string, accessToken?: string) {
  // Include timestamp to allow re-processing after sync finds new images
  const timestamp = Date.now()
  const jobId = `folder:${googleFolderId}:${timestamp}`

  console.log(`🚀 Queueing folder processing job: ${jobId}`)
  console.log(`   - Database ID: ${folderId}`)
  console.log(`   - Google Folder ID: ${googleFolderId}`)
  console.log(`   - Timestamp: ${new Date().toISOString()}`)

  // Encrypt token before storing in queue payload (SEC-005)
  const accessTokenEncrypted = accessToken ? encrypt(accessToken) : undefined

  try {
    await folderQueue.add("process", { folderId, googleFolderId, accessTokenEncrypted } as FolderJobData, {
      jobId,
    })

    console.log(`✅ Successfully queued folder processing job: ${jobId}`)
    
    // Log queue stats
    const stats = await folderQueue.getJobCounts()
    console.log(`📊 Folder queue stats:`, stats)
  } catch (error) {
    console.error(`❌ Failed to queue folder processing job: ${jobId}`, error)
    throw error
  }
}

// Queue image captioning job (legacy single)
export async function queueImageCaptioning(imageId: string, fileId: string, etag: string, folderId: string, accessToken?: string) {
  const jobId = `image:${fileId}:${etag}`

  console.log(`🚀 Queueing image captioning job: ${jobId}`)

  const accessTokenEncrypted = accessToken ? encrypt(accessToken) : undefined

  try {
    await imageQueue.add("caption", { imageId, fileId, etag, folderId, accessTokenEncrypted } as ImageJobData, {
      jobId,
    })

    console.log(`✅ Successfully queued image captioning job: ${jobId}`)
  } catch (error) {
    console.error(`❌ Failed to queue image captioning job: ${jobId}`, error)
    throw error
  }
}

// Queue batch of images
export async function queueImageBatch(data: ImageBatchJobData & { accessToken?: string }) {
  const jobId = `batch:${data.folderId}:${Date.now()}:${Math.random().toString(36).substring(7)}`

  console.log(`🚀 Queueing image batch job: ${jobId} with ${data.images.length} images`)

  // Encrypt token before storing in queue payload (SEC-005)
  const { accessToken, ...rest } = data
  const accessTokenEncrypted = accessToken ? encrypt(accessToken) : data.accessTokenEncrypted
  const jobData: ImageBatchJobData = { ...rest, accessTokenEncrypted }

  try {
    const job = await imageQueue.add("batch-caption", jobData, {
      jobId,
      // Ensure job is retried if worker crashes
      attempts: 3,
      backoff: {
        type: "exponential",
        delay: 2000,
      },
    })
    console.log(`✅ Successfully queued batch job: ${jobId} (job ID: ${job.id})`)
    
    // Log queue stats after adding
    const stats = await imageQueue.getJobCounts()
    console.log(`📊 Image queue stats after queuing: waiting=${stats.waiting}, active=${stats.active}, completed=${stats.completed}, failed=${stats.failed}`)
  } catch (error) {
    console.error(`❌ Failed to queue batch job: ${jobId}`, error)
    throw error
  }
}

// Get queue stats with enhanced logging
export async function getQueueStats() {
  console.log("📊 Getting queue statistics...")
  
  try {
    const [folderStats, imageStats] = await Promise.all([folderQueue.getJobCounts(), imageQueue.getJobCounts()])

    console.log("📊 Queue Statistics:")
    console.log(`   Folders:`, folderStats)
    console.log(`   Images:`, imageStats)
    
    // Calculate processing rate if we have active jobs
    if (imageStats.active && imageStats.active > 0) {
      console.log(`⚡ Active image processing: ${imageStats.active} jobs`)
    }
    
    if (imageStats.waiting && imageStats.waiting > 0) {
      console.log(`⏳ Waiting images: ${imageStats.waiting} jobs`)
    }

    return {
      folders: folderStats,
      images: imageStats,
    }
  } catch (error) {
    console.error("❌ Failed to get queue stats:", error)
    throw error
  }
}

// Clean up completed jobs
export async function cleanupJobs() {
  console.log("🧹 Cleaning up completed jobs...")
  
  try {
    await Promise.all([
      folderQueue.clean(24 * 60 * 60 * 1000, 10, "completed"), // Keep completed jobs for 24h
      folderQueue.clean(7 * 24 * 60 * 60 * 1000, 50, "failed"), // Keep failed jobs for 7 days
      imageQueue.clean(24 * 60 * 60 * 1000, 100, "completed"),
      imageQueue.clean(7 * 24 * 60 * 60 * 1000, 100, "completed"),
      imageQueue.clean(7 * 24 * 60 * 60 * 1000, 100, "failed"),
    ])
    
    console.log("✅ Job cleanup completed")
  } catch (error) {
    console.error("❌ Job cleanup failed:", error)
    throw error
  }
}

// Recover stalled/stuck jobs - useful after Railway restarts
export async function recoverStalledJobs() {
  console.log("🔄 Recovering stalled jobs...")
  
  try {
    const [folderStats, imageStats] = await Promise.all([
      folderQueue.getJobCounts(),
      imageQueue.getJobCounts()
    ])
    
    console.log(`📊 Current queue state:`)
    console.log(`   Folders - waiting: ${folderStats.waiting}, active: ${folderStats.active}, failed: ${folderStats.failed}`)
    console.log(`   Images - waiting: ${imageStats.waiting}, active: ${imageStats.active}, failed: ${imageStats.failed}`)
    
    // Get active jobs that might be stalled
    const [activeFolderJobs, activeImageJobs] = await Promise.all([
      folderQueue.getJobs(['active']),
      imageQueue.getJobs(['active'])
    ])
    
    let recoveredCount = 0
    
    // Check for jobs that have been active too long (likely stalled)
    const stalledThreshold = 5 * 60 * 1000 // 5 minutes
    const now = Date.now()
    
    for (const job of activeFolderJobs) {
      if (job.processedOn && now - job.processedOn > stalledThreshold) {
        console.log(`⚠️ Found stalled folder job: ${job.id}, moving to failed`)
        await job.moveToFailed(new Error('Job stalled - worker restart recovery'), 'recovery')
        recoveredCount++
      }
    }
    
    for (const job of activeImageJobs) {
      if (job.processedOn && now - job.processedOn > stalledThreshold) {
        console.log(`⚠️ Found stalled image job: ${job.id}, moving to failed`)
        await job.moveToFailed(new Error('Job stalled - worker restart recovery'), 'recovery')
        recoveredCount++
      }
    }
    
    console.log(`✅ Recovery complete: ${recoveredCount} stalled jobs recovered`)
    
    return {
      folderStats,
      imageStats,
      recoveredCount
    }
  } catch (error) {
    console.error("❌ Job recovery failed:", error)
    throw error
  }
}

// Health check for queue system
export async function healthCheck() {
  try {
    // Test Redis connection
    await connection.ping()
    
    const [folderStats, imageStats] = await Promise.all([
      folderQueue.getJobCounts(),
      imageQueue.getJobCounts()
    ])
    
    return {
      healthy: true,
      redis: 'connected',
      queues: {
        folders: folderStats,
        images: imageStats
      },
      timestamp: new Date().toISOString()
    }
  } catch (error) {
    return {
      healthy: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    }
  }
}
