"use client"

import { useEffect, useState, useRef } from "react"
import { useRouter } from "next/navigation"
import { useAuth } from "@clerk/nextjs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { FolderOpen, Image as ImageIcon, Loader2, Clock } from "lucide-react"
import { getFolders, updateFolderStatus, clearFolders, removeFolder, type LocalFolder } from "@/lib/local-storage"
import { ProcessingModal } from "@/components/processing-modal"

interface Folder {
  id: string
  folderId: string
  name: string | null
  folderUrl: string
  status: string
  totalImages: number
  processedImages: number
  createdAt: string
}

interface FolderListProps {
  refreshTrigger?: number
}

export function FolderList({ refreshTrigger }: FolderListProps = {}) {
  const router = useRouter()
  const { isSignedIn } = useAuth()
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [showProcessingModal, setShowProcessingModal] = useState(false)
  const [selectedFolder, setSelectedFolder] = useState<Folder | null>(null)
  const prevSignedInRef = useRef<boolean | undefined>(undefined)

  // Validate localStorage folders by checking if they exist in the database
  // Works for both logged-in and non-logged-in users (API doesn't require auth)
  const validateLocalFolders = async (localFolders: LocalFolder[]): Promise<Folder[]> => {
    if (localFolders.length === 0) return []
    
    const validatedFolders: Folder[] = []
    const foldersToRemove: string[] = []
    
    // Check each folder to see if it exists in the database
    // This works for both logged-in and non-logged-in users
    for (const folder of localFolders) {
      try {
        const response = await fetch(`/api/images?folderId=${folder.id}`)
        if (response.ok) {
          const data = await response.json()
          // Folder exists, add it to validated list with fresh data
          validatedFolders.push({
            id: folder.id,
            folderId: folder.folderId,
            name: folder.name,
            folderUrl: folder.folderUrl,
            status: data.status || folder.status,
            totalImages: data.totalImages || folder.totalImages,
            processedImages: data.processedImages || folder.processedImages,
            createdAt: folder.createdAt,
          })
        } else if (response.status === 404) {
          // Folder doesn't exist in DB, mark for removal
          console.log(`🗑️  Removing non-existent folder from localStorage: ${folder.id}`)
          foldersToRemove.push(folder.id)
        } else {
          // Other error (401, 500, etc.) - keep folder for now
          validatedFolders.push({
            id: folder.id,
            folderId: folder.folderId,
            name: folder.name,
            folderUrl: folder.folderUrl,
            status: folder.status,
            totalImages: folder.totalImages,
            processedImages: folder.processedImages,
            createdAt: folder.createdAt,
          })
        }
      } catch (err) {
        console.error(`Error validating folder ${folder.id}:`, err)
        // On error, keep the folder (might be a network issue)
        validatedFolders.push({
          id: folder.id,
          folderId: folder.folderId,
          name: folder.name,
          folderUrl: folder.folderUrl,
          status: folder.status,
          totalImages: folder.totalImages,
          processedImages: folder.processedImages,
          createdAt: folder.createdAt,
        })
      }
    }
    
    // Remove invalid folders from localStorage
    foldersToRemove.forEach(folderId => removeFolder(folderId))
    
    return validatedFolders
  }

  // Handle sign out: clear folders and localStorage when user signs out
  useEffect(() => {
    // Check if user just signed out (was signed in, now not signed in)
    if (prevSignedInRef.current === true && isSignedIn === false) {
      console.log("🔄 User signed out - clearing folders and localStorage")
      setFolders([])
      clearFolders()
      setSelectedFolder(null)
      setShowProcessingModal(false)
    }
    // Update ref for next comparison
    prevSignedInRef.current = isSignedIn
  }, [isSignedIn])

  useEffect(() => {
    const fetchFolders = async () => {
      try {
        // If auth is still loading, wait (isSignedIn will be undefined)
        if (isSignedIn === undefined) {
          // While auth is loading, only show localStorage folders if user is NOT signed in
          // (we don't want to show localStorage folders if user might be signed in)
          const localFolders = getFolders()
          if (localFolders.length > 0) {
            setFolders(localFolders)
            setLoading(false)
          }
          return
        }

        if (isSignedIn) {
          // Fetch from API for logged-in users ONLY
          // DO NOT use localStorage for signed-in users
          const response = await fetch("/api/folders")
          if (response.ok) {
            const data = await response.json()
            setFolders(data.folders)
          } else if (response.status === 401) {
            // Not authenticated - clear everything
            setFolders([])
            clearFolders()
          } else {
            setError("Failed to load folders")
            setFolders([])
          }
        } else {
          // Load from localStorage ONLY for non-logged-in users
          const localFolders = getFolders()
          // Validate folders exist in DB by checking each one
          const validatedFolders = await validateLocalFolders(localFolders)
          setFolders(validatedFolders)
        }
      } catch (err) {
        console.error("Error fetching folders:", err)
        if (isSignedIn) {
          // For signed-in users, don't fall back to localStorage
          setFolders([])
          setError("Failed to load folders")
        } else {
          // For non-signed-in users, try localStorage
          const localFolders = getFolders()
          if (localFolders.length > 0) {
            // Validate folders exist in DB
            const validatedFolders = await validateLocalFolders(localFolders)
            setFolders(validatedFolders)
          } else {
            setError("Failed to load folders")
          }
        }
      } finally {
        setLoading(false)
      }
    }

    fetchFolders()
  }, [isSignedIn, refreshTrigger]) // Re-fetch when refreshTrigger changes

  // Poll for folder status updates (for processing folders)
  useEffect(() => {
    if (folders.length === 0) return

    const processingFolders = folders.filter(
      f => f.status === "processing" || f.status === "pending"
    )

    if (processingFolders.length === 0) return

    const pollInterval = setInterval(async () => {
      for (const folder of processingFolders) {
        try {
          // Check folder status via images API
          const response = await fetch(`/api/images?folderId=${folder.id}`)
          if (response.ok) {
            const data = await response.json()
            if (data.status && data.status !== folder.status) {
              // Status changed, update local state
              setFolders(prev => 
                prev.map(f => 
                  f.id === folder.id 
                    ? { ...f, status: data.status, processedImages: data.processedImages || f.processedImages }
                    : f
                )
              )
              
              // Update localStorage if not logged in
              if (!isSignedIn) {
                updateFolderStatus(folder.id, data.status, data.processedImages || folder.processedImages)
              }
              
              // Update selectedFolder if modal is open for this folder
              if (selectedFolder && selectedFolder.id === folder.id) {
                setSelectedFolder(prev => prev ? {
                  ...prev,
                  status: data.status,
                  processedImages: data.processedImages || prev.processedImages
                } : null)
              }
            } else if (data.processedImages !== undefined && data.processedImages !== folder.processedImages) {
              // Progress updated
              setFolders(prev => 
                prev.map(f => 
                  f.id === folder.id 
                    ? { ...f, processedImages: data.processedImages }
                    : f
                )
              )
              
              if (!isSignedIn) {
                updateFolderStatus(folder.id, folder.status, data.processedImages)
              }
              
              // Update selectedFolder if modal is open for this folder
              if (selectedFolder && selectedFolder.id === folder.id) {
                setSelectedFolder(prev => prev ? {
                  ...prev,
                  processedImages: data.processedImages
                } : null)
              }
            }
          }
        } catch (err) {
          console.error(`Error polling folder ${folder.id}:`, err)
        }
      }
    }, 5000) // Poll every 5 seconds

    return () => clearInterval(pollInterval)
  }, [folders, isSignedIn])

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed":
        return "bg-green-500"
      case "completed_with_errors":
        return "bg-orange-500"
      case "processing":
        return "bg-yellow-500"
      case "failed":
        return "bg-red-500"
      default:
        return "bg-gray-500"
    }
  }

  const formatDate = (dateString: string) => {
    const date = new Date(dateString)
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  }

  if (loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Your Folders
          </CardTitle>
        </CardHeader>
        <CardContent className="flex justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Your Folders
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center">{error}</p>
        </CardContent>
      </Card>
    )
  }

  if (folders.length === 0 && !loading) {
    return (
      <Card className="w-full max-w-2xl mx-auto">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FolderOpen className="h-5 w-5" />
            Your Folders
          </CardTitle>
          <CardDescription>
            Your uploaded folders will appear here
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="text-center py-8">
            <FolderOpen className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
            <p className="text-sm text-muted-foreground">
              No folders yet. Upload your first Google Drive folder above!
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (folders.length === 0) {
    return null
  }

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FolderOpen className="h-5 w-5" />
          Your Folders
        </CardTitle>
        <CardDescription>
          Click on a folder to view and search its images
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {folders.map((folder) => {
          const handleFolderClick = async () => {
            // First, verify the folder still exists (for both logged-in and non-logged-in users)
            try {
              const response = await fetch(`/api/images?folderId=${folder.id}`)
              if (!response.ok) {
                if (response.status === 404) {
                  // Folder doesn't exist, remove from localStorage and state
                  console.log(`🗑️  Folder ${folder.id} no longer exists, removing...`)
                  removeFolder(folder.id) // Remove from localStorage regardless of auth state
                  setFolders(prev => prev.filter(f => f.id !== folder.id))
                  setError(`Folder "${folder.name || folder.folderId}" no longer exists and has been removed.`)
                  return
                }
              }
            } catch (err) {
              console.error("Error verifying folder:", err)
              // Continue anyway - might be a network issue
            }

            // Check if folder is processing/pending and has >100 images
            // Allow access if folder is nearly complete (90%+ or <= 10 images remaining) - more lenient
            const remainingImages = folder.totalImages - folder.processedImages
            const completionPercentage = folder.totalImages > 0 
              ? (folder.processedImages / folder.totalImages) * 100 
              : 0
            const isNearlyComplete = completionPercentage >= 90 || remainingImages <= 10
            
            if ((folder.status === "processing" || folder.status === "pending") && folder.totalImages > 100 && !isNearlyComplete) {
              setSelectedFolder(folder)
              setShowProcessingModal(true)
              return
            }
            // Navigate to folder page (for completed folders, folders <= 100 images, or nearly complete folders)
            router.push(`/folder/${folder.id}`)
          }

          return (
          <div
            key={folder.id}
            onClick={handleFolderClick}
            className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <FolderOpen className="h-5 w-5 text-muted-foreground flex-shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="font-medium truncate text-sm">
                  {folder.name || folder.folderId}
                </p>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mt-1">
                  <span className="flex items-center gap-1">
                    <ImageIcon className="h-3 w-3" />
                    {folder.processedImages}/{folder.totalImages} images
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {formatDate(folder.createdAt)}
                  </span>
                </div>
              </div>
            </div>
            <Badge className={`${getStatusColor(folder.status)} flex-shrink-0 ml-2`}>
              {folder.status}
            </Badge>
          </div>
          )
        })}
      </CardContent>
      
      {selectedFolder && (
        <ProcessingModal
          isOpen={showProcessingModal}
          onClose={() => {
            setShowProcessingModal(false)
            setSelectedFolder(null)
          }}
          folderName={selectedFolder.name}
          totalImages={selectedFolder.totalImages}
          processedImages={selectedFolder.processedImages}
          folderId={selectedFolder.id}
        />
      )}
    </Card>
  )
}

