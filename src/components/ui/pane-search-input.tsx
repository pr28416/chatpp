import * as React from "react";
import { Search, X } from "lucide-react";

import { cn } from "@/lib/utils";

interface PaneSearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  onClear?: () => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  className?: string;
  inDragRegion?: boolean;
}

export function PaneSearchInput({
  value,
  onChange,
  placeholder,
  onKeyDown,
  onClear,
  inputRef,
  className,
  inDragRegion = false,
}: PaneSearchInputProps) {
  const clear = React.useCallback(() => {
    if (onClear) {
      onClear();
      return;
    }
    onChange("");
  }, [onChange, onClear]);

  const stopDragRegionMouseDown = React.useCallback((evt: React.MouseEvent<HTMLElement>) => {
    if (inDragRegion) {
      evt.stopPropagation();
    }
  }, [inDragRegion]);

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-full border border-border bg-background px-3 py-2",
        className,
      )}
    >
      <Search className="h-4 w-4 text-muted-foreground shrink-0" />
      <input
        ref={inputRef}
        type="text"
        placeholder={placeholder}
        value={value}
        data-tauri-drag-region={inDragRegion ? "false" : undefined}
        onMouseDown={stopDragRegionMouseDown}
        onChange={(evt) => onChange(evt.target.value)}
        onKeyDown={(evt) => {
          if (evt.key === "Escape") {
            clear();
          }
          onKeyDown?.(evt);
        }}
        className="flex-1 min-w-0 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
      />
      {value && (
        <button
          type="button"
          data-tauri-drag-region={inDragRegion ? "false" : undefined}
          onMouseDown={stopDragRegionMouseDown}
          onClick={clear}
          aria-label="Clear search"
          className="p-0.5 rounded-full hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
