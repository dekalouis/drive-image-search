"use client"

import { useEffect, useState, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Search, FileText, Sparkles, Loader2 } from "lucide-react"

interface Image {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  status: string
  caption?: string
  similarity?: number
}

interface SearchBarProps {
  folderId: string
  onResultsChange: (results: Image[]) => void
  onQueryChange?: (query: string) => void
}

export function SearchBar({ folderId, onResultsChange, onQueryChange }: SearchBarProps) {
  const [searchQuery, setSearchQuery] = useState("")
  const [searchMode, setSearchMode] = useState<'filename' | 'semantic'>('filename')
  const [searching, setSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Image[]>([])
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null)

  // Notify parent when query changes (for pagination reset)
  useEffect(() => {
    onQueryChange?.(searchQuery)
  }, [searchQuery, onQueryChange])

  // Debounced search effect - only for filename mode
  useEffect(() => {
    // Only run debounced search in filename mode
    if (searchMode !== 'filename') {
      // Clear any pending search timeouts
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current)
      }
      return
    }

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
          body: JSON.stringify({
            query: searchQuery,
            folderId,
            searchType: 'filename'
          }),
        })

        if (response.ok) {
          const data = await response.json()
          // Format results with proper typing
          const formattedResults = data.results.map((result: { similarity: number; [key: string]: unknown }) => ({
            ...result,
            similarity: Math.round(result.similarity * 1000) / 1000, // Round to 3 decimal places
          }))
          setSearchResults(formattedResults)
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
  }, [searchQuery, folderId, searchMode])

  // Clear results when query is cleared in semantic mode
  useEffect(() => {
    if (searchMode === 'semantic' && !searchQuery.trim()) {
      setSearchResults([])
      setSearching(false)
    }
  }, [searchQuery, searchMode])

  // Notify parent when results change
  useEffect(() => {
    onResultsChange(searchResults)
  }, [searchResults, onResultsChange])

  const handleSemanticSearch = async () => {
    if (!searchQuery.trim()) return
    setSearching(true)

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: searchQuery,
          folderId,
          searchType: 'semantic'
        }),
      })

      if (response.ok) {
        const data = await response.json()
        // Format results with proper typing
        const formattedResults = data.results.map((result: { similarity: number; [key: string]: unknown }) => ({
          ...result,
          similarity: Math.round(result.similarity * 1000) / 1000, // Round to 3 decimal places
        }))
        setSearchResults(formattedResults)
      }
    } catch (error) {
      console.error("Search error:", error)
    } finally {
      setSearching(false)
    }
  }

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (searchMode === 'semantic' && e.key === 'Enter') {
      e.preventDefault()
      handleSemanticSearch()
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Search className="h-5 w-5" />
          Search Images
        </CardTitle>
        <CardDescription>
          {searchMode === 'filename'
            ? 'Find images by filename'
            : 'Describe what you are looking for'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {/* Mode Toggle and Search Input */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
            {/* Mode Toggle - Segmented button group */}
            <div className="flex rounded-md border border-input overflow-hidden shrink-0">
              <button
                onClick={() => {
                  setSearchMode('filename')
                  setSearchResults([])
                }}
                className={`px-3 py-2 text-sm flex items-center gap-1.5 transition-colors ${
                  searchMode === 'filename'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-muted text-foreground'
                }`}
              >
                <FileText className="h-4 w-4" />
                <span className="hidden sm:inline">Filename</span>
              </button>
              <div className="w-px bg-input"></div>
              <button
                onClick={() => {
                  setSearchMode('semantic')
                  setSearchResults([])
                }}
                className={`px-3 py-2 text-sm flex items-center gap-1.5 transition-colors ${
                  searchMode === 'semantic'
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background hover:bg-muted text-foreground'
                }`}
              >
                <Sparkles className="h-4 w-4" />
                <span className="hidden sm:inline">Semantic</span>
              </button>
            </div>

            {/* Search Input */}
            <div className="relative flex-1">
              <Input
                placeholder={searchMode === 'filename'
                  ? 'Type filename to search...'
                  : 'Describe what you are looking for...'}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
                className="flex-1"
              />
              {searching && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>

            {/* Submit button - only in semantic mode */}
            {searchMode === 'semantic' && (
              <Button
                onClick={handleSemanticSearch}
                disabled={searching || !searchQuery.trim()}
                size="sm"
                className="shrink-0"
              >
                <Search className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Helper text */}
          {searchQuery && (
            <p className="text-xs text-muted-foreground">
              {searching
                ? "Searching..."
                : searchMode === 'semantic' && searchResults.length === 0
                  ? "Press Enter or click the search button to find images"
                  : `Showing ${searchResults.length} result${searchResults.length !== 1 ? 's' : ''}`
              }
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
