import * as React from "react";
import { Chat } from "@/lib/types";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContactAvatar } from "./contact-avatar";
import { Search, X } from "lucide-react";
import { format, parseISO } from "date-fns";

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

export function ChatList({
  chats,
  selectedChatId,
  onSelectChat,
}: ChatListProps) {
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [filterQuery, setFilterQuery] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (searchOpen) {
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [searchOpen]);

  const filteredChats = React.useMemo(() => {
    const q = filterQuery.trim().toLowerCase();
    if (!q) return chats;
    return chats.filter((chat) => {
      if (chat.display_name?.toLowerCase().includes(q)) return true;
      if (chat.participants.some((p) => p.toLowerCase().includes(q)))
        return true;
      if (chat.participant_handles.some((h) => h.toLowerCase().includes(q)))
        return true;
      if (chat.chat_identifier.toLowerCase().includes(q)) return true;
      if (chat.last_message_text?.toLowerCase().includes(q)) return true;
      return false;
    });
  }, [chats, filterQuery]);

  const handleSearchClose = () => {
    setSearchOpen(false);
    setFilterQuery("");
  };

  return (
    <div className="flex flex-col h-full border-r border-border bg-card">
      <div className="border-b border-border">
        {searchOpen ? (
          <div className="flex items-center gap-2 px-3 py-2.5">
            <Search className="h-4 w-4 text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              type="text"
              value={filterQuery}
              onChange={(e) => setFilterQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") handleSearchClose();
              }}
              placeholder="Search conversations..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground outline-none"
            />
            <button
              onClick={handleSearchClose}
              aria-label="Close search"
              className="p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between px-4 py-3">
            <h2 className="text-lg font-semibold text-foreground">Messages</h2>
            <button
              onClick={() => setSearchOpen(true)}
              aria-label="Search conversations"
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            >
              <Search className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col">
          {filteredChats.map((chat) => (
            <button
              key={chat.id}
              onClick={() => onSelectChat(chat.id)}
              className={`flex items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-accent border-b border-border/50 ${
                selectedChatId === chat.id ? "bg-accent" : ""
              }`}
            >
              <ContactAvatar
                handleId={chat.participant_handles[0] ?? null}
                name={formatChatName(chat)}
                size={40}
              />

              <div className="flex-1 min-w-0">
                <div className="flex items-start gap-2 min-w-0">
                  <span className="min-w-0 flex-1 text-sm font-medium text-foreground truncate">
                    {formatChatName(chat)}
                  </span>
                  <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
                    {formatDate(chat.last_message_date)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground line-clamp-2 break-all mt-0.5 leading-relaxed">
                  {chat.last_message_text ||
                    (chat.participant_handles.length > 0
                      ? chat.participant_handles.join(", ")
                      : "No messages")}
                </p>
              </div>
            </button>
          ))}

          {filteredChats.length === 0 && (
            <div className="p-8 text-center text-muted-foreground text-sm">
              {filterQuery
                ? "No matching conversations"
                : "No conversations found"}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
