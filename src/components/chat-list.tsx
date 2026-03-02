import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Chat } from "@/lib/types";
import { startWindowDrag as startWindowDragCommand } from "@/lib/commands";
import { ContactAvatar } from "./contact-avatar";
import { format, parseISO } from "date-fns";
import { PaneNavHeader } from "@/components/pane-nav-header";
import { PaneSearchInput } from "@/components/ui/pane-search-input";

interface ChatListProps {
  chats: Chat[];
  selectedChatId: number | null;
  onSelectChat: (chatId: number) => void;
}

function formatChatName(chat: Chat): string {
  if (chat.display_name) return chat.display_name;
  if (chat.participants.length > 0) {
    return chat.participants.join(", ");
  }
  if (/^[0-9a-f]{16,}$/i.test(chat.chat_identifier)) {
    return "Group Conversation";
  }
  return chat.chat_identifier;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  try {
    const date = parseISO(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const dayMs = 86400000;

    if (diff < dayMs) return format(date, "h:mm a");
    if (diff < 7 * dayMs) return format(date, "EEE");
    if (date.getFullYear() === now.getFullYear()) return format(date, "MMM d");
    return format(date, "M/d/yy");
  } catch {
    return "";
  }
}

interface ChatDisplayData {
  displayName: string;
  formattedDate: string;
  previewText: string;
  handleId: string | null;
}

interface ChatRowProps {
  display: ChatDisplayData;
  isSelected: boolean;
  chatId: number;
  onSelectChat: (chatId: number) => void;
}

const ChatRow = React.memo(function ChatRow({
  display,
  isSelected,
  chatId,
  onSelectChat,
}: ChatRowProps) {
  return (
    <button
      onClick={() => onSelectChat(chatId)}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors border-b border-border/50 ${
        isSelected
          ? "bg-accent"
          : "hover:bg-foreground/10 dark:hover:bg-foreground/15 active:bg-foreground/15"
      }`}
    >
      <ContactAvatar
        handleId={display.handleId}
        name={display.displayName}
        size={40}
      />

      <div className="flex-1 min-w-0">
        <div className="flex items-start gap-2 min-w-0">
          <span
            className={`min-w-0 flex-1 text-sm font-medium truncate ${
              isSelected ? "text-accent-foreground" : "text-foreground"
            }`}
          >
            {display.displayName}
          </span>
          <span
            className={`text-xs shrink-0 pt-0.5 ${
              isSelected ? "text-accent-foreground/80" : "text-muted-foreground"
            }`}
          >
            {display.formattedDate}
          </span>
        </div>
        <p
          className={`text-xs line-clamp-2 break-all mt-0.5 leading-relaxed ${
            isSelected ? "text-accent-foreground/85" : "text-muted-foreground"
          }`}
        >
          {display.previewText}
        </p>
      </div>
    </button>
  );
});

export function ChatList({
  chats,
  selectedChatId,
  onSelectChat,
}: ChatListProps) {
  const HEADER_COLLAPSE_SCROLL_TOP = 12;
  const SCROLL_DIRECTION_EPSILON = 1;
  const [filterQuery, setFilterQuery] = React.useState("");
  const [isHeaderCollapsed, setIsHeaderCollapsed] = React.useState(false);
  const deferredQuery = React.useDeferredValue(filterQuery);

  const chatDisplayMap = React.useMemo(() => {
    const map = new Map<number, ChatDisplayData>();
    for (const chat of chats) {
      map.set(chat.id, {
        displayName: formatChatName(chat),
        formattedDate: formatDate(chat.last_message_date),
        previewText: chat.last_message_preview || chat.last_message_text || "No messages",
        handleId: chat.participant_handles[0] ?? null,
      });
    }
    return map;
  }, [chats]);

  const searchIndex = React.useMemo(() => {
    const index = new Map<number, string>();
    for (const chat of chats) {
      const parts: string[] = [];
      if (chat.display_name) parts.push(chat.display_name);
      parts.push(...chat.participants);
      parts.push(...chat.participant_handles);
      parts.push(chat.chat_identifier);
      if (chat.last_message_preview) parts.push(chat.last_message_preview);
      if (chat.last_message_text) parts.push(chat.last_message_text);
      index.set(chat.id, parts.join("\0").toLowerCase());
    }
    return index;
  }, [chats]);

  const filteredChats = React.useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((chat) => {
      const text = searchIndex.get(chat.id);
      return text != null && text.includes(q);
    });
  }, [chats, deferredQuery, searchIndex]);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const lastScrollTopRef = React.useRef(0);

  const virtualizer = useVirtualizer({
    count: filteredChats.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 65,
    overscan: 10,
    getItemKey: (index) => filteredChats[index]?.id ?? index,
  });

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
    <div className="flex flex-col h-full bg-transparent">
      <div
        className="relative z-10"
        data-tauri-drag-region
        onMouseDown={startWindowDrag}
      >
        <PaneNavHeader
          title="Messages"
          collapsed={isHeaderCollapsed}
          accessory={(
            <PaneSearchInput
              value={filterQuery}
              onChange={setFilterQuery}
              placeholder="Search conversations..."
              inDragRegion
            />
          )}
        />
      </div>

      <div
        ref={scrollRef}
        onScroll={(evt) => {
          const currentScrollTop = Math.max(0, evt.currentTarget.scrollTop);
          const delta = currentScrollTop - lastScrollTopRef.current;
          let nextCollapsed = isHeaderCollapsed;

          if (currentScrollTop <= HEADER_COLLAPSE_SCROLL_TOP) {
            nextCollapsed = false;
          } else if (delta > SCROLL_DIRECTION_EPSILON) {
            nextCollapsed = true;
          } else if (delta < -SCROLL_DIRECTION_EPSILON) {
            // iOS-like behavior: any upward scroll restores the full header.
            nextCollapsed = false;
          }

          if (nextCollapsed !== isHeaderCollapsed) {
            setIsHeaderCollapsed(nextCollapsed);
          }
          lastScrollTopRef.current = currentScrollTop;
        }}
        className="flex-1 min-h-0 overflow-y-auto"
      >
        {filteredChats.length === 0 ? (
          <div className="p-8 text-center text-muted-foreground text-sm">
            {filterQuery
              ? "No matching conversations"
              : "No conversations found"}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((vItem) => {
              const chat = filteredChats[vItem.index];
              return (
                <div
                  key={chat.id}
                  ref={virtualizer.measureElement}
                  data-index={vItem.index}
                  className="absolute left-0 w-full"
                  style={{ top: vItem.start }}
                >
                  <ChatRow
                    chatId={chat.id}
                    display={chatDisplayMap.get(chat.id)!}
                    isSelected={selectedChatId === chat.id}
                    onSelectChat={onSelectChat}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
