"use client"

import { Moment } from "@/lib/timeline-data"
import { cn } from "@/lib/utils"
import { format } from "date-fns"

interface MessagePaneProps {
  moments: Moment[]
  topicTitle: string
  subtopicTitle?: string
}

export function MessagePane({ moments, topicTitle, subtopicTitle }: MessagePaneProps) {
  if (moments.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <div className="text-lg">Select a moment to view messages</div>
        <div className="text-sm">Click on any item in the outline</div>
      </div>
    )
  }

  // Group messages by date
  const groupedByDate = moments.reduce((acc, moment) => {
    const dateKey = format(moment.timestamp, "EEEE, MMMM d")
    if (!acc[dateKey]) acc[dateKey] = []
    acc[dateKey].push(moment)
    return acc
  }, {} as Record<string, Moment[]>)

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border bg-card/50 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20">
            <span className="text-xs font-medium text-primary">
              {topicTitle.charAt(0)}
            </span>
          </div>
          <div>
            <div className="text-sm font-medium text-foreground">{topicTitle}</div>
            {subtopicTitle && (
              <div className="text-xs text-muted-foreground">{subtopicTitle}</div>
            )}
          </div>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-2xl space-y-6">
          {Object.entries(groupedByDate).map(([date, msgs]) => (
            <div key={date} className="space-y-3">
              {/* Date separator */}
              <div className="flex justify-center">
                <span className="rounded-full bg-secondary px-3 py-1 text-xs text-muted-foreground">
                  {date}
                </span>
              </div>

              {/* Messages for this date */}
              <div className="space-y-1">
                {msgs.map((moment, idx) => {
                  const isMe = moment.sender === "You"
                  const showSender = idx === 0 || msgs[idx - 1].sender !== moment.sender

                  return (
                    <div key={moment.id} className={cn("flex flex-col", isMe ? "items-end" : "items-start")}>
                      {showSender && !isMe && (
                        <span className="mb-1 ml-3 text-xs text-muted-foreground">
                          {moment.sender}
                        </span>
                      )}
                      <div
                        className={cn(
                          "max-w-[80%] rounded-2xl px-4 py-2",
                          isMe
                            ? "rounded-br-md bg-primary text-primary-foreground"
                            : "rounded-bl-md bg-secondary text-secondary-foreground"
                        )}
                      >
                        <p className="text-sm leading-relaxed">{moment.message}</p>
                      </div>
                      <span className="mt-0.5 px-3 text-[10px] text-muted-foreground">
                        {format(moment.timestamp, "h:mm a")}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Input area (decorative) */}
      <div className="flex-shrink-0 border-t border-border bg-card/30 p-3">
        <div className="flex items-center gap-2">
          <div className="flex-1 rounded-full bg-secondary/50 px-4 py-2">
            <span className="text-sm text-muted-foreground">iMessage</span>
          </div>
        </div>
      </div>
    </div>
  )
}
