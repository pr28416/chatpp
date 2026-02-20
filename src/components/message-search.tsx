import * as React from "react";
import { Search, X, ChevronUp, ChevronDown } from "lucide-react";
import { SearchResult, DateRange } from "@/lib/types";
import { searchMessages } from "@/lib/commands";
import { format, parseISO } from "date-fns";

interface MessageSearchProps {
  chatId: number;
  dateRange: DateRange;
  onJumpToResult: (result: SearchResult) => void;
  onSearchResults: (results: SearchResult[]) => void;
  onClose: () => void;
  onActiveResultChange: (result: SearchResult | null) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

export function MessageSearch({
  chatId,
  dateRange,
  onJumpToResult,
  onSearchResults,
  onClose,
  onActiveResultChange,
  searchQuery,
  onSearchQueryChange,
}: MessageSearchProps) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [loading, setLoading] = React.useState(false);
  const [scopeAll, setScopeAll] = React.useState(
    !dateRange.start && !dateRange.end,
  );
  const resultsRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!searchQuery.trim()) {
      setResults([]);
      setActiveIndex(-1);
      onSearchResults([]);
      onActiveResultChange(null);
      return;
    }

    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const params: { q: string; start?: string; end?: string } = {
          q: searchQuery,
        };
        if (!scopeAll && dateRange.start) params.start = dateRange.start;
        if (!scopeAll && dateRange.end) params.end = dateRange.end;

        const data = await searchMessages(chatId, params);
        setResults(data.results);
        onSearchResults(data.results);
        if (data.results.length > 0) {
          setActiveIndex(0);
          onActiveResultChange(data.results[0]);
        } else {
          setActiveIndex(-1);
          onActiveResultChange(null);
        }
      } catch (err) {
        console.error("Search failed:", err);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, chatId, scopeAll, dateRange.start, dateRange.end]);

  const navigateResult = React.useCallback(
    (direction: "next" | "prev") => {
      if (results.length === 0) return;
      let next: number;
      if (direction === "next") {
        next = activeIndex < results.length - 1 ? activeIndex + 1 : 0;
      } else {
        next = activeIndex > 0 ? activeIndex - 1 : results.length - 1;
      }
      setActiveIndex(next);
      onActiveResultChange(results[next]);
      onJumpToResult(results[next]);
    },
    [results, activeIndex, onJumpToResult, onActiveResultChange],
  );

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        navigateResult("next");
      } else if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        navigateResult("prev");
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        navigateResult("next");
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        navigateResult("prev");
      }
    },
    [onClose, navigateResult],
  );

  React.useEffect(() => {
    if (activeIndex < 0 || !resultsRef.current) return;
    const activeEl = resultsRef.current.children[activeIndex] as HTMLElement;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const hasDateScope = dateRange.start || dateRange.end;

  return (
    <div className="w-72 shrink-0 border-l border-border bg-card/50 flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
        <span className="text-xs font-semibold text-foreground">Search</span>
        <button
          type="button"
          onClick={onClose}
          className="p-0.5 rounded hover:bg-muted transition-colors"
          aria-label="Close search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2 rounded-md border border-input bg-background px-2.5 py-1.5">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search messages..."
            value={searchQuery}
            onChange={(e) => onSearchQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none min-w-0"
          />
        </div>

        {searchQuery.trim() && (
          <div className="flex items-center justify-between mt-2">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {loading
                ? "Searching..."
                : results.length > 0
                  ? `${activeIndex + 1} of ${results.length} matches`
                  : "No matches"}
            </span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => navigateResult("prev")}
                disabled={results.length === 0}
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
                aria-label="Previous match"
              >
                <ChevronUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => navigateResult("next")}
                disabled={results.length === 0}
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 transition-colors"
                aria-label="Next match"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        )}

        {hasDateScope && (
          <div className="flex items-center gap-1.5 mt-2">
            <button
              type="button"
              onClick={() => setScopeAll(false)}
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
              onClick={() => setScopeAll(true)}
              className={`text-[11px] px-2 py-0.5 rounded-full border transition-colors ${
                scopeAll
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-transparent text-muted-foreground border-border hover:border-foreground/30"
              }`}
            >
              All time
            </button>
          </div>
        )}
      </div>

      <div ref={resultsRef} className="flex-1 overflow-y-auto">
        {results.length === 0 && searchQuery.trim() && !loading && (
          <div className="flex items-center justify-center py-8 px-4">
            <p className="text-xs text-muted-foreground text-center">
              No messages matching &ldquo;{searchQuery}&rdquo;
            </p>
          </div>
        )}
        {results.map((result, i) => (
          <button
            key={result.rowid}
            type="button"
            onClick={() => {
              setActiveIndex(i);
              onActiveResultChange(result);
              onJumpToResult(result);
            }}
            className={`w-full text-left px-3 py-2.5 border-b border-border/50 transition-colors ${
              i === activeIndex ? "bg-accent" : "hover:bg-muted/50"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-foreground truncate">
                {result.is_from_me ? "You" : result.sender || "Unknown"}
              </span>
              <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                {formatResultDate(result.date)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5 leading-relaxed">
              <HighlightedSnippet
                text={result.text || ""}
                query={searchQuery}
              />
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}

function formatResultDate(dateStr: string): string {
  try {
    return format(parseISO(dateStr), "MMM d, yyyy");
  } catch {
    return dateStr;
  }
}

function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query.trim()) return <>{text}</>;

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            className="bg-yellow-300/70 dark:bg-yellow-500/40 text-inherit rounded-sm px-0.5"
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}
