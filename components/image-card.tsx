"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Image as ImageIcon, Loader2, RefreshCw, ExternalLink, AlertCircle, Maximize2 } from "lucide-react"
import Image from 'next/image'

export interface ImageData {
    id: string
    fileId: string
    name: string
    thumbnailLink: string
    webViewLink: string
    status: string
    caption?: string
    similarity?: number
  }

interface ImageCardProps {
  image: ImageData
  onRetry: (imageId: string) => void
  retryingImages: Set<string>
  onSelect?: (image: ImageData) => void
}

export function ImageCard({ image, onRetry, retryingImages, onSelect }: ImageCardProps) {
  const [imageError, setImageError] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isHovered, setIsHovered] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const handleImageError = () => {
    // Only log error in development, don't spam console in production
    if (process.env.NODE_ENV === 'development') {
      console.error(`Image failed to load: ${image.fileId}`)
    }
    setImageError(true)
    setIsLoading(false)
  }

  const handleImageLoad = () => {
    setIsLoading(false)
    setImageError(false)
  }

  const handleCardClick = () => {
    // Don't allow clicks on processing/pending images
    if (image.status === "processing" || image.status === "pending") {
      return
    }
    
    // If onSelect is provided, open modal instead of Google Drive
    if (onSelect) {
      onSelect(image)
    } else if (image.webViewLink) {
      window.open(image.webViewLink, '_blank')
    }
  }
  
  const isProcessing = image.status === "processing" || image.status === "pending"

  const handleRetryClick = (e: React.MouseEvent) => {
    e.stopPropagation() // Prevent card click
    setRetryCount(prev => prev + 1)
    setImageError(false)
    setIsLoading(true)
    onRetry(image.id)
  }

  // Clean caption - remove JSON formatting if present
  const cleanCaption = (caption?: string) => {
    if (!caption) return null
    
    // Handle HTML-encoded JSON strings
    let cleanedCaption = caption
    
    // Decode HTML entities first
    if (caption.includes('&quot;')) {
      cleanedCaption = caption.replace(/&quot;/g, '"')
    }
    
    // Remove markdown code blocks if present
    if (cleanedCaption.startsWith('```json') && cleanedCaption.endsWith('```')) {
      cleanedCaption = cleanedCaption.replace(/^```json\n/, '').replace(/\n```$/, '')
    }
    
    // If caption contains JSON structure, extract just the caption text
    if (cleanedCaption.includes('"caption"')) {
      try {
        const parsed = JSON.parse(cleanedCaption)
        return parsed.caption || caption
      } catch {
        // If parsing fails, return as is
        return caption
      }
    }
    
    return cleanedCaption
  }

  const displayCaption = cleanCaption(image.caption)

  // Generate image URL - always use thumbnail proxy to avoid expired links
  const getImageUrl = () => {
    const baseUrl = `/api/thumbnail-proxy?fileId=${image.fileId}&size=220`
    return retryCount > 0 ? `${baseUrl}&retry=${retryCount}` : baseUrl
  }

  return (
    <Card 
      className={`overflow-hidden transition-all duration-200 group ${
        isProcessing ? "opacity-50 cursor-not-allowed" : image.status === "failed" ? "opacity-60 cursor-pointer" : "cursor-pointer"
      } ${
        !isProcessing && isHovered ? "scale-105 shadow-lg" : !isProcessing ? "hover:scale-102 hover:shadow-md" : ""
      }`}
      onMouseEnter={() => !isProcessing && setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleCardClick}
    >
      <div className="aspect-square relative">
        {/* Loading state */}
        {isLoading && (
          <div className="absolute inset-0 bg-muted flex items-center justify-center z-10">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}

        {/* Main image - prioritize thumbnails */}
        {!imageError && (image.thumbnailLink || image.fileId) ? (
          <Image
            src={getImageUrl()}
            alt={image.name}
            width={200}
            height={200}
            className={`w-full h-full object-cover transition-all duration-200 ${
              isProcessing ? "grayscale" : image.status === "failed" ? "grayscale blur-sm" : ""
            } ${!isProcessing && isHovered ? "brightness-110" : ""} ${isLoading ? "opacity-0" : "opacity-100"}`}
            onError={handleImageError}
            onLoad={handleImageLoad}
            priority={false}
          />
        ) : (
          <div className="w-full h-full bg-muted flex items-center justify-center">
            <div className="text-center">
              <ImageIcon className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-xs text-muted-foreground">Image unavailable</p>
              {imageError && (
                <AlertCircle className="h-4 w-4 text-red-500 mx-auto mt-1" />
              )}
            </div>
          </div>
        )}
        
        {/* Status badge */}
        <div className="absolute top-2 right-2 z-20">
          <Badge 
            variant={image.status === "failed" ? "destructive" : "secondary"} 
            className="text-xs"
          >
            {image.status}
          </Badge>
        </div>
        
        {/* Hover overlay with icon - only show for completed images */}
        {isHovered && !imageError && !isProcessing && image.status !== "failed" && (
          <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-30">
            <div className="bg-white/90 rounded-full p-2">
              {onSelect ? (
                <Maximize2 className="h-5 w-5 text-black" />
              ) : (
                <ExternalLink className="h-5 w-5 text-black" />
              )}
            </div>
          </div>
        )}
        
        {/* Processing overlay */}
        {isProcessing && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-30">
            <div className="bg-white/90 rounded-lg px-3 py-2 flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-gray-600" />
              <span className="text-xs font-medium text-gray-700">Processing...</span>
            </div>
          </div>
        )}
        
        {/* Retry button for failed images or image errors */}
        {(image.status === "failed" || imageError) && (
          <div className="absolute inset-0 bg-black/20 flex items-center justify-center z-40">
            <Button
              onClick={handleRetryClick}
              disabled={retryingImages.has(image.id) || isLoading}
              size="sm"
              className="bg-white/90 hover:bg-white text-black"
            >
              {retryingImages.has(image.id) || isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="h-4 w-4" />
              )}
              {imageError ? "Reload" : "Retry"}
            </Button>
          </div>
        )}
        
        {/* Similarity score badge */}
        {image.similarity && (
          <div className="absolute bottom-2 left-2 z-20">
            <Badge variant="outline" className="text-xs bg-white/90">
              {Math.round(image.similarity * 100)}% match
            </Badge>
          </div>
        )}
      </div>
      
      <CardContent className="p-3">
        <p className="text-sm font-medium truncate" title={image.name}>
          {image.name}
        </p>
        
        {displayCaption && (
          <p className="text-xs text-muted-foreground mt-1 line-clamp-2" title={displayCaption}>
            {displayCaption}
          </p>
        )}
        
      </CardContent>
    </Card>
  )
} 