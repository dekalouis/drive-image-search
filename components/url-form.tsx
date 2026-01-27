"use client"

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { FolderOpen, Loader2 } from "lucide-react"
import { useAuth } from "@clerk/nextjs"

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

interface UrlFormProps {
  onSuccess: (folder: FolderData) => void
}

export function UrlForm({ onSuccess }: UrlFormProps) {
  const { isSignedIn } = useAuth()
  const [url, setUrl] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!url.trim()) return

    setLoading(true)
    setError("")

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderUrl: url.trim() }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to process folder")
      }

      // Pass full folder data to onSuccess
      onSuccess({
        id: data.id,
        folderId: data.folderId,
        name: data.name,
        folderUrl: data.folderUrl || url.trim(),
        status: data.status,
        totalImages: data.totalImages,
        processedImages: data.processedImages || 0,
        createdAt: data.createdAt || new Date().toISOString(),
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card className="w-full max-w-2xl mx-auto">
      <CardHeader className="text-center">
        <div className="flex justify-center mb-4">
          <FolderOpen className="h-12 w-12 text-primary" />
        </div>
        <CardTitle className="text-2xl font-bold">Google Drive Image Searcher</CardTitle>
        <CardDescription>
          Paste a Google Drive folder link to search through images using AI-powered captions. Private folders are accessible when logged in.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Input
              type="url"
              placeholder="https://drive.google.com/drive/folders/..."
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={loading}
              className="text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {isSignedIn 
                ? "You can access both public and private folders when logged in."
                : "For public folders, make sure it's shared with &quot;Anyone with the link&quot; (viewer access). Log in to access private folders."
              }
            </p>
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={loading || !url.trim()} className="w-full">
            {loading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Processing Folder...
              </>
            ) : (
              "Analyze Images"
            )}
          </Button>
        </form>

        <div className="mt-6 pt-6 border-t space-y-3">
          <div className="text-sm text-muted-foreground space-y-2">
            <p>
              <span className="font-semibold text-foreground">Supported formats:</span> JPG, PNG, GIF, WebP, BMP
            </p>
            <p>
              <span className="font-semibold text-foreground">How it works:</span> We&apos;ll analyze each image with AI to create searchable captions
            </p>
            <p>
              <span className="font-semibold text-foreground">Privacy:</span> Images are processed securely and not stored permanently
            </p>
            <p>
              <span className="font-semibold text-foreground">Access:</span> {isSignedIn 
                ? "You can access both public and private folders when logged in"
                : "Public folders must be set to &quot;Anyone with the link&quot; (viewer). Log in to access private folders."
              }
            </p>
            <p>
              <span className="font-semibold text-foreground">Image limit:</span> Folders with up to {process.env.NEXT_PUBLIC_MAX_IMAGES_PER_FOLDER || '200'} images are supported. Folders with more than 100 images need time to process.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
