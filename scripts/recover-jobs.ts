#!/usr/bin/env tsx
/**
 * Recover stalled/stuck jobs after Railway restarts
 * Usage: npx tsx scripts/recover-jobs.ts
 */

import { recoverStalledJobs, healthCheck, getQueueStats } from "../lib/queue"
import { prisma } from "../lib/prisma"

async function main() {
  console.log("🔧 Job Recovery Script")
  console.log("=".repeat(50))
  
  // 1. Health check
  console.log("\n📋 Running health check...")
  const health = await healthCheck()
  console.log(`   Redis: ${health.redis || 'disconnected'}`)
  console.log(`   Healthy: ${health.healthy}`)
  
  if (!health.healthy) {
    console.error(`❌ Health check failed: ${health.error}`)
    process.exit(1)
  }
  
  // 2. Show current queue stats
  console.log("\n📊 Current queue statistics:")
  const stats = await getQueueStats()
  console.log(`   Folder queue:`, stats.folders)
  console.log(`   Image queue:`, stats.images)
  
  // 3. Recover stalled jobs
  console.log("\n🔄 Recovering stalled jobs...")
  const recovery = await recoverStalledJobs()
  console.log(`   Recovered: ${recovery.recoveredCount} jobs`)
  
  // 4. Check for processing images stuck in "processing" status
  console.log("\n🔍 Checking for stuck images in database...")
  const stuckImages = await prisma.image.findMany({
    where: {
      status: "processing",
      updatedAt: {
        lt: new Date(Date.now() - 5 * 60 * 1000) // Older than 5 minutes
      }
    },
    select: {
      id: true,
      name: true,
      folderId: true,
      updatedAt: true
    }
  })
  
  if (stuckImages.length > 0) {
    console.log(`   Found ${stuckImages.length} stuck images, resetting to pending...`)
    
    await prisma.image.updateMany({
      where: {
        id: { in: stuckImages.map(i => i.id) }
      },
      data: {
        status: "pending",
        error: null
      }
    })
    
    console.log(`   ✅ Reset ${stuckImages.length} images to pending`)
  } else {
    console.log(`   No stuck images found`)
  }
  
  // 5. Check for processing folders
  console.log("\n🔍 Checking folder statuses...")
  const folders = await prisma.folder.findMany({
    where: {
      status: { in: ["processing", "pending"] }
    },
    select: {
      id: true,
      name: true,
      folderId: true,
      status: true,
      totalImages: true,
      processedImages: true,
      _count: {
        select: {
          images: {
            where: { status: "pending" }
          }
        }
      }
    }
  })
  
  for (const folder of folders) {
    const pendingCount = folder._count.images
    const completedCount = await prisma.image.count({
      where: { folderId: folder.id, status: "completed" }
    })
    
    console.log(`\n   📁 ${folder.name || folder.folderId}`)
    console.log(`      Status: ${folder.status}`)
    console.log(`      Progress: ${completedCount}/${folder.totalImages}`)
    console.log(`      Pending: ${pendingCount} images`)
    
    // Update folder progress if counts are off
    if (folder.processedImages !== completedCount) {
      await prisma.folder.update({
        where: { id: folder.id },
        data: { processedImages: completedCount }
      })
      console.log(`      ✅ Updated processedImages count`)
    }
    
    // If folder has pending images but is marked as completed, fix it
    if (pendingCount > 0 && folder.status === "completed") {
      await prisma.folder.update({
        where: { id: folder.id },
        data: { status: "processing" }
      })
      console.log(`      ✅ Reset status to processing`)
    }
  }
  
  console.log("\n" + "=".repeat(50))
  console.log("✅ Recovery complete!")
  console.log("\nTo process remaining images, use:")
  console.log("   POST /api/retry-image with { folderId: 'your-folder-id' }")
  console.log("   Or run: npx tsx scripts/process-remaining-images.ts <folderId>")
  
  process.exit(0)
}

main().catch((error) => {
  console.error("❌ Recovery failed:", error)
  process.exit(1)
})
