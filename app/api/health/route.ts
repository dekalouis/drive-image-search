import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { healthCheck as queueHealthCheck } from "@/lib/queue"

export async function GET() {
  const startTime = Date.now()
  
  try {
    // Check database connection
    let dbHealthy = false
    let dbError = null
    try {
      await prisma.$queryRaw`SELECT 1`
      dbHealthy = true
    } catch (error) {
      dbError = error instanceof Error ? error.message : 'Unknown error'
    }
    
    // Check queue/Redis connection
    const queueHealth = await queueHealthCheck()
    
    const responseTime = Date.now() - startTime
    
    const healthy = dbHealthy && queueHealth.healthy
    
    const healthData = {
      status: healthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: `${responseTime}ms`,
      services: {
        database: {
          healthy: dbHealthy,
          error: dbError
        },
        queue: {
          healthy: queueHealth.healthy,
          redis: queueHealth.redis,
          stats: queueHealth.queues,
          error: queueHealth.error
        }
      }
    }
    
    return NextResponse.json(healthData, { 
      status: healthy ? 200 : 503 
    })
    
  } catch (error) {
    return NextResponse.json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      responseTime: `${Date.now() - startTime}ms`,
      error: error instanceof Error ? error.message : 'Unknown error'
    }, { status: 503 })
  }
}

