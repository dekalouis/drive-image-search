/**
 * DB-based processing statistics (ARCH-001)
 * Replaces the in-memory folderProgress Map from lib/workers.ts so the
 * processing-stats API does not need to import workers (which starts them
 * inside the Next.js web process).
 */

import { prisma } from '@/lib/prisma'
import { getQueueStats } from '@/lib/queue'

export async function getProcessingStatsFromDB() {
  // Get all folders that are currently processing or pending
  const activeFolders = await prisma.folder.findMany({
    where: {
      status: { in: ['processing', 'pending'] },
    },
    select: {
      id: true,
      folderId: true,
      name: true,
      status: true,
      totalImages: true,
      processedImages: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  // Build per-folder stats from DB counts
  const folders = await Promise.all(
    activeFolders.map(async (folder) => {
      const [completed, failed, processing] = await Promise.all([
        prisma.image.count({ where: { folderId: folder.id, status: 'completed' } }),
        prisma.image.count({ where: { folderId: folder.id, status: 'failed' } }),
        prisma.image.count({ where: { folderId: folder.id, status: 'processing' } }),
      ])

      const total = folder.totalImages || 0
      const processedImages = completed
      const progressPercent = total > 0 ? Math.round((processedImages / total) * 100) : 0
      const elapsedMs = Date.now() - folder.createdAt.getTime()

      return {
        folderId: folder.id,
        googleFolderId: folder.folderId,
        name: folder.name,
        status: folder.status,
        totalImages: total,
        processedImages,
        failedImages: failed,
        activeImages: processing,
        progressPercent,
        elapsedTime: Math.round(elapsedMs / 1000),
        startTime: folder.createdAt.toISOString(),
        lastUpdated: folder.updatedAt.toISOString(),
      }
    })
  )

  // Get queue statistics from Redis
  const queueStats = await getQueueStats()

  const totalImages = folders.reduce((sum, f) => sum + f.totalImages, 0)
  const totalProcessed = folders.reduce((sum, f) => sum + f.processedImages, 0)
  const overallProgress = totalImages > 0 ? Math.round((totalProcessed / totalImages) * 100) : 0

  return {
    folders,
    queueStats,
    overall: {
      totalImages,
      totalProcessed,
      overallProgress,
      activeFolders: folders.length,
    },
  }
}
