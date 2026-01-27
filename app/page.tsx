"use client"
import { UrlForm } from "@/components/url-form"
import { FolderList } from "@/components/folder-list"
import { useRouter } from "next/navigation"
import { useAuth } from "@clerk/nextjs"
import { saveFolder, type LocalFolder } from "@/lib/local-storage"
import { useState } from "react"

interface FolderData {
  id: string
  folderId: string
  name: string | null
  folderUrl: string
  status: string
  totalImages: number
  processedImages: number
  createdAt: string
}

export default function HomePage() {
  const router = useRouter()
  const { isSignedIn } = useAuth()
  const [refreshKey, setRefreshKey] = useState(0)

  const handleSuccess = (folder: FolderData) => {
    // Only save to localStorage when user is NOT signed in
    // Signed-in users' folders are stored in the database
    if (!isSignedIn) {
      const localFolder: LocalFolder = {
        id: folder.id,
        folderId: folder.folderId,
        name: folder.name,
        folderUrl: folder.folderUrl,
        status: folder.status,
        totalImages: folder.totalImages,
        processedImages: folder.processedImages,
        createdAt: folder.createdAt,
      }
      saveFolder(localFolder)
    }
    
    // Always trigger refresh of folder list (for both logged-in and non-logged-in users)
    setRefreshKey(prev => prev + 1)

    // Only redirect if folder has 100 or fewer images
    // For folders > 100 images, stay on dashboard (folder list will show it as processing)
    if (folder.totalImages <= 100) {
      router.push(`/folder/${folder.id}`)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20 p-4">
      <div className="max-w-2xl mx-auto space-y-8 py-8">
        <UrlForm onSuccess={handleSuccess} />
        <FolderList refreshTrigger={refreshKey} />
      </div>
    </div>
  )
}
