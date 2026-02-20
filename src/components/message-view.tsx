import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Message, DateRange, Chat, SearchResult } from "@/lib/types";
import { fetchMessages } from "@/lib/commands";
import { MessageBubble } from "./message-bubble";
import { MessageMinimap } from "./message-minimap";
import { ReplyThreadOverlay } from "./reply-thread-overlay";
import { DateRangeFilter } from "./date-range-filter";
import { MessageSearch } from "./message-search";
import { Search } from "lucide-react";
import { format, parseISO, isToday, isYesterday } from "date-fns";

interface MessageViewProps {
  chat: Chat | null;
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
  const scrollRef = React.useRef<HTMLDivElement>(null);

  const topSentinelRef = React.useRef<HTMLDivElement>(null);
  const bottomSentinelRef = React.useRef<HTMLDivElement>(null);

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
  const [searchQuery, setSearchQuery] = React.useState("");
  const [searchResults, setSearchResults] = React.useState<SearchResult[]>([]);
  const [highlightedRowid, setHighlightedRowid] = React.useState<number | null>(
    null,
  );

  const searchMatchRowids = React.useMemo(() => {
    if (searchResults.length === 0) return undefined;
    return new Set(searchResults.map((r) => r.rowid));
  }, [searchResults]);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setSearchOpen(true);
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

  const handleJumpToResult = React.useCallback(
    (result: SearchResult) => {
      setHighlightedRowid(result.rowid);

      const idx = displayMessages.findIndex((m) => m.rowid === result.rowid);
      if (idx >= 0) {
        virtualizerRef.current?.scrollToIndex(idx, { align: "center" });
        return;
      }

      if (!chat) return;
      fetchMessages(chat.id, {
        after_rowid: result.rowid - 1,
        limit: 10,
      }).then((data) => {
        if (data.messages.length === 0) return;
        setMessages(data.messages);
        setHasPrevious(true);
        setHasMore(data.has_more);

        setTimeout(() => {
          const newIdx = data.messages
            .filter((m) => !m.is_tapback)
            .findIndex((m) => m.rowid === result.rowid);
          if (newIdx >= 0) {
            virtualizerRef.current?.scrollToIndex(newIdx, { align: "center" });
          }
        }, 50);
      });
    },
    [displayMessages, chat],
  );

  React.useEffect(() => {
    handleSearchClose();
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
    overscan: 30,
    getItemKey: (index) => displayMessages[index]?.rowid ?? index,
  });

  virtualizerRef.current = virtualizer;

  React.useEffect(() => {
    if (!chat) {
      setMessages([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadingDirection("initial");

    const hasDateRange = !!(dateRange.start || dateRange.end);

    fetchMessages(chat.id, {
      start: dateRange.start,
      end: dateRange.end,
      limit: hasDateRange ? 0 : 10,
      ...(hasDateRange ? { after_rowid: 0 } : {}),
    })
      .then((data) => {
        if (cancelled) return;
        setMessages(data.messages);
        setHasPrevious(
          hasDateRange ? data.messages.length > 0 : data.has_previous,
        );
        setHasMore(hasDateRange ? data.messages.length > 0 : data.has_more);
        setLoading(false);
        setLoadingDirection(null);

        if (!hasDateRange) {
          setTimeout(() => {
            if (scrollRef.current) {
              scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            }
          }, 100);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("Failed to fetch messages:", err);
        setLoading(false);
        setLoadingDirection(null);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat, dateRange]);

  const busyRef = React.useRef(false);
  const scrollToAfterPrepend = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    if (scrollToAfterPrepend.current !== null) {
      virtualizer.scrollToIndex(scrollToAfterPrepend.current, {
        align: "start",
      });
      scrollToAfterPrepend.current = null;
    }
  });

  const loadPrevious = React.useCallback(async () => {
    if (!chat || messages.length === 0 || busyRef.current || !hasPrevious)
      return;

    busyRef.current = true;
    setLoadingDirection("previous");

    try {
      const data = await fetchMessages(chat.id, {
        before_rowid: messages[0].rowid,
        limit: 10,
      });

      const newDisplayCount = data.messages.filter((m) => !m.is_tapback).length;
      scrollToAfterPrepend.current = newDisplayCount;

      setMessages((prev) => [...data.messages, ...prev]);
      setHasPrevious(data.has_previous);
    } catch (err) {
      console.error("Failed to fetch previous messages:", err);
    } finally {
      busyRef.current = false;
      setLoadingDirection(null);
    }
  }, [chat, messages, hasPrevious]);

  const loadMore = React.useCallback(async () => {
    if (!chat || messages.length === 0 || busyRef.current || !hasMore) return;

    busyRef.current = true;
    setLoadingDirection("more");

    try {
      const data = await fetchMessages(chat.id, {
        after_rowid: messages[messages.length - 1].rowid,
        limit: 10,
      });

      setMessages((prev) => [...prev, ...data.messages]);
      setHasMore(data.has_more);
    } catch (err) {
      console.error("Failed to fetch more messages:", err);
    } finally {
      busyRef.current = false;
      setLoadingDirection(null);
    }
  }, [chat, messages, hasMore]);

  const loadPreviousRef = React.useRef(loadPrevious);
  const loadMoreRef = React.useRef(loadMore);
  React.useEffect(() => {
    loadPreviousRef.current = loadPrevious;
  }, [loadPrevious]);
  React.useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);

  const isSentinelVisible = React.useCallback(
    (sentinel: HTMLDivElement | null) => {
      const root = scrollRef.current;
      if (!sentinel || !root) return false;
      const sRect = sentinel.getBoundingClientRect();
      const rRect = root.getBoundingClientRect();
      return sRect.bottom > rRect.top && sRect.top < rRect.bottom;
    },
    [],
  );

  React.useEffect(() => {
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
  }, [chat, hasPrevious]);

  React.useEffect(() => {
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
  }, [chat, hasMore]);

  React.useEffect(() => {
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      if (hasPrevious && isSentinelVisible(topSentinelRef.current)) {
        loadPreviousRef.current();
      }
      if (hasMore && isSentinelVisible(bottomSentinelRef.current)) {
        loadMoreRef.current();
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [messages, hasPrevious, hasMore, isSentinelVisible]);

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
            onClick={() => setSearchOpen((p) => !p)}
            className="p-1.5 rounded-md hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
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

        <MessageMinimap
          messages={displayMessages}
          scrollRef={scrollRef}
          searchMatchRowids={searchMatchRowids}
          topSentinelRef={topSentinelRef}
          bottomSentinelRef={bottomSentinelRef}
        />

        {searchOpen && chat && (
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
