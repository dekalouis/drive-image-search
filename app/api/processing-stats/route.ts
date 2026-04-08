import { type NextRequest, NextResponse } from "next/server"
import { getProcessingStatsFromDB } from "@/lib/processing-stats"
import { checkAdminAuth } from "@/lib/admin-auth"

export async function GET(request: NextRequest) {
  const authError = checkAdminAuth(request)
  if (authError) return authError

  try {
    const stats = await getProcessingStatsFromDB()

    return NextResponse.json({
      success: true,
      data: stats,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("Failed to get processing stats:", error)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to get processing statistics",
        timestamp: new Date().toISOString(),
      },
      { status: 500 }
    )
  }
}
