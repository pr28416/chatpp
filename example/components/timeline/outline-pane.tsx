"use client"

import { Topic, Subtopic, Moment } from "@/lib/timeline-data"
import { cn } from "@/lib/utils"
import { ChevronRight, MessageCircle, Clock, Hash } from "lucide-react"
import { format } from "date-fns"
import { useState } from "react"

interface OutlinePaneProps {
  topic: Topic
  selectedMoments: Moment[]
  selectedSubtopicId: string | null
  onSelectSubtopic: (subtopic: Subtopic) => void
  onSelectMoment: (moment: Moment, subtopic: Subtopic) => void
}

export function OutlinePane({
  topic,
  selectedMoments,
  selectedSubtopicId,
  onSelectSubtopic,
  onSelectMoment,
}: OutlinePaneProps) {
  const [expandedSubtopics, setExpandedSubtopics] = useState<Set<string>>(
    new Set(topic.subtopics.map((s) => s.id))
  )

  const toggleSubtopic = (id: string) => {
    setExpandedSubtopics((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const selectedMomentIds = new Set(selectedMoments.map((m) => m.id))

  return (
    <div className="flex h-full flex-col">
      {/* Topic Header */}
      <div className="flex-shrink-0 border-b border-border p-4">
        <div className="mb-3 flex items-center gap-2">
          <div
            className="h-3 w-3 rounded-full"
            style={{ backgroundColor: topic.color }}
          />
          <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Topic
          </span>
        </div>
        <h1 className="mb-2 text-xl font-semibold text-foreground">{topic.title}</h1>
        <p className="mb-4 text-sm leading-relaxed text-muted-foreground">
          {topic.description}
        </p>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5" />
            <span>{format(topic.startDate, "MMM d")} - {format(topic.endDate, "MMM d, yyyy")}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Hash className="h-3.5 w-3.5" />
            <span>{topic.subtopics.length} subtopics</span>
          </div>
          <div className="flex items-center gap-1.5">
            <MessageCircle className="h-3.5 w-3.5" />
            <span>{topic.subtopics.reduce((acc, s) => acc + s.moments.length, 0)} messages</span>
          </div>
        </div>
      </div>

      {/* Outline */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-2">
          <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Outline
          </div>
          <div className="space-y-0.5">
            {topic.subtopics.map((subtopic) => {
              const isExpanded = expandedSubtopics.has(subtopic.id)
              const isSelected = selectedSubtopicId === subtopic.id

              return (
                <div key={subtopic.id}>
                  {/* Subtopic row */}
                  <button
                    onClick={() => {
                      toggleSubtopic(subtopic.id)
                      onSelectSubtopic(subtopic)
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors",
                      isSelected
                        ? "bg-primary/10 text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground"
                    )}
                  >
                    <ChevronRight
                      className={cn(
                        "h-3.5 w-3.5 flex-shrink-0 transition-transform",
                        isExpanded && "rotate-90"
                      )}
                    />
                    <span className="flex-1 truncate text-sm">{subtopic.title}</span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground">
                      {subtopic.moments.length}
                    </span>
                  </button>

                  {/* Moments */}
                  {isExpanded && (
                    <div className="ml-4 border-l border-border pl-2">
                      {subtopic.moments.map((moment) => {
                        const isMomentSelected = selectedMomentIds.has(moment.id)

                        return (
                          <button
                            key={moment.id}
                            onClick={() => onSelectMoment(moment, subtopic)}
                            className={cn(
                              "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
                              isMomentSelected
                                ? "bg-primary/10 text-foreground"
                                : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground"
                            )}
                          >
                            <div
                              className={cn(
                                "h-1.5 w-1.5 flex-shrink-0 rounded-full",
                                moment.sentiment === "positive" && "bg-green-500",
                                moment.sentiment === "negative" && "bg-red-500",
                                moment.sentiment === "neutral" && "bg-muted-foreground"
                              )}
                            />
                            <span className="flex-1 truncate text-xs">
                              {moment.message.slice(0, 40)}
                              {moment.message.length > 40 && "..."}
                            </span>
                            <span className="flex-shrink-0 text-[10px] text-muted-foreground">
                              {format(moment.timestamp, "h:mm a")}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
