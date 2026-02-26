"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Loader2, Send, RotateCcw, Settings } from "lucide-react"

interface ChatInputBarProps {
  onSendMessage: (message: string) => Promise<void>
  onChangeFolder: () => void
  isLoading?: boolean
}

export function ChatInputBar({ onSendMessage, onChangeFolder, isLoading = false }: ChatInputBarProps) {
  const [input, setInput] = useState("")
  const [sending, setSending] = useState(false)

  const handleSend = async () => {
    if (!input.trim() || sending || isLoading) return

    setSending(true)
    try {
      await onSendMessage(input.trim())
      setInput("")
    } catch (error) {
      console.error("Error sending message:", error)
    } finally {
      setSending(false)
    }
  }

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="sticky bottom-0 w-full bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-t">
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4">
        <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-3">
          <Input
            placeholder="Fine tune or ask for another prompt here"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            disabled={sending || isLoading}
            className="text-sm flex-1 bg-white dark:bg-gray-900"
          />
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <Button
              onClick={handleSend}
              disabled={!input.trim() || sending || isLoading}
              size="sm"
              className="gap-2 flex-1 sm:flex-none bg-green-600 hover:bg-green-700 text-white dark:bg-green-700 dark:hover:bg-green-800"
            >
              {sending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Send className="w-4 h-4" />
              )}
              <span className="inline sm:hidden">Send</span>
              <span className="hidden sm:inline">Enter</span>
            </Button>
            <Button
              onClick={onChangeFolder}
              variant="outline"
              size="sm"
              className="gap-2 flex-1 sm:flex-none"
            >
              <RotateCcw className="w-4 h-4" />
              <span className="inline sm:hidden">Folder</span>
              <span className="hidden sm:inline">Change folder</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled
              className="p-2 text-muted-foreground"
              title="Settings (coming soon)"
            >
              <Settings className="w-4 h-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
