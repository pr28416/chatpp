"use client"

import { Topic } from "@/lib/timeline-data"
import { cn } from "@/lib/utils"
import { MessageSquare, Search } from "lucide-react"
import { useState } from "react"

interface TopicSidebarProps {
  topics: Topic[]
  selectedTopicId: string | null
  onSelectTopic: (topic: Topic) => void
}

export function TopicSidebar({ topics, selectedTopicId, onSelectTopic }: TopicSidebarProps) {
  const [search, setSearch] = useState("")

  const filteredTopics = topics.filter((topic) =>
    topic.title.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="flex h-full flex-col border-r border-border bg-sidebar">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <span className="font-semibold text-foreground">Timeline</span>
        </div>
      </div>

      {/* Search */}
      <div className="flex-shrink-0 p-2">
        <div className="flex items-center gap-2 rounded-md bg-secondary/50 px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search topics..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          />
          <kbd className="hidden rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground sm:inline">
            /
          </kbd>
        </div>
      </div>

      {/* Topic List */}
      <div className="flex-1 overflow-y-auto p-2">
        <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          Topics
        </div>
        <div className="space-y-0.5">
          {filteredTopics.map((topic) => {
            const isSelected = selectedTopicId === topic.id
            const messageCount = topic.subtopics.reduce(
              (acc, s) => acc + s.moments.length,
              0
            )

            return (
              <button
                key={topic.id}
                onClick={() => onSelectTopic(topic)}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                  isSelected
                    ? "bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                )}
              >
                <div
                  className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                  style={{ backgroundColor: topic.color }}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{topic.title}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {topic.subtopics.length} subtopics · {messageCount} messages
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-border p-3">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <div className="h-2 w-2 rounded-full bg-green-500" />
          <span>AI Analysis Active</span>
        </div>
      </div>
    </div>
  )
}
