import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Message, DateRange, Chat, SearchResult, PaginatedMessages } from "@/lib/types";
import { fetchMessages } from "@/lib/commands";
import { MessageBubble } from "./message-bubble";
import { MessageMinimap } from "./message-minimap";
import { ReplyThreadOverlay } from "./reply-thread-overlay";
import { DateRangeFilter } from "./date-range-filter";
import { MessageSearch } from "./message-search";
import { TimelinePane } from "./timeline-pane";
import { Search, ListTree } from "lucide-react";
import { format, parseISO, isToday, isYesterday } from "date-fns";

interface MessageViewProps {
  chat: Chat | null;
}

interface MessageCacheEntry {
  messages: Message[];
  hasPrevious: boolean;
  hasMore: boolean;
  cachedAt: number;
}

const MESSAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const MESSAGE_CACHE_MAX = 20;
const INITIAL_LOAD_LIMIT = 60;
const PAGE_LOAD_LIMIT = 10;
const messageCache = new Map<string, MessageCacheEntry>();
const IS_DEV =
  ((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV ??
    false) === true;

function getDateRangeKey(dateRange: DateRange): string {
  const start = dateRange.start ?? "";
  const end = dateRange.end ?? "";
  return `${start}|${end}`;
}

function getCacheKey(chatId: number, dateRange: DateRange): string {
  return `${chatId}:${getDateRangeKey(dateRange)}`;
}

function getCachedMessages(cacheKey: string): MessageCacheEntry | null {
  const now = Date.now();
  const entry = messageCache.get(cacheKey);
  if (!entry) return null;
  if (now - entry.cachedAt > MESSAGE_CACHE_TTL_MS) {
    messageCache.delete(cacheKey);
    return null;
  }

  // Refresh insertion order to keep LRU semantics.
  messageCache.delete(cacheKey);
  messageCache.set(cacheKey, entry);
  return entry;
}

function setCachedMessages(cacheKey: string, value: MessageCacheEntry) {
  const now = Date.now();

  for (const [key, entry] of messageCache.entries()) {
    if (now - entry.cachedAt > MESSAGE_CACHE_TTL_MS) {
      messageCache.delete(key);
    }
  }

  if (messageCache.has(cacheKey)) {
    messageCache.delete(cacheKey);
  }

  messageCache.set(cacheKey, value);

  while (messageCache.size > MESSAGE_CACHE_MAX) {
    const oldestKey = messageCache.keys().next().value;
    if (!oldestKey) break;
    messageCache.delete(oldestKey);
  }
}

function maybeLogDev(message: string, ...args: unknown[]) {
  if (IS_DEV) {
    console.log(message, ...args);
  }
}

export function MessageView({ chat }: MessageViewProps) {
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [dateRange, setDateRange] = React.useState<DateRange>({});
  const [hasPrevious, setHasPrevious] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [loadingDirection, setLoadingDirection] = React.useState<
    "initial" | "previous" | "more" | null
  >(null);
  const [isInitialLoadComplete, setIsInitialLoadComplete] =
    React.useState(false);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const topSentinelRef = React.useRef<HTMLDivElement>(null);
  const bottomSentinelRef = React.useRef<HTMLDivElement>(null);

  const activeLoadIdRef = React.useRef(0);
  const busyRef = React.useRef(false);
  const scrollToAfterPrepend = React.useRef<number | null>(null);
  const selectionStartRef = React.useRef<number | null>(null);
  const initialFetchCountRef = React.useRef(0);
  const fetchWindowTimerRef = React.useRef<number | null>(null);

  const displayMessages = React.useMemo(
    () => messages.filter((m) => !m.is_tapback),
    [messages],
  );

  const guidMap = React.useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) {
      map.set(m.guid, m);
    }
    return map;
  }, [messages]);

  const [replyThreadGuid, setReplyThreadGuid] = React.useState<string | null>(
    null,
  );
  const handleReplyClick = React.useCallback((originGuid: string) => {
    setReplyThreadGuid(originGuid);
  }, []);
  const handleCloseThread = React.useCallback(() => {
    setReplyThreadGuid(null);
  }, []);

  const [searchOpen, setSearchOpen] = React.useState(false);
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [highlightedRowid, setHighlightedRowid] = React.useState<number | null>(
    null,
  );

  const searchMatchRowids = React.useMemo(() => {
    if (searchResults.length === 0) return undefined;
    return new Set(searchResults.map((r) => r.rowid));
  }, [searchResults]);

  const canAutoPaginate = isInitialLoadComplete && !loading;

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
        setTimelineOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const handleSearchClose = React.useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchResults([]);
    setHighlightedRowid(null);
  }, []);

  const handleSearchResults = React.useCallback((results: SearchResult[]) => {
    setSearchResults(results);
  }, []);

  const handleActiveResultChange = React.useCallback(
    (result: SearchResult | null) => {
      setHighlightedRowid(result?.rowid ?? null);
    },
    [],
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const virtualizerRef = React.useRef<any>(null);

  const jumpToRowid = React.useCallback(
    (rowid: number) => {
      setHighlightedRowid(rowid);

      const idx = displayMessages.findIndex((m) => m.rowid === rowid);
      if (idx >= 0) {
        virtualizerRef.current?.scrollToIndex(idx, { align: "center" });
        return;
      }

      if (!chat) return;
      const loadId = activeLoadIdRef.current;

      fetchMessages(chat.id, {
        after_rowid: rowid - 1,
        limit: PAGE_LOAD_LIMIT,
      }).then((data) => {
        if (loadId !== activeLoadIdRef.current || data.messages.length === 0)
          return;

        setMessages(data.messages);
        setHasPrevious(true);
        setHasMore(data.has_more);

        setTimeout(() => {
          if (loadId !== activeLoadIdRef.current) return;
          const newIdx = data.messages
            .filter((m) => !m.is_tapback)
            .findIndex((m) => m.rowid === rowid);
          if (newIdx >= 0) {
            virtualizerRef.current?.scrollToIndex(newIdx, { align: "center" });
          }
        }, 50);
      });
    },
    [displayMessages, chat],
  );

  const handleJumpToResult = React.useCallback(
    (result: SearchResult) => {
      jumpToRowid(result.rowid);
    },
    [jumpToRowid],
  );

  const handleTimelineJump = React.useCallback(
    (rowid: number) => {
      setSearchOpen(false);
      jumpToRowid(rowid);
    },
    [jumpToRowid],
  );

  React.useEffect(() => {
    handleSearchClose();
    setTimelineOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat]);

  const showSeparator = React.useMemo(() => {
    const result: boolean[] = new Array(displayMessages.length);
    let lastKey = "";
    for (let i = 0; i < displayMessages.length; i++) {
      try {
        const d = parseISO(displayMessages[i].date);
        const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
        result[i] = i === 0 || key !== lastKey;
        lastKey = key;
      } catch {
        result[i] = false;
      }
    }
    return result;
  }, [displayMessages]);

  const groupInfo = React.useMemo(() => {
    return displayMessages.map((msg, i) => {
      const prev = i > 0 ? displayMessages[i - 1] : null;
      const next =
        i < displayMessages.length - 1 ? displayMessages[i + 1] : null;
      return {
        isFirstInGroup:
          !prev ||
          prev.is_from_me !== msg.is_from_me ||
          prev.sender !== msg.sender,
        isLastInGroup:
          !next ||
          next.is_from_me !== msg.is_from_me ||
          next.sender !== msg.sender,
      };
    });
  }, [displayMessages]);

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => {
      const msg = displayMessages[index];
      const hasMedia = msg?.attachments?.some(
        (a) =>
          a.mime_type?.startsWith("image/") ||
          a.mime_type?.startsWith("video/"),
      );
      if (hasMedia) return 350;
      const len = msg?.text?.length || 0;
      if (len > 200) return 120;
      if (len > 80) return 72;
      return 52;
    },
    overscan: 12,
    getItemKey: (index) => displayMessages[index]?.rowid ?? index,
  });

  virtualizerRef.current = virtualizer;

  const applyMessagePayload = React.useCallback(
    (
      data: PaginatedMessages,
      hasDateRange: boolean,
      options: { loadId: number },
    ) => {
      setMessages(data.messages);
      setHasPrevious(hasDateRange ? data.messages.length > 0 : data.has_previous);
      setHasMore(hasDateRange ? data.messages.length > 0 : data.has_more);

      const finishInitialLoad = () => {
        setIsInitialLoadComplete(true);
        if (selectionStartRef.current !== null) {
          const duration = performance.now() - selectionStartRef.current;
          maybeLogDev("[perf] chat select -> first messages rendered: %.1fms", duration);
          selectionStartRef.current = null;
        }
      };

      if (!hasDateRange) {
        const visibleTargetIndex =
          data.messages.filter((m) => !m.is_tapback).length - 1;

        const alignToBottom = (attempt: number) => {
          if (options.loadId !== activeLoadIdRef.current) return;

          if (visibleTargetIndex >= 0) {
            virtualizerRef.current?.scrollToIndex(visibleTargetIndex, {
              align: "end",
            });
          }

          if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
          }

          if (attempt < 2) {
            requestAnimationFrame(() => alignToBottom(attempt + 1));
            return;
          }

          requestAnimationFrame(finishInitialLoad);
        };

        requestAnimationFrame(() => alignToBottom(0));
        return;
      }

      requestAnimationFrame(finishInitialLoad);
    },
    [],
  );

  React.useEffect(() => {
    if (fetchWindowTimerRef.current !== null) {
      window.clearTimeout(fetchWindowTimerRef.current);
      fetchWindowTimerRef.current = null;
    }

    if (!chat) {
      activeLoadIdRef.current += 1;
      busyRef.current = false;
      setMessages([]);
      setHasPrevious(false);
      setHasMore(false);
      setLoading(false);
      setLoadingDirection(null);
      setIsInitialLoadComplete(false);
      setHighlightedRowid(null);
      selectionStartRef.current = null;
      return;
    }

    const loadId = activeLoadIdRef.current + 1;
    activeLoadIdRef.current = loadId;

    busyRef.current = false;
    setMessages([]);
    setHasPrevious(false);
    setHasMore(false);
    setHighlightedRowid(null);
    setIsInitialLoadComplete(false);
    setLoading(true);
    setLoadingDirection("initial");

    selectionStartRef.current = performance.now();
    initialFetchCountRef.current = 0;
    fetchWindowTimerRef.current = window.setTimeout(() => {
      maybeLogDev(
        "[perf] initial fetches fired in first 1s for chat %d: %d",
        chat.id,
        initialFetchCountRef.current,
      );
      fetchWindowTimerRef.current = null;
    }, 1000);

    const hasDateRange = !!(dateRange.start || dateRange.end);
    const cacheKey = getCacheKey(chat.id, dateRange);

    const cached = getCachedMessages(cacheKey);
    if (cached) {
      applyMessagePayload(
        {
          messages: cached.messages,
          has_previous: cached.hasPrevious,
          has_more: cached.hasMore,
        },
        hasDateRange,
        { loadId },
      );
      setLoading(true);
      setLoadingDirection(null);
      maybeLogDev("[perf] message cache hit for key %s", cacheKey);
    }

    initialFetchCountRef.current += 1;

    fetchMessages(chat.id, {
      start: dateRange.start,
      end: dateRange.end,
      limit: hasDateRange ? 0 : INITIAL_LOAD_LIMIT,
      ...(hasDateRange ? { after_rowid: 0 } : {}),
      fast_initial: true,
    })
      .then((data) => {
        if (loadId !== activeLoadIdRef.current) return;

        applyMessagePayload(data, hasDateRange, { loadId });
        setLoading(false);
        setLoadingDirection(null);

        setCachedMessages(cacheKey, {
          messages: data.messages,
          hasPrevious: hasDateRange ? data.messages.length > 0 : data.has_previous,
          hasMore: hasDateRange ? data.messages.length > 0 : data.has_more,
          cachedAt: Date.now(),
        });
      })
      .catch((err) => {
        if (loadId !== activeLoadIdRef.current) return;
        console.error("Failed to fetch messages:", err);
        setLoading(false);
        setLoadingDirection(null);
      });

    return () => {
      if (fetchWindowTimerRef.current !== null) {
        window.clearTimeout(fetchWindowTimerRef.current);
        fetchWindowTimerRef.current = null;
      }
    };
  }, [chat, dateRange, applyMessagePayload]);

  React.useLayoutEffect(() => {
    if (scrollToAfterPrepend.current !== null) {
      virtualizer.scrollToIndex(scrollToAfterPrepend.current, {
        align: "start",
      });
      scrollToAfterPrepend.current = null;
    }
  });

  const loadPrevious = React.useCallback(async () => {
    if (
      !chat ||
      messages.length === 0 ||
      busyRef.current ||
      !hasPrevious ||
      !canAutoPaginate
    ) {
      return;
    }

    const loadId = activeLoadIdRef.current;
    const firstRowId = messages[0].rowid;

    busyRef.current = true;
    setLoadingDirection("previous");

    try {
      const data = await fetchMessages(chat.id, {
        before_rowid: firstRowId,
        limit: PAGE_LOAD_LIMIT,
      });

      if (loadId !== activeLoadIdRef.current) return;

      const newDisplayCount = data.messages.filter((m) => !m.is_tapback).length;
      scrollToAfterPrepend.current = newDisplayCount;

      setMessages((prev) => [...data.messages, ...prev]);
      setHasPrevious(data.has_previous);
    } catch (err) {
      if (loadId === activeLoadIdRef.current) {
        console.error("Failed to fetch previous messages:", err);
      }
    } finally {
      if (loadId === activeLoadIdRef.current) {
        busyRef.current = false;
        setLoadingDirection(null);
      }
    }
  }, [chat, messages, hasPrevious, canAutoPaginate]);

  const loadMore = React.useCallback(async () => {
    if (
      !chat ||
      messages.length === 0 ||
      busyRef.current ||
      !hasMore ||
      !canAutoPaginate
    ) {
      return;
    }

    const loadId = activeLoadIdRef.current;
    const lastRowId = messages[messages.length - 1].rowid;

    busyRef.current = true;
    setLoadingDirection("more");

    try {
      const data = await fetchMessages(chat.id, {
        after_rowid: lastRowId,
        limit: PAGE_LOAD_LIMIT,
      });

      if (loadId !== activeLoadIdRef.current) return;

      setMessages((prev) => [...prev, ...data.messages]);
      setHasMore(data.has_more);
    } catch (err) {
      if (loadId === activeLoadIdRef.current) {
        console.error("Failed to fetch more messages:", err);
      }
    } finally {
      if (loadId === activeLoadIdRef.current) {
        busyRef.current = false;
        setLoadingDirection(null);
      }
    }
  }, [chat, messages, hasMore, canAutoPaginate]);

  const loadPreviousRef = React.useRef(loadPrevious);
  const loadMoreRef = React.useRef(loadMore);
  React.useEffect(() => {
    loadPreviousRef.current = loadPrevious;
  }, [loadPrevious]);
  React.useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  React.useEffect(() => {
    if (!canAutoPaginate) return;

    const sentinel = topSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadPreviousRef.current();
        }
      },
      { root, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chat, hasPrevious, canAutoPaginate]);

  React.useEffect(() => {
    if (!canAutoPaginate) return;

    const sentinel = bottomSentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel || !root) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMoreRef.current();
        }
      },
      { root, threshold: 0.1 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chat, hasMore, canAutoPaginate]);

  if (!chat) {
    return (
      <div className="flex-1 flex items-center justify-center bg-muted/30">
        <p className="text-muted-foreground">
          Select a conversation to view messages
        </p>
      </div>
    );
  }

  const chatName =
    chat.display_name || chat.participants.join(", ") || chat.chat_identifier;
  const isGroupChat = chat.participants.length > 1;
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div className="flex-1 flex flex-col h-full bg-background">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-card">
        <div>
          <h2 className="text-base font-semibold text-foreground">
            {chatName}
          </h2>
          {isGroupChat && (
            <p className="text-xs text-muted-foreground">
              {chat.participants.length} participants
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <DateRangeFilter
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
          <button
            type="button"
            onClick={() => {
              setTimelineOpen((p) => !p);
              setSearchOpen(false);
            }}
            className={`p-1.5 rounded-md transition-colors ${
              timelineOpen
                ? "bg-muted text-foreground"
                : "hover:bg-muted text-muted-foreground hover:text-foreground"
            }`}
            aria-label="Toggle timeline pane"
          >
            <ListTree className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => {
              setSearchOpen((p) => !p);
              setTimelineOpen(false);
            }}
            className={`p-1.5 rounded-md transition-colors ${
              searchOpen
                ? "bg-muted text-foreground"
                : "hover:bg-muted text-muted-foreground hover:text-foreground"
            }`}
            aria-label="Search messages"
          >
            <Search className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="flex-1 flex overflow-hidden">
        <div className="flex-1 relative overflow-hidden">
          <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
            {hasPrevious && (
              <div ref={topSentinelRef} className="flex justify-center py-3">
                <LoadingSpinner />
              </div>
            )}

            {loading && loadingDirection === "initial" && (
              <div className="flex justify-center py-8">
                <p className="text-sm text-muted-foreground">
                  Loading messages...
                </p>
              </div>
            )}

            {!loading && displayMessages.length === 0 && (
              <div className="flex justify-center py-8">
                <p className="text-sm text-muted-foreground">
                  No messages found
                  {dateRange.start || dateRange.end
                    ? " in this date range"
                    : ""}
                </p>
              </div>
            )}

            {displayMessages.length > 0 && (
              <div
                style={{
                  height: `${virtualizer.getTotalSize()}px`,
                  width: "100%",
                  position: "relative",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualItems[0]?.start ?? 0}px)`,
                  }}
                >
                  {virtualItems.map((virtualRow) => {
                    const idx = virtualRow.index;
                    const message = displayMessages[idx];
                    const { isFirstInGroup, isLastInGroup } = groupInfo[idx];
                    const replyTo = message.reply_to_guid
                      ? (guidMap.get(message.reply_to_guid) ?? null)
                      : null;

                    return (
                      <div
                        key={virtualRow.key}
                        data-index={idx}
                        ref={virtualizer.measureElement}
                        className="px-4"
                      >
                        {showSeparator[idx] && (
                          <InlineDateSeparator dateStr={message.date} />
                        )}
                        <MessageBubble
                          message={message}
                          showSender={isGroupChat}
                          isFirstInGroup={isFirstInGroup}
                          isLastInGroup={isLastInGroup}
                          replyToMessage={replyTo}
                          onReplyClick={handleReplyClick}
                          isHighlighted={message.rowid === highlightedRowid}
                          searchQuery={searchOpen ? searchQuery : undefined}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {hasMore && (
              <div ref={bottomSentinelRef} className="flex justify-center py-3">
                <LoadingSpinner />
              </div>
            )}

            <div className="h-2" />
          </div>
        </div>

        {timelineOpen ? (
          <TimelinePane chatId={chat.id} onJumpToRowid={handleTimelineJump} />
        ) : (
          <MessageMinimap
            messages={displayMessages}
            scrollRef={scrollRef}
            searchMatchRowids={searchMatchRowids}
            topSentinelRef={topSentinelRef}
            bottomSentinelRef={bottomSentinelRef}
          />
        )}

        {searchOpen && !timelineOpen && chat && (
          <MessageSearch
            chatId={chat.id}
            dateRange={dateRange}
            onJumpToResult={handleJumpToResult}
            onSearchResults={handleSearchResults}
            onClose={handleSearchClose}
            onActiveResultChange={handleActiveResultChange}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
          />
        )}
      </div>

      <ReplyThreadOverlay
        originGuid={replyThreadGuid}
        messages={displayMessages}
        guidMap={guidMap}
        isGroupChat={isGroupChat}
        onClose={handleCloseThread}
      />
    </div>
  );
}

function LoadingSpinner() {
  return (
    <svg
      className="animate-spin h-5 w-5 text-muted-foreground"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

function formatDateLabel(dateStr: string): string {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return "Today";
    if (isYesterday(date)) return "Yesterday";
    return format(date, "EEEE, MMMM d, yyyy");
  } catch {
    return dateStr;
  }
}

function InlineDateSeparator({ dateStr }: { dateStr: string }) {
  return (
    <div className="flex items-center justify-center py-3">
      <span className="text-[11px] font-medium text-muted-foreground bg-muted/50 px-3 py-1 rounded-full">
        {formatDateLabel(dateStr)}
      </span>
    </div>
  );
}
