"use client"

import { useEffect, useState } from "react"
import { LinkInput } from "@/components/link-input"
import { ChatThread } from "@/components/chat-thread"
import { ChatInputBar } from "@/components/chat-input-bar"
import { Loader2 } from "lucide-react"

type AppState = "idle" | "loading" | "ready" | "chatting" | "searching"

interface SearchResult {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  caption?: string
  similarity?: number
}

interface ChatMessage {
  id: string
  role: "user" | "assistant"
  content: string
  images?: SearchResult[]
  totalCandidates?: number
  timestamp: Date
}

interface FolderStats {
  totalImages: number
  processedImages: number
  status: string
}

export default function HomePage() {
  const [appState, setAppState] = useState<AppState>("idle")
  const [folderId, setFolderId] = useState<string>("")
  const [folderStats, setFolderStats] = useState<FolderStats | null>(null)
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([])

  // Poll folder status until ready
  useEffect(() => {
    if (appState !== "loading" || !folderId) return

    const pollInterval = setInterval(async () => {
      try {
        const response = await fetch(`/api/images?folderId=${folderId}`)
        if (response.ok) {
          const data = await response.json()
          setFolderStats({
            totalImages: data.totalImages,
            processedImages: data.processedImages,
            status: data.status,
          })

          // Only allow search when folder is fully processed (status completed, all images done)
          const isFullyProcessed =
            data.status === "completed" &&
            data.totalImages > 0 &&
            data.processedImages >= data.totalImages
          if (isFullyProcessed) {
            setAppState("ready")
          }
        }
      } catch (error) {
        console.error("Error polling folder status:", error)
      }
    }, 2000)

    return () => clearInterval(pollInterval)
  }, [appState, folderId])

  const handleFolderReady = (id: string, stats: FolderStats) => {
    setFolderId(id)
    setFolderStats(stats)
    setAppState("loading")
  }

  const handleSearch = async (prompt: string) => {
    if (!folderId || (appState !== "ready" && appState !== "chatting")) return

    // Add user message immediately
    const userMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "user",
      content: prompt,
      timestamp: new Date(),
    }
    setChatMessages((prev) => [...prev, userMessage])
    setAppState("searching")

    try {
      const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: prompt, folderId }),
      })

      if (!response.ok) {
        throw new Error("Search failed")
      }

      const data = await response.json()

      // Add assistant message with results
      const assistantMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: `Gotcha. From the ${folderStats?.totalImages || data.totalCandidates} photos in the folder, below are a few photos that match your prompt. What do you think?`,
        images: data.results,
        totalCandidates: data.totalCandidates,
        timestamp: new Date(),
      }
      setChatMessages((prev) => [...prev, assistantMessage])
      setAppState("chatting")
    } catch (error) {
      console.error("Search error:", error)
      const errorMessage: ChatMessage = {
        id: `msg-${Date.now()}`,
        role: "assistant",
        content: "Sorry, something went wrong with that search. Please try again.",
        timestamp: new Date(),
      }
      setChatMessages((prev) => [...prev, errorMessage])
      setAppState("chatting")
    }
  }

  const handleChangeFolder = () => {
    setAppState("idle")
    setFolderId("")
    setFolderStats(null)
    setChatMessages([])
  }

  return (
    <div className="min-h-screen flex flex-col bg-background">
      {/* Idle/Loading/Ready States */}
      {(appState === "idle" || appState === "loading" || appState === "ready") && (
        <div className="flex-1 flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-500">
          <div className="w-full">
            {appState === "loading" && folderStats && (
              <div className="text-center mb-8 space-y-4">
                <div className="flex items-center justify-center gap-3 mb-4">
                  <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  <div className="text-sm text-muted-foreground font-medium">
                    Processing your folder... Search will be available when done.
                  </div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {folderStats.processedImages} / {folderStats.totalImages} images processed
                </div>
              </div>
            )}
            <LinkInput 
              onFolderReady={handleFolderReady}
              onSearch={handleSearch}
              step1Complete={appState !== "idle"}
              canSearch={appState === "ready"}
            />
          </div>
        </div>
      )}

      {/* Chatting State */}
      {(appState === "chatting" || appState === "searching") && (
        <div className="flex flex-col flex-1 animate-in fade-in duration-500">
          <ChatThread messages={chatMessages} />
          <ChatInputBar
            onSendMessage={handleSearch}
            onChangeFolder={handleChangeFolder}
            isLoading={appState === "searching"}
          />
        </div>
      )}
    </div>
  )
}
