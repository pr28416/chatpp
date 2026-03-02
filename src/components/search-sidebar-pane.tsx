import * as React from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";

import type { DateRange, SearchResult } from "@/lib/types";
import { DateRangeFilter } from "@/components/date-range-filter";
import { MessageSearch, type MessageSearchHandle } from "@/components/message-search";
import { PaneNavHeader } from "@/components/pane-nav-header";

interface SearchSidebarPaneProps {
  chatId: number | null;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  scopeAll: boolean;
  onScopeAllChange: (value: boolean) => void;
  onJumpToRowid: (rowid: number) => void;
  onSearchResultsChange: (results: SearchResult[]) => void;
  onActiveResultChange: (rowid: number | null) => void;
}

export function SearchSidebarPane({
  chatId,
  dateRange,
  onDateRangeChange,
  searchQuery,
  onSearchQueryChange,
  scopeAll,
  onScopeAllChange,
  onJumpToRowid,
  onSearchResultsChange,
  onActiveResultChange,
}: SearchSidebarPaneProps) {
  const [isHeaderCollapsed, setIsHeaderCollapsed] = React.useState(false);
  const [searchStatus, setSearchStatus] = React.useState({
    loading: false,
    total: 0,
    activeIndex: -1,
  });
  const inputRef = React.useRef<HTMLInputElement>(null);
  const searchRef = React.useRef<MessageSearchHandle | null>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, [chatId]);

  if (!chatId) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a conversation to search messages.
      </div>
    );
  }

  const hasDateScope = Boolean(dateRange.start || dateRange.end);

  return (
    <div className="h-full flex flex-col bg-transparent">
      <PaneNavHeader
        title="Search"
        collapsed={isHeaderCollapsed}
        accessory={(
          <div className="space-y-2">
            <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Search messages..."
                value={searchQuery}
                onChange={(evt) => onSearchQueryChange(evt.target.value)}
                onKeyDown={(evt) => {
                  if (evt.key === "ArrowDown" || (evt.key === "Enter" && !evt.shiftKey)) {
                    evt.preventDefault();
                    searchRef.current?.navigateResult("next");
                  } else if (evt.key === "ArrowUp" || (evt.key === "Enter" && evt.shiftKey)) {
                    evt.preventDefault();
                    searchRef.current?.navigateResult("prev");
                  } else if (evt.key === "Escape") {
                    onSearchQueryChange("");
                  }
                }}
                className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-w-0"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchQueryChange("")}
                  aria-label="Clear search"
                  className="p-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center justify-between gap-2">
              <DateRangeFilter dateRange={dateRange} onDateRangeChange={onDateRangeChange} />
              <div className="flex items-center gap-0.5">
                <button
                  type="button"
                  onClick={() => searchRef.current?.navigateResult("prev")}
                  disabled={searchStatus.total === 0}
                  className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
                  aria-label="Previous match"
                >
                  <ChevronUp className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => searchRef.current?.navigateResult("next")}
                  disabled={searchStatus.total === 0}
                  className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
                  aria-label="Next match"
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              {hasDateScope ? (
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onScopeAllChange(false)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                      !scopeAll
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-transparent text-muted-foreground border-border hover:border-foreground/30"
                    }`}
                  >
                    Current range
                  </button>
                  <button
                    type="button"
                    onClick={() => onScopeAllChange(true)}
                    className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                      scopeAll
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-transparent text-muted-foreground border-border hover:border-foreground/30"
                    }`}
                  >
                    All time
                  </button>
                </div>
              ) : <span />}
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {!searchQuery.trim()
                  ? "Type to search"
                  : searchStatus.loading
                    ? "Searching..."
                    : searchStatus.total > 0
                      ? `${searchStatus.activeIndex + 1} of ${searchStatus.total} matches`
                      : "No matches"}
              </span>
            </div>
          </div>
        )}
      />

      <div className="flex-1 min-h-0 overflow-hidden">
        <MessageSearch
          ref={searchRef}
          chatId={chatId}
          dateRange={dateRange}
          onJumpToResult={(result) => onJumpToRowid(result.rowid)}
          onSearchResults={onSearchResultsChange}
          onActiveResultChange={(result) => onActiveResultChange(result?.rowid ?? null)}
          searchQuery={searchQuery}
          scopeAll={scopeAll}
          onStatusChange={setSearchStatus}
          onResultsScrollTopChange={(scrollTop) => {
            const collapsed = scrollTop > 12;
            setIsHeaderCollapsed((prev) => (prev === collapsed ? prev : collapsed));
          }}
        />
      </div>
    </div>
  );
}
