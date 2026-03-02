import * as React from "react";

import { startWindowDrag as startWindowDragCommand } from "@/lib/commands";
import { cn } from "@/lib/utils";

interface PaneNavHeaderProps {
  title: string;
  collapsed: boolean;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  accessory?: React.ReactNode;
  className?: string;
}

export function PaneNavHeader({
  title,
  collapsed,
  leading,
  trailing,
  accessory,
  className,
}: PaneNavHeaderProps) {
  const startWindowDrag = React.useCallback((evt: React.MouseEvent<HTMLDivElement>) => {
    if (evt.button !== 0) {
      return;
    }
    if (isInteractiveTarget(evt.target)) {
      return;
    }
    evt.preventDefault();
    startWindowDragCommand().catch(() => {
      // no-op: non-draggable environments should fail silently
    });
  }, []);

  return (
    <div
      className={cn("sticky top-0 z-20 border-b border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80", className)}
      data-tauri-drag-region
      onMouseDown={startWindowDrag}
    >
      <div className="px-3 pt-2 pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {leading}
            <span
              className={cn(
                "truncate text-sm font-semibold text-foreground transition-opacity duration-200",
                collapsed ? "opacity-100" : "opacity-0",
              )}
            >
              {title}
            </span>
          </div>
          {trailing ? <div className="shrink-0" data-tauri-drag-region="false">{trailing}</div> : null}
        </div>

        <h2
          className={cn(
            "truncate text-[1.35rem] font-semibold text-foreground transition-all duration-200",
            collapsed ? "max-h-0 translate-y-[-6px] opacity-0" : "mt-1 max-h-10 translate-y-0 opacity-100",
          )}
        >
          {title}
        </h2>

        {accessory ? (
          <div
            className={cn(
              "overflow-hidden transition-all duration-200",
              collapsed ? "mt-0 max-h-0 opacity-0" : "mt-2 max-h-48 opacity-100",
            )}
            data-tauri-drag-region="false"
          >
            {accessory}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest(
      "button, input, textarea, select, option, a, [role='button'], [role='menuitem'], [contenteditable='true'], [data-tauri-drag-region='false']",
    ),
  );
}
