import { type NextRequest, NextResponse } from "next/server"
import { auth, currentUser } from "@clerk/nextjs/server"
import { prisma } from "@/lib/prisma"
import { folderRateLimiter, getClientIdentifier, checkRateLimit, getRateLimitHeaders } from "@/lib/rate-limit"

export async function GET(request: NextRequest) {
  try {
    // Rate limiting
    const identifier = getClientIdentifier(request)
    const rateLimitResult = await checkRateLimit(folderRateLimiter, identifier)
    
    if (!rateLimitResult.allowed) {
      return NextResponse.json(
        { 
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
        },
        { 
          status: 429,
          headers: {
            ...getRateLimitHeaders(rateLimitResult, 30),
            'Retry-After': Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000).toString(),
          }
        }
      )
    }

    const { userId: clerkId } = await auth()

    if (!clerkId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Find user by Clerk ID
    let user = await prisma.user.findUnique({
      where: { clerkId },
      include: {
        folders: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            folderId: true,
            name: true,
            folderUrl: true,
            status: true,
            totalImages: true,
            processedImages: true,
            createdAt: true,
          },
        },
      },
    })

    if (!user) {
      // User hasn't created any folders yet
      return NextResponse.json({ folders: [] })
    }

    // Sync email from Clerk if missing
    if (!user.email) {
      const clerkUser = await currentUser()
      const email = clerkUser?.emailAddresses?.[0]?.emailAddress || null
      if (email) {
        await prisma.user.update({
          where: { id: user.id },
          data: { email },
        })
      }
    }

    return NextResponse.json({ folders: user.folders })
  } catch (error) {
    console.error("❌ Folders API error:", error)
    return NextResponse.json({ error: "Internal server error" }, { status: 500 })
  }
}
