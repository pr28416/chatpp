"use client"

import { ChevronDown, Clock } from "lucide-react"
import { cn } from "@/lib/utils"
import type { Subtopic } from "@/lib/timeline-data"
import { MomentItem } from "./moment-item"

interface SubtopicCardProps {
  subtopic: Subtopic
  isExpanded: boolean
  onToggle: () => void
  topicColor: string
}

export function SubtopicCard({
  subtopic,
  isExpanded,
  onToggle,
  topicColor,
}: SubtopicCardProps) {
  return (
    <div className="group/subtopic">
      <button
        onClick={onToggle}
        className={cn(
          "w-full text-left rounded-lg",
          "py-3 px-4",
          "transition-all duration-200",
          "hover:bg-secondary/50",
          isExpanded && "bg-secondary/30"
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h4 className="text-sm font-medium text-foreground">
                {subtopic.title}
              </h4>
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full",
                  topicColor === "primary" && "bg-primary/20 text-primary",
                  topicColor === "accent" && "bg-accent/20 text-accent",
                  topicColor === "chart-3" && "bg-chart-3/20 text-chart-3",
                  topicColor === "chart-4" && "bg-chart-4/20 text-chart-4"
                )}
              >
                {subtopic.momentCount} moments
              </span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-1">
              {subtopic.summary}
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Clock className="w-3 h-3" />
              {subtopic.timeRange}
            </span>
            <ChevronDown
              className={cn(
                "w-4 h-4 text-muted-foreground transition-transform duration-200",
                isExpanded && "rotate-180"
              )}
            />
          </div>
        </div>
      </button>

      {/* Moments */}
      <div
        className={cn(
          "overflow-hidden transition-all duration-300 ease-out",
          isExpanded ? "max-h-[1000px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="px-4 pb-3 pt-1">
          <div className="space-y-2 pl-3 border-l border-border/20">
            {subtopic.moments.map((moment, index) => (
              <MomentItem
                key={moment.id}
                moment={moment}
                isLast={index === subtopic.moments.length - 1}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
