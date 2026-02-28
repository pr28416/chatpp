"use client"

import { useState } from "react"
import { ChevronRight, MessageSquare, Layers } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Topic } from "@/lib/timeline-data"
import { SubtopicCard } from "./subtopic-card"

interface TopicCardProps {
  topic: Topic
  isExpanded: boolean
  onToggle: () => void
}

export function TopicCard({ topic, isExpanded, onToggle }: TopicCardProps) {
  const [expandedSubtopic, setExpandedSubtopic] = useState<string | null>(null)

  return (
    <div className="group">
      {/* Topic Header */}
      <button
        onClick={onToggle}
        className={cn(
          "w-full text-left",
          "border-b border-border/50",
          "py-5 px-1",
          "transition-all duration-300 ease-out",
          "hover:bg-secondary/30"
        )}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 mb-2">
              <div
                className={cn(
                  "w-2 h-2 rounded-full shrink-0",
                  topic.color === "primary" && "bg-primary",
                  topic.color === "accent" && "bg-accent",
                  topic.color === "chart-3" && "bg-chart-3",
                  topic.color === "chart-4" && "bg-chart-4"
                )}
              />
              <span className="text-xs text-muted-foreground tracking-wider uppercase">
                {topic.date}
              </span>
            </div>
            <h3 className="text-xl font-medium text-foreground mb-1 group-hover:text-primary transition-colors">
              {topic.title}
            </h3>
            <p className="text-sm text-muted-foreground line-clamp-1">
              {topic.description}
            </p>
          </div>

          <div className="flex items-center gap-6 shrink-0">
            <div className="flex items-center gap-4 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" />
                {topic.subtopicCount}
              </span>
              <span className="flex items-center gap-1.5">
                <MessageSquare className="w-3.5 h-3.5" />
                {topic.messageCount}
              </span>
            </div>
            <ChevronRight
              className={cn(
                "w-5 h-5 text-muted-foreground transition-transform duration-300",
                isExpanded && "rotate-90"
              )}
            />
          </div>
        </div>
      </button>

      {/* Subtopics */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-500 ease-out",
          isExpanded ? "max-h-[2000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="pl-5 border-l border-border/30 ml-1 mt-2 mb-4 space-y-1">
          {topic.subtopics.map((subtopic) => (
            <SubtopicCard
              key={subtopic.id}
              subtopic={subtopic}
              isExpanded={expandedSubtopic === subtopic.id}
              onToggle={() =>
                setExpandedSubtopic(
                  expandedSubtopic === subtopic.id ? null : subtopic.id
                )
              }
              topicColor={topic.color}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
