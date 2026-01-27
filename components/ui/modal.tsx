"use client"

import { useEffect } from "react"
import { X } from "lucide-react"
import { Button } from "@/components/ui/button"

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
}

export function Modal({ isOpen, onClose, children, title }: ModalProps) {
  // Lock body scroll when modal is open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = "hidden"
    } else {
      document.body.style.overflow = "unset"
    }
    return () => {
      document.body.style.overflow = "unset"
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose()
      }
    }

    if (isOpen) {
      document.addEventListener("keydown", handleEscape)
    }

    return () => {
      document.removeEventListener("keydown", handleEscape)
    }
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity"
        onClick={onClose}
      />
      
      {/* Modal content */}
      <div className="relative bg-background rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between p-4 sm:p-6 border-b">
            <h2 className="text-lg sm:text-xl font-semibold truncate pr-4">{title}</h2>
            <Button
              variant="ghost"
              size="icon"
              onClick={onClose}
              className="shrink-0"
            >
              <X className="h-5 w-5" />
              <span className="sr-only">Close</span>
            </Button>
          </div>
        )}
        
        {/* Close button when no title */}
        {!title && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            className="absolute top-4 right-4 z-10"
          >
            <X className="h-5 w-5" />
            <span className="sr-only">Close</span>
          </Button>
        )}
        
        {/* Scrollable content */}
        <div className="overflow-y-auto p-4 sm:p-6">
          {children}
        </div>
      </div>
    </div>
  )
}


