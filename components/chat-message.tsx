"use client"

import { useState } from "react"
import Image from "next/image"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ChevronRight, Download, Loader2 } from "lucide-react"
import { Modal } from "@/components/ui/modal"

interface SearchResult {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  caption?: string
  similarity?: number
}

interface ChatMessageProps {
  role: "user" | "assistant"
  content: string
  images?: SearchResult[]
  totalCandidates?: number
}

export function ChatMessage({ 
  role, 
  content, 
  images = [] 
}: ChatMessageProps) {
  const [expandedImages, setExpandedImages] = useState(false)
  const [selectedImage, setSelectedImage] = useState<SearchResult | null>(null)
  const [downloadingAll, setDownloadingAll] = useState(false)

  const visibleImages = expandedImages ? images : images.slice(0, 5)
  const hasMore = images.length > 5
  const moreCount = images.length - 5

  const handleDownloadAll = async () => {
    if (images.length === 0) return
    
    setDownloadingAll(true)
    try {
      // Open images in new tabs as a simple download alternative
      images.forEach((image, index) => {
        setTimeout(() => {
          window.open(
            `/api/thumbnail-proxy?fileId=${image.fileId}&size=800`,
            '_blank'
          )
        }, index * 200) // Stagger opens to avoid being blocked as popup spam
      })
    } catch (error) {
      console.error("Download error:", error)
    } finally {
      setDownloadingAll(false)
    }
  }

  if (role === "user") {
    return (
      <div className="flex justify-end mb-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="max-w-md bg-gray-800 dark:bg-gray-700 text-white rounded-lg px-4 py-2 text-sm break-words">
          {content}
        </div>
      </div>
    )
  }

  // Assistant message
  return (
    <div className="mb-6 animate-in fade-in slide-in-from-left-2 duration-300">
      <div className="text-sm text-gray-700 dark:text-gray-300 mb-4 leading-relaxed">
        {content}
      </div>

      {images.length > 0 && (
        <div className="space-y-4">
          {/* Image Grid - 3 columns on first row, 2 on second row like the screenshots */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {visibleImages.map((image, idx) => (
              <div
                key={image.id}
                className={`relative aspect-square bg-muted rounded overflow-hidden cursor-pointer hover:shadow-md hover:scale-105 transition-all duration-200 group ${
                  idx >= 3 && visibleImages.length > 3 ? 'col-span-1' : ''
                }`}
                onClick={() => setSelectedImage(image)}
              >
                <Image
                  src={`/api/thumbnail-proxy?fileId=${image.fileId}&size=220`}
                  alt={image.name}
                  fill
                  className="object-cover group-hover:brightness-110 transition-all duration-200"
                  onError={(e) => {
                    const img = e.currentTarget as HTMLImageElement
                    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23f3f4f6' width='100' height='100'/%3E%3C/svg%3E"
                  }}
                />
                {image.similarity && (
                  <div className="absolute bottom-2 left-2 bg-white/95 text-xs font-semibold px-2 py-1 rounded text-gray-800">
                    {Math.round(image.similarity * 100)}%
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* View More Link */}
          {hasMore && !expandedImages && (
            <button
              onClick={() => setExpandedImages(true)}
              className="text-sm text-primary hover:underline flex items-center gap-1 font-medium"
            >
              View {moreCount} more <ChevronRight className="w-4 h-4" />
            </button>
          )}

          {expandedImages && hasMore && (
            <button
              onClick={() => setExpandedImages(false)}
              className="text-sm text-primary hover:underline font-medium"
            >
              View less
            </button>
          )}

          {/* Download All Button */}
          {images.length > 0 && (
            <div className="pt-2">
              <Button
                onClick={handleDownloadAll}
                disabled={downloadingAll}
                variant="default"
                size="sm"
                className="gap-2"
              >
                {downloadingAll ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Download className="w-4 h-4" />
                )}
                Download all
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Image Detail Modal */}
      <Modal
        isOpen={!!selectedImage}
        onClose={() => setSelectedImage(null)}
        title={selectedImage?.name}
      >
        {selectedImage && (
          <div className="space-y-4">
            <div className="relative w-full aspect-video bg-muted rounded-lg overflow-hidden">
              <Image
                src={`/api/thumbnail-proxy?fileId=${selectedImage.fileId}&size=800`}
                alt={selectedImage.name}
                fill
                className="object-contain"
                priority
              />
            </div>

            {selectedImage.similarity && (
              <Badge variant="secondary" className="text-sm">
                {Math.round(selectedImage.similarity * 100)}% match
              </Badge>
            )}

            {selectedImage.caption && (
              <div className="space-y-2">
                <h3 className="font-semibold text-foreground">Description</h3>
                <div className="text-sm text-muted-foreground whitespace-pre-wrap bg-muted/50 p-4 rounded-lg max-h-64 overflow-y-auto">
                  {selectedImage.caption}
                </div>
              </div>
            )}

            {selectedImage.webViewLink && (
              <Button
                onClick={() => window.open(selectedImage.webViewLink, '_blank')}
                variant="outline"
                className="w-full"
              >
                Open in Google Drive
              </Button>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
