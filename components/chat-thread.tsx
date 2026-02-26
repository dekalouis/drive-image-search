"use client"

import { useEffect, useRef } from "react"
import { ChatMessage } from "@/components/chat-message"

interface SearchResult {
  id: string
  fileId: string
  name: string
  thumbnailLink: string
  webViewLink: string
  caption?: string
  similarity?: number
}

interface Message {
  id: string
  role: "user" | "assistant"
  content: string
  images?: SearchResult[]
  totalCandidates?: number
  timestamp: Date
}

interface ChatThreadProps {
  messages: Message[]
}

export function ChatThread({ messages }: ChatThreadProps) {
  const scrollEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  if (messages.length === 0) {
    return null
  }

  return (
    <div className="flex-1 overflow-y-auto pb-4 px-4 sm:px-6">
      <div className="max-w-3xl mx-auto space-y-6 pt-6">
        {messages.map((message) => (
          <ChatMessage
            key={message.id}
            role={message.role}
            content={message.content}
            images={message.images}
            totalCandidates={message.totalCandidates}
          />
        ))}
        <div ref={scrollEndRef} />
      </div>
    </div>
  )
}
