import { prisma } from '@/lib/prisma'
import { auth } from '@clerk/nextjs/server'

/**
 * Validate if current user has access to a folder
 * Allows access if:
 * 1. Folder has no owner (public/anonymous folder)
 * 2. Current user is the owner
 */
export async function validateFolderAccess(folderId: string): Promise<{
  folder: any | null
  dbUserId: string | null
  hasAccess: boolean
}> {
  const { userId: clerkUserId } = await auth()
  
  // Get current user's DB id
  let dbUserId: string | null = null
  if (clerkUserId) {
    const user = await prisma.user.findUnique({
      where: { clerkId: clerkUserId }
    })
    dbUserId = user?.id || null
  }

  // Get folder from database
  const folder = await prisma.folder.findUnique({
    where: { id: folderId }
  })

  if (!folder) {
    return { folder: null, dbUserId, hasAccess: false }
  }

  // Allow access if:
  // 1. Folder has no owner (anonymous/public folder)
  // 2. Current user is the owner
  const hasAccess = !folder.userId || folder.userId === dbUserId

  return { folder, dbUserId, hasAccess }
}
