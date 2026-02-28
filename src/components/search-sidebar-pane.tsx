import * as React from "react";

import type { DateRange, SearchResult } from "@/lib/types";
import { DateRangeFilter } from "@/components/date-range-filter";
import { MessageSearch } from "@/components/message-search";

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
  if (!chatId) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a conversation to search messages.
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-transparent">
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-foreground">Search</h3>
      </div>
      <div className="px-3 py-2 border-b border-border">
        <DateRangeFilter dateRange={dateRange} onDateRangeChange={onDateRangeChange} />
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <MessageSearch
          chatId={chatId}
          dateRange={dateRange}
          onJumpToResult={(result) => onJumpToRowid(result.rowid)}
          onSearchResults={onSearchResultsChange}
          onClose={() => undefined}
          onActiveResultChange={(result) => onActiveResultChange(result?.rowid ?? null)}
          searchQuery={searchQuery}
          onSearchQueryChange={onSearchQueryChange}
          scopeAll={scopeAll}
          onScopeAllChange={onScopeAllChange}
          showHeader={false}
        />
      </div>
    </div>
  );
}
