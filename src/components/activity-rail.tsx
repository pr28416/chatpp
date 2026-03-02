import * as React from "react";
import { ListTree, MessageSquare, Search } from "lucide-react";
import { startWindowDrag as startWindowDragCommand } from "@/lib/commands";

import type { SidebarMode } from "@/lib/types";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

interface ActivityRailProps {
  activeMode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
}

type ModeMeta = {
  mode: SidebarMode;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

const MODES: ModeMeta[] = [
  { mode: "chats", label: "Chats", icon: MessageSquare },
  { mode: "search", label: "Search", icon: Search },
  { mode: "timeline", label: "Timeline", icon: ListTree },
];

export function ActivityRail({ activeMode, onModeChange }: ActivityRailProps) {
  const startWindowDrag = React.useCallback((evt: React.MouseEvent<HTMLDivElement>) => {
    if (evt.button !== 0) {
      return;
    }
    evt.preventDefault();
    startWindowDragCommand().catch(() => {
      // no-op: non-draggable environments should fail silently
    });
  }, []);

  return (
    <TooltipProvider delayDuration={120}>
      <div className="h-full w-full border-r border-border bg-sidebar/50 flex flex-col items-center">
        <div
          className="h-12 w-full shrink-0"
          data-tauri-drag-region
          onMouseDown={startWindowDrag}
          aria-hidden="true"
        />
        <div className="flex w-full flex-col items-center gap-1.5 py-2">
        {MODES.map((item) => {
          const Icon = item.icon;
          const active = item.mode === activeMode;
          return (
            <Tooltip key={item.mode}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => onModeChange(item.mode)}
                  data-tauri-drag-region="false"
                  className={`relative h-10 w-10 rounded-md grid place-items-center transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-muted-foreground hover:bg-sidebar-accent/70 hover:text-sidebar-foreground"
                  }`}
                  aria-label={item.label}
                >
                  {active && <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r bg-primary" />}
                  <Icon className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          );
        })}
        </div>
      </div>
    </TooltipProvider>
  );
}
