"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Loader2, Check, AlertCircle } from "lucide-react"

export interface LinkInputProps {
  onFolderReady: (folderId: string, folderStats: { totalImages: number; processedImages: number; status: string }) => void
  onSearch: (prompt: string) => void
  step1Complete?: boolean
  /** True only when folder is fully processed; search is disabled until then */
  canSearch?: boolean
}

export function LinkInput({ onFolderReady, onSearch, step1Complete = false, canSearch = false }: LinkInputProps) {
  const [link, setLink] = useState("")
  const [prompt, setPrompt] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")

  const handleLinkBlur = async () => {
    if (!link.trim() || step1Complete || loading) return

    setLoading(true)
    setError("")

    try {
      const response = await fetch("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderUrl: link.trim() }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error || "Failed to process folder")
      }

      onFolderReady(data.id, {
        totalImages: data.totalImages,
        processedImages: data.processedImages || 0,
        status: data.status,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred")
    } finally {
      setLoading(false)
    }
  }

  const handlePromptChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setPrompt(e.target.value)
  }

  const handleSearch = () => {
    if (prompt.trim() && step1Complete && canSearch) {
      onSearch(prompt.trim())
      setPrompt("")
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && step1Complete && canSearch) {
      handleSearch()
    }
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <div className="space-y-8">
        {/* Step 1: Link Input */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold transition-all duration-200 ${
              step1Complete 
                ? "bg-green-500 text-white" 
                : loading 
                ? "bg-gray-800 text-white" 
                : "bg-gray-200 text-gray-800"
            }`}>
              {step1Complete ? <Check className="w-4 h-4" /> : loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "1"}
            </div>
            <label className="text-sm font-medium text-foreground">
              Enter your Google Drive link
            </label>
          </div>
          <Input
            type="url"
            placeholder="https://drive.google.com/drive/folders/..."
            value={link}
            onChange={(e) => setLink(e.target.value)}
            onBlur={handleLinkBlur}
            disabled={loading || step1Complete}
            className="text-sm bg-white dark:bg-gray-900"
          />
          {error && (
            <Alert variant="destructive" className="mt-2">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        {/* Step 2: Prompt Input - enabled only when folder is fully processed (canSearch) */}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded flex items-center justify-center text-xs font-bold transition-all duration-200 ${
              step1Complete && canSearch && prompt.trim()
                ? "bg-gray-800 text-white dark:bg-gray-100 dark:text-gray-800"
                : step1Complete && canSearch
                ? "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200"
                : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600"
            }`}>
              2
            </div>
            <label className="text-sm font-medium text-foreground">
              What photos are you looking for?
            </label>
            {step1Complete && !canSearch && (
              <span className="text-xs text-muted-foreground">(wait for processing to finish)</span>
            )}
          </div>
          <Input
            placeholder={canSearch ? "Photos of people in black jerseys with a clear face to the camera" : "Search available when folder is done processing"}
            value={prompt}
            onChange={handlePromptChange}
            onKeyPress={handleKeyPress}
            disabled={!step1Complete || !canSearch}
            className="text-sm bg-white dark:bg-gray-900"
          />
          {step1Complete && canSearch && (
            <Button 
              onClick={handleSearch}
              disabled={!prompt.trim()}
              className="w-full bg-gray-800 hover:bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-gray-200"
            >
              Search
            </Button>
          )}
        </div>

        {/* Instructions */}
        <div className="text-xs text-muted-foreground space-y-2 bg-gray-100/50 dark:bg-gray-800/30 p-4 rounded-lg">
          <p>
            <span className="font-semibold text-foreground">Step 1:</span> Paste the file link in the top field and let our systems process it. The more photos, the longer it'll take.
          </p>
          <p>
            <span className="font-semibold text-foreground">Step 2:</span> Once processed, type in a prompt for what photos you want to find
          </p>
        </div>
      </div>
    </div>
  )
}
