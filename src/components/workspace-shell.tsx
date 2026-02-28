import * as React from "react";

import { ActivityRail } from "@/components/activity-rail";
import { ContextPaneHost } from "@/components/context-pane-host";
import { MessageView } from "@/components/message-view";
import { ResizableHandle } from "@/components/ui/resizable";
import type {
  Chat,
  DateRange,
  PerChatTimelineUiState,
  SearchResult,
  SidebarMode,
  WorkspaceLayoutState,
} from "@/lib/types";

interface WorkspaceShellProps {
  chats: Chat[];
  selectedChatId: number | null;
  selectedChat: Chat | null;
  onSelectChat: (chatId: number) => void;
  activeMode: SidebarMode;
  onModeChange: (mode: SidebarMode) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  scopeAll: boolean;
  onScopeAllChange: (value: boolean) => void;
  onSearchResultsChange: (results: SearchResult[]) => void;
  searchMatchRowids?: Set<number>;
  onActiveResultChange: (rowid: number | null) => void;
  requestedJumpRowid: number | null;
  onJumpHandled: (rowid: number) => void;
  onJumpToRowid: (rowid: number) => void;
  onHighlightChange: (rowid: number | null) => void;
  initialTimelineUiState?: PerChatTimelineUiState;
  onTimelineUiStateChange: (state: PerChatTimelineUiState) => void;
}

const RAIL_WIDTH = 56;
const HANDLE_WIDTH_APPROX = 8;
const CONTEXT_MIN = 260;
const CONTEXT_DEFAULT = 320;
const DETAIL_MIN_WIDTH_PX = 280;
const MAX_CONTEXT_RATIO = 0.75;
const TIMELINE_MODE_MIN_WIDTH = 360;
const TIMELINE_MODE_DEFAULT_WIDTH = 460;
const LAYOUT_STORAGE_KEY = "workspace_layout_v1";

export function WorkspaceShell({
  chats,
  selectedChatId,
  selectedChat,
  onSelectChat,
  activeMode,
  onModeChange,
  searchQuery,
  onSearchQueryChange,
  dateRange,
  onDateRangeChange,
  scopeAll,
  onScopeAllChange,
  onSearchResultsChange,
  searchMatchRowids,
  onActiveResultChange,
  requestedJumpRowid,
  onJumpHandled,
  onJumpToRowid,
  onHighlightChange,
  initialTimelineUiState,
  onTimelineUiStateChange,
}: WorkspaceShellProps) {
  const [contextPaneWidth, setContextPaneWidth] = React.useState<number>(CONTEXT_DEFAULT);
  const rootRef = React.useRef<HTMLDivElement | null>(null);
  const [rootWidth, setRootWidth] = React.useState<number>(0);

  const maxContextWidth = React.useMemo(
    () => getMaxContextWidth(rootWidth),
    [rootWidth],
  );

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as WorkspaceLayoutState;
      if (typeof parsed.contextPaneWidth === "number") {
        setContextPaneWidth(parsed.contextPaneWidth);
      }
    } catch {
      // ignore malformed storage
    }
  }, []);

  React.useEffect(() => {
    const next: WorkspaceLayoutState = { contextPaneWidth };
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(next));
  }, [contextPaneWidth]);

  React.useEffect(() => {
    const target = rootRef.current;
    if (!target) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      setRootWidth(entry.contentRect.width);
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    setContextPaneWidth((prev) => clamp(prev, CONTEXT_MIN, maxContextWidth));
  }, [maxContextWidth]);

  React.useEffect(() => {
    if (activeMode !== "timeline") {
      return;
    }
    const maxWidth = getMaxContextWidth(rootWidth);
    setContextPaneWidth((prev) =>
      prev < TIMELINE_MODE_MIN_WIDTH
        ? clamp(TIMELINE_MODE_DEFAULT_WIDTH, CONTEXT_MIN, maxWidth)
        : prev,
    );
  }, [activeMode, rootWidth]);

  const startResize = React.useCallback((evt: React.MouseEvent<HTMLDivElement>) => {
    evt.preventDefault();
    const rootRect = rootRef.current?.getBoundingClientRect();
    if (!rootRect) return;
    const maxWidth = getMaxContextWidth(rootRect.width);

    const onMove = (moveEvt: MouseEvent) => {
      const nextWidth = clamp(moveEvt.clientX - rootRect.left - RAIL_WIDTH, CONTEXT_MIN, maxWidth);
      setContextPaneWidth(nextWidth);
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  return (
    <div ref={rootRef} className="h-screen flex overflow-hidden">
      <div className="h-full shrink-0" style={{ width: RAIL_WIDTH }}>
        <ActivityRail activeMode={activeMode} onModeChange={onModeChange} />
      </div>

      <div
        className="h-full shrink-0 border-r border-border"
        style={{ width: clamp(contextPaneWidth, CONTEXT_MIN, maxContextWidth) }}
      >
        <ContextPaneHost
          mode={activeMode}
          chats={chats}
          selectedChatId={selectedChatId}
          selectedChat={selectedChat}
          onSelectChat={onSelectChat}
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
          dateRange={dateRange}
          onDateRangeChange={onDateRangeChange}
          scopeAll={scopeAll}
          onScopeAllChange={onScopeAllChange}
          onJumpToRowid={onJumpToRowid}
          onSearchResultsChange={onSearchResultsChange}
          onActiveResultChange={onActiveResultChange}
          initialTimelineUiState={initialTimelineUiState}
          onTimelineUiStateChange={onTimelineUiStateChange}
        />
      </div>

      <ResizableHandle
        withHandle
        onMouseDown={startResize}
        className="cursor-col-resize hover:bg-border/80 transition-colors"
      />

      <div className="min-w-0 flex-1">
        <MessageView
          chat={selectedChat}
          dateRange={dateRange}
          searchQuery={activeMode === "search" ? searchQuery : undefined}
          searchMatchRowids={activeMode === "search" ? searchMatchRowids : undefined}
          requestedJumpRowid={requestedJumpRowid}
          onJumpHandled={onJumpHandled}
          onHighlightChange={onHighlightChange}
        />
      </div>
    </div>
  );
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getMaxContextWidth(rootWidth: number): number {
  if (rootWidth <= 0) {
    return 520;
  }

  const availableWidth = rootWidth - RAIL_WIDTH - HANDLE_WIDTH_APPROX;
  const ratioBound = availableWidth * MAX_CONTEXT_RATIO;
  const detailBound = availableWidth - DETAIL_MIN_WIDTH_PX;
  const maxWidth = Math.min(ratioBound, detailBound);
  return Math.max(CONTEXT_MIN, maxWidth);
}
