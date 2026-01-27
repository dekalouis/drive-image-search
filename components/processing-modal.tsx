"use client"

import { useEffect, useState } from "react"
import { Modal } from "@/components/ui/modal"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Loader2, Clock } from "lucide-react"

interface ProcessingModalProps {
  isOpen: boolean
  onClose: () => void
  folderName: string | null
  totalImages: number
  processedImages: number
  folderId: string
}

export function ProcessingModal({
  isOpen,
  onClose,
  folderName,
  totalImages: initialTotalImages,
  processedImages: initialProcessedImages,
  folderId,
}: ProcessingModalProps) {
  const [processedImages, setProcessedImages] = useState(initialProcessedImages)
  const [totalImages, setTotalImages] = useState(initialTotalImages)

  // Poll for updates when modal is open
  useEffect(() => {
    if (!isOpen) return

    // Update immediately with initial values
    setProcessedImages(initialProcessedImages)
    setTotalImages(initialTotalImages)

    // Poll for updates every 3 seconds
    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/images?folderId=${folderId}`)
        if (response.ok) {
          const data = await response.json()
          if (data.processedImages !== undefined) {
            setProcessedImages(data.processedImages)
          }
          if (data.totalImages !== undefined) {
            setTotalImages(data.totalImages)
          }
        }
      } catch (err) {
        console.error("Error polling folder progress:", err)
      }
    }, 3000) // Poll every 3 seconds

    return () => clearInterval(pollInterval)
  }, [isOpen, folderId, initialProcessedImages, initialTotalImages])

  // Update when props change (from parent polling)
  useEffect(() => {
    setProcessedImages(initialProcessedImages)
    setTotalImages(initialTotalImages)
  }, [initialProcessedImages, initialTotalImages])

  const progressPercentage = totalImages > 0 
    ? Math.round((processedImages / totalImages) * 100) 
    : 0

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Folder Processing">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="p-3 bg-yellow-100 dark:bg-yellow-900/20 rounded-full">
            <Loader2 className="h-6 w-6 text-yellow-600 dark:text-yellow-400 animate-spin" />
          </div>
          <div>
            <h3 className="font-semibold text-lg">
              {folderName || "Folder"} is being processed
            </h3>
            <p className="text-sm text-muted-foreground">
              This folder has more than 100 images
            </p>
          </div>
        </div>

        <div className="bg-muted/50 rounded-lg p-4 space-y-3">
          {progressPercentage >= 90 ? (
            <div className="space-y-3">
              <p className="text-sm font-medium text-green-600 dark:text-green-400">
                Almost done! The folder is {progressPercentage}% complete ({totalImages - processedImages} image{totalImages - processedImages !== 1 ? 's' : ''} remaining). You can access it now, but some images may still be processing.
              </p>
            </div>
          ) : (
            <p className="text-sm">
              Sorry, this folder has more than 100 images. For the best experience, we kindly ask you to be patient while we process it.
            </p>
          )}

          {totalImages > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Processing progress</span>
                <span className="font-medium">
                  {processedImages} / {totalImages} images ({progressPercentage}%)
                </span>
              </div>
              <Progress value={progressPercentage} className="h-2" />
            </div>
          )}

          {progressPercentage < 90 && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="h-3 w-3" />
              <span>This may take a few minutes. You can close this dialog and check back later.</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Modal>
  )
}


