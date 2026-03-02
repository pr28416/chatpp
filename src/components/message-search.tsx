import * as React from "react";
import { SearchResult, DateRange } from "@/lib/types";
import { searchMessages } from "@/lib/commands";
import { format, parseISO } from "date-fns";

export interface MessageSearchHandle {
  navigateResult: (direction: "next" | "prev") => void;
}

interface MessageSearchProps {
  chatId: number;
  dateRange: DateRange;
  onJumpToResult: (result: SearchResult) => void;
  onSearchResults: (results: SearchResult[]) => void;
  onActiveResultChange: (result: SearchResult | null) => void;
  searchQuery: string;
  scopeAll: boolean;
  onStatusChange?: (status: {
    loading: boolean;
    total: number;
    activeIndex: number;
  }) => void;
  resultsContainerRef?: React.RefObject<HTMLDivElement | null>;
  onResultsScrollTopChange?: (scrollTop: number) => void;
}

export const MessageSearch = React.forwardRef<MessageSearchHandle, MessageSearchProps>(function MessageSearch({
  chatId,
  dateRange,
  onJumpToResult,
  onSearchResults,
  onActiveResultChange,
  searchQuery,
  scopeAll,
  onStatusChange,
  resultsContainerRef,
  onResultsScrollTopChange,
}: MessageSearchProps, ref) {
  const [results, setResults] = React.useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = React.useState(-1);
  const [loading, setLoading] = React.useState(false);
  const resultsRef = React.useRef<HTMLDivElement>(null);

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

  React.useEffect(() => {
    if (activeIndex < 0 || !resultsRef.current) return;
    const activeEl = resultsRef.current.children[activeIndex] as HTMLElement;
    activeEl?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  React.useEffect(() => {
    onStatusChange?.({
      loading,
      total: results.length,
      activeIndex,
    });
  }, [activeIndex, loading, onStatusChange, results.length]);

  React.useImperativeHandle(ref, () => ({
    navigateResult,
  }), [navigateResult]);

  const setResultsContainerRef = React.useCallback(
    (node: HTMLDivElement | null) => {
      resultsRef.current = node;
      if (resultsContainerRef) {
        resultsContainerRef.current = node;
      }
    },
    [resultsContainerRef],
  );

  return (
    <div className="flex flex-col h-full">
      <div
        ref={setResultsContainerRef}
        onScroll={(evt) => onResultsScrollTopChange?.(evt.currentTarget.scrollTop)}
        className="flex-1 overflow-y-auto"
      >
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
              i === activeIndex
                ? "bg-accent"
                : "hover:bg-foreground/10 dark:hover:bg-foreground/15 active:bg-foreground/15"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span
                className={`text-xs font-medium truncate ${
                  i === activeIndex ? "text-accent-foreground" : "text-foreground"
                }`}
              >
                {result.is_from_me ? "You" : result.sender || "Unknown"}
              </span>
              <span
                className={`text-[10px] whitespace-nowrap ${
                  i === activeIndex ? "text-accent-foreground/80" : "text-muted-foreground"
                }`}
              >
                {formatResultDate(result.date)}
              </span>
            </div>
            <p
              className={`text-xs line-clamp-2 mt-0.5 leading-relaxed ${
                i === activeIndex ? "text-accent-foreground/85" : "text-muted-foreground"
              }`}
            >
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
});

MessageSearch.displayName = "MessageSearch";

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
