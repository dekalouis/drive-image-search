"use client"

import { useEffect, useState, useCallback, useRef } from "react"
import { useParams, useRouter } from "next/navigation"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Search, Image as ImageIcon, Loader2, RefreshCw, ChevronLeft, ChevronRight, FolderSync, ExternalLink, AlertTriangle } from "lucide-react"
import { ImageCard, type ImageData } from "@/components/image-card"
import { Modal } from "@/components/ui/modal"
import NextImage from "next/image"

interface Image {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  status: string
  caption?: string
  tags?: string
  similarity?: number
}

interface Folder {
  id: string
  folderId: string
  name: string | null
  status: string
  totalImages: number
  processedImages: number
  images: Image[]
}

export default function FolderPage() {
  const params = useParams()
  const router = useRouter()
  const folderId = params.id as string
  
  const [folder, setFolder] = useState<Folder | null>(null)
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState("")
  const [searchResults, setSearchResults] = useState<Image[]>([])
  const [searching, setSearching] = useState(false)
  const [searchFallbackMode, setSearchFallbackMode] = useState(false)
  const [retryingImages, setRetryingImages] = useState<Set<string>>(new Set())
  const [retryingAll, setRetryingAll] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncMessage, setSyncMessage] = useState<string | null>(null)
  const [selectedImage, setSelectedImage] = useState<ImageData | null>(null)
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1)
  const [imagesPerPage, setImagesPerPage] = useState(25)

  const fetchFolderData = useCallback(async () => {
    try {
      const response = await fetch(`/api/images?folderId=${folderId}`)
      if (response.ok) {
        const data = await response.json()
        setFolder(data)
        setLoading(false)
        
        // Check if folder is processing/pending and has >100 images - redirect to dashboard
        // Allow access if folder is nearly complete (90%+ or <= 10 images remaining) - more lenient
        const remainingImages = data.totalImages - data.processedImages
        const completionPercentage = data.totalImages > 0 
          ? (data.processedImages / data.totalImages) * 100 
          : 0
        const isNearlyComplete = completionPercentage >= 90 || remainingImages <= 10
        
        // Completed folders can always be accessed
        // Nearly complete folders (>90% or <=10 remaining) can also be accessed
        if ((data.status === "processing" || data.status === "pending") && data.totalImages > 100 && !isNearlyComplete) {
          router.push("/")
          return
        }
      } else if (response.status === 404) {
        // Folder doesn't exist - remove from localStorage and redirect to dashboard
        console.log(`🗑️  Folder ${folderId} not found, removing from localStorage and redirecting...`)
        if (typeof window !== 'undefined') {
          try {
            const { removeFolder } = await import('@/lib/local-storage')
            removeFolder(folderId)
          } catch (err) {
            console.error("Error removing folder from localStorage:", err)
          }
        }
        router.push("/")
      }
    } catch (error) {
      console.error("Error fetching folder data:", error)
      setLoading(false)
    }
  }, [folderId, router])

  useEffect(() => {
    fetchFolderData()
    const interval = setInterval(fetchFolderData, 2000) // Poll every 2 seconds
    return () => clearInterval(interval)
  }, [folderId, fetchFolderData])

  // Debounced search effect
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  
  useEffect(() => {
    // Clear previous timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current)
    }

    // If search query is empty, clear results immediately
    if (!searchQuery.trim()) {
      setSearchResults([])
      setSearching(false)
      return
    }

    // Set loading state immediately
    setSearching(true)

    // Debounce search - wait 500ms after user stops typing
    searchTimeoutRef.current = setTimeout(async () => {
      try {
        const response = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: searchQuery, folderId }),
        })
        
        if (response.ok) {
          const data = await response.json()
          // Format results with proper typing
          const formattedResults = data.results.map((result: { similarity: number; [key: string]: unknown }) => ({
            ...result,
            similarity: Math.round(result.similarity * 1000) / 1000, // Round to 3 decimal places
          }))
          setSearchResults(formattedResults)
          setSearchFallbackMode(data.fallbackMode || false)
        }
      } catch (error) {
        console.error("Search error:", error)
      } finally {
        setSearching(false)
      }
    }, 500) // 500ms debounce delay

    // Cleanup function
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
    }
  }, [searchQuery, folderId])

  // Reset to first page when search changes
  useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery])

  const handleRetryImage = async (imageId: string) => {
    setRetryingImages(prev => new Set(prev).add(imageId))
    
    try {
      const response = await fetch("/api/retry-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageId }),
      })
      
      if (response.ok) {
        console.log("Image queued for retry")
        // Refresh data after a short delay
        setTimeout(fetchFolderData, 1000)
      } else {
        console.error("Failed to retry image")
      }
    } catch (error) {
      console.error("Retry error:", error)
    } finally {
      setRetryingImages(prev => {
        const newSet = new Set(prev)
        newSet.delete(imageId)
        return newSet
      })
    }
  }

  const handleRetryAllFailed = async () => {
    setRetryingAll(true)
    
    try {
      const response = await fetch("/api/retry-image", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      })
      
      if (response.ok) {
        const data = await response.json()
        console.log(data.message)
        // Refresh data after a short delay
        setTimeout(fetchFolderData, 1000)
      } else {
        console.error("Failed to retry failed images")
      }
    } catch (error) {
      console.error("Retry all error:", error)
    } finally {
      setRetryingAll(false)
    }
  }

  const handleSync = async () => {
    setSyncing(true)
    setSyncMessage(null)
    
    try {
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId }),
      })
      
      const data = await response.json()
      
      if (response.ok) {
        setSyncMessage(data.message)
        // Refresh data
        fetchFolderData()
        // Clear message after 5 seconds
        setTimeout(() => setSyncMessage(null), 5000)
      } else {
        setSyncMessage(`Error: ${data.error}`)
      }
    } catch (error) {
      console.error("Sync error:", error)
      setSyncMessage("Sync failed. Please try again.")
    } finally {
      setSyncing(false)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status) {
      case "completed": return "bg-green-500"
      case "processing": return "bg-yellow-500"
      case "failed": return "bg-red-500"
      default: return "bg-gray-500"
    }
  }

  // Sort images: failed first, then by status
  const sortImages = (images: Image[]) => {
    return [...images].sort((a, b) => {
      if (a.status === "failed" && b.status !== "failed") return -1
      if (a.status !== "failed" && b.status === "failed") return 1
      return 0
    })
  }

  // Pagination logic
  const allImages = searchQuery ? searchResults : sortImages(folder?.images || [])
  const totalPages = Math.ceil(allImages.length / imagesPerPage)
  const startIndex = (currentPage - 1) * imagesPerPage
  const endIndex = startIndex + imagesPerPage
  const currentImages = allImages.slice(startIndex, endIndex)

  // Generate page numbers for pagination
  const getPageNumbers = () => {
    const pages = []
    const maxVisiblePages = 5
    
    if (totalPages <= maxVisiblePages) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i)
      }
    } else {
      if (currentPage <= 3) {
        for (let i = 1; i <= 4; i++) {
          pages.push(i)
        }
        pages.push('...')
        pages.push(totalPages)
      } else if (currentPage >= totalPages - 2) {
        pages.push(1)
        pages.push('...')
        for (let i = totalPages - 3; i <= totalPages; i++) {
          pages.push(i)
        }
      } else {
        pages.push(1)
        pages.push('...')
        for (let i = currentPage - 1; i <= currentPage + 1; i++) {
          pages.push(i)
        }
        pages.push('...')
        pages.push(totalPages)
      }
    }
    
    return pages
  }

  // Pagination component
  const Pagination = ({ position }: { position: 'top' | 'bottom' }) => (
    <div className={`${position === 'top' ? 'mb-4' : 'mt-6'}`}>
      {/* Top section: Show per page and image count */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4">
        <div className="flex flex-col sm:flex-row sm:items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Show:</span>
            <select
              value={imagesPerPage}
              onChange={(e) => {
                setImagesPerPage(Number(e.target.value))
                setCurrentPage(1)
              }}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
            <span className="text-sm text-muted-foreground">per page</span>
          </div>
          
          <div className="text-sm text-muted-foreground">
            Showing {startIndex + 1}-{Math.min(endIndex, allImages.length)} of {allImages.length} images
          </div>
        </div>
      </div>

      {/* Bottom section: Page navigation */}
      {totalPages > 1 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-center gap-4">
          {/* Mobile: Simple chevron buttons next to page numbers */}
          <div className="flex sm:hidden items-center justify-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
              className="w-8 h-8 p-0"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            
            {/* Page numbers */}
            <div className="flex items-center gap-1 flex-wrap">
              {getPageNumbers().map((page, index) => (
                <div key={index}>
                  {page === '...' ? (
                    <span className="px-2 py-1 text-sm text-muted-foreground">...</span>
                  ) : (
                    <Button
                      variant={currentPage === page ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCurrentPage(page as number)}
                      className="w-8 h-8 p-0"
                    >
                      {page}
                    </Button>
                  )}
                </div>
              ))}
            </div>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
              className="w-8 h-8 p-0"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>

          {/* Desktop: Full Previous/Next buttons */}
          <div className="hidden sm:flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.max(1, currentPage - 1))}
              disabled={currentPage === 1}
            >
              <ChevronLeft className="h-4 w-4" />
              Previous
            </Button>

            {/* Page numbers */}
            <div className="flex items-center gap-1 flex-wrap">
              {getPageNumbers().map((page, index) => (
                <div key={index}>
                  {page === '...' ? (
                    <span className="px-2 py-1 text-sm text-muted-foreground">...</span>
                  ) : (
                    <Button
                      variant={currentPage === page ? "default" : "outline"}
                      size="sm"
                      onClick={() => setCurrentPage(page as number)}
                      className="w-8 h-8 p-0"
                    >
                      {page}
                    </Button>
                  )}
                </div>
              ))}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={() => setCurrentPage(Math.min(totalPages, currentPage + 1))}
              disabled={currentPage === totalPages}
            >
              Next
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  )

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted/20 flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading folder...</p>
        </div>
      </div>
    )
  }

  if (!folder) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-background to-muted/20 flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Folder Not Found</CardTitle>
            <CardDescription>The requested folder could not be found.</CardDescription>
          </CardHeader>
        </Card>
      </div>
    )
  }

  const progressPercentage = folder.totalImages > 0 ? (folder.processedImages / folder.totalImages) * 100 : 0
  const failedImages = folder.images.filter(img => img.status === "failed")

  return (
    <div className="min-h-screen bg-gradient-to-br from-background to-muted/20 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="mb-4">
            <h1 className="text-2xl sm:text-3xl font-bold mb-2">
              {folder.name || "Google Drive Images"}
            </h1>
            <p className="text-muted-foreground text-sm sm:text-base">
              {folder.name ? `Folder: ${folder.folderId}` : `Folder ID: ${folder.folderId}`}
            </p>
          </div>
          
          {/* Status and Progress */}
          <Card className="mb-6">
            <CardHeader>
              <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <CardTitle className="flex items-center gap-2">
                  <Badge className={getStatusColor(folder.status)}>
                    {folder.status}
                  </Badge>
                  Processing Status
                </CardTitle>
                <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                  <div className="text-sm text-muted-foreground">
                    {folder.processedImages} / {folder.totalImages} images
                  </div>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <Button
                      onClick={handleSync}
                      disabled={syncing}
                      variant="outline"
                      size="sm"
                      className="flex items-center gap-2 w-full sm:w-auto justify-center"
                    >
                      {syncing ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <FolderSync className="h-4 w-4" />
                      )}
                      Sync with Drive
                    </Button>
                    {failedImages.length > 0 && (
                      <Button
                        onClick={handleRetryAllFailed}
                        disabled={retryingAll}
                        variant="outline"
                        size="sm"
                        className="flex items-center gap-2 w-full sm:w-auto justify-center"
                      >
                        {retryingAll ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      Retry All Failed ({failedImages.length})
                    </Button>
                  )}
                  </div>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              <Progress value={progressPercentage} className="mb-2" />
              <p className="text-sm text-muted-foreground">
                {folder.status === "processing" && "Images are being processed in the background..."}
                {folder.status === "completed" && "All images have been processed!"}
                {folder.status === "failed" && "Processing failed. Please try again."}
              </p>
              {syncMessage && (
                <p className={`text-sm mt-2 ${syncMessage.startsWith('Error') ? 'text-red-500' : 'text-green-600'}`}>
                  {syncMessage}
                </p>
              )}
            </CardContent>
          </Card>

          {/* Search */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Search className="h-5 w-5" />
                Search Images
              </CardTitle>
              <CardDescription>
                Search through your images using natural language queries
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Input
                    placeholder="Search by description or filename (e.g., 'cat' or 'vacation.jpg')"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="flex-1 pr-10"
                  />
                  {searching && (
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    </div>
                  )}
                </div>
              </div>
              {searchQuery && (
                <p className="text-xs text-muted-foreground mt-1">
                  {searching ? "Searching..." : `Showing ${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`}
                </p>
              )}
              {searchFallbackMode && (
                <Alert className="mt-3 border-orange-200 bg-orange-50 dark:bg-orange-950/20">
                  <AlertTriangle className="h-4 w-4 text-orange-600 dark:text-orange-400" />
                  <AlertTitle className="text-orange-800 dark:text-orange-200">Limited Search Mode</AlertTitle>
                  <AlertDescription className="text-orange-700 dark:text-orange-300">
                    Semantic search is unavailable. Using filename search instead. Results may be less accurate.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Top Pagination */}
        {allImages.length > 0 && <Pagination position="top" />}

        {/* Images Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {currentImages.map((image) => (
            <ImageCard
              key={image.id}
              image={image}
              onRetry={handleRetryImage}
              retryingImages={retryingImages}
              onSelect={setSelectedImage}
            />
          ))}
        </div>

        {/* Bottom Pagination */}
        {allImages.length > 0 && <Pagination position="bottom" />}

        {allImages.length === 0 && (
          <div className="text-center py-12">
            <ImageIcon className="h-12 w-12 text-muted-foreground mx-auto mb-4" />
            <p className="text-muted-foreground">
              {searchQuery ? "No images found matching your search." : "No images in this folder."}
            </p>
          </div>
        )}
      </div>

      {/* Image Detail Modal */}
      <Modal
        isOpen={!!selectedImage}
        onClose={() => setSelectedImage(null)}
        title={selectedImage?.name}
      >
        {selectedImage && (
          <div className="space-y-4">
            {/* Image */}
            <div className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden">
              <NextImage
                src={`/api/thumbnail-proxy?fileId=${selectedImage.fileId}&size=800`}
                alt={selectedImage.name}
                fill
                className="object-contain"
                priority
              />
            </div>

            {/* Similarity score if present */}
            {selectedImage.similarity && (
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className="text-sm">
                  {Math.round(selectedImage.similarity * 100)}% match
                </Badge>
              </div>
            )}

            {/* Description */}
            {selectedImage.caption && (
              <div className="space-y-2">
                <h3 className="font-semibold text-foreground">Description</h3>
                <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 p-4 rounded-lg max-h-64 overflow-y-auto">
                  {selectedImage.caption}
                </div>
              </div>
            )}

            {/* Tags */}
            {selectedImage.tags && (
              <div className="space-y-2">
                <h3 className="font-semibold text-foreground">Tags</h3>
                <div className="flex flex-wrap gap-2">
                  {selectedImage.tags.split(',').map((tag, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      {tag.trim()}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {/* Open in Drive button */}
            {selectedImage.webViewLink && (
              <div className="pt-2">
                <Button
                  onClick={() => window.open(selectedImage.webViewLink, '_blank')}
                  variant="outline"
                  className="w-full sm:w-auto"
                >
                  <ExternalLink className="h-4 w-4 mr-2" />
                  Open in Google Drive
                </Button>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
} 