"use client"

import { cn } from "@/lib/utils"
import type { Moment } from "@/lib/timeline-data"

interface MomentItemProps {
  moment: Moment
  isLast: boolean
}

export function MomentItem({ moment }: MomentItemProps) {
  return (
    <div
      className={cn(
        "relative pl-4 py-2",
        "group/moment",
        "transition-all duration-150",
        "hover:bg-secondary/20 rounded-r-md"
      )}
    >
      {/* Connector dot */}
      <div
        className={cn(
          "absolute left-[-5px] top-1/2 -translate-y-1/2",
          "w-2 h-2 rounded-full",
          "bg-border",
          "group-hover/moment:bg-primary transition-colors"
        )}
      />

      <div
        className={cn(
          "flex flex-col gap-1",
          moment.sender === "me" ? "items-end" : "items-start"
        )}
      >
        <div
          className={cn(
            "max-w-[85%] rounded-xl px-3 py-2",
            moment.sender === "me"
              ? "bg-primary/15 text-foreground"
              : "bg-secondary/60 text-foreground"
          )}
        >
          <p className="text-sm leading-relaxed">{moment.content}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            {moment.timestamp}
          </span>
          {moment.sentiment && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded",
                moment.sentiment === "positive" &&
                  "bg-green-500/10 text-green-400",
                moment.sentiment === "negative" &&
                  "bg-red-500/10 text-red-400",
                moment.sentiment === "neutral" &&
                  "bg-muted text-muted-foreground"
              )}
            >
              {moment.sentiment}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
