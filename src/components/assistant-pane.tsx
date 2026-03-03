import * as React from "react";
import { AtSign, ChevronDown, Loader2, MessageSquare, Send, X } from "lucide-react";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import { AssistantProcessingTrace } from "@/components/assistant-processing-trace";
import { PaneNavHeader } from "@/components/pane-nav-header";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { buildInlineCitations } from "@/lib/assistant-citations";
import { cn } from "@/lib/utils";
import type {
  AssistantCitation,
  AssistantMention,
  AssistantUiMessage,
  Chat,
} from "@/lib/types";

interface AssistantPaneProps {
  chats: Chat[];
  selectedChatId: number | null;
  draft: string;
  mentions: AssistantMention[];
  messages: AssistantUiMessage[];
  running: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onMentionsChange: (mentions: AssistantMention[]) => void;
  onSubmit: () => void;
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}

interface MentionCandidate {
  chatId: number;
  label: string;
  description: string;
}

const MAX_TEXTAREA_HEIGHT = 180;

export function AssistantPane({
  chats,
  selectedChatId,
  draft,
  mentions,
  messages,
  running,
  error,
  onDraftChange,
  onMentionsChange,
  onSubmit,
  onJumpToCitation,
}: AssistantPaneProps) {
  const [isHeaderCollapsed, setIsHeaderCollapsed] = React.useState(false);
  const [showMentionMenu, setShowMentionMenu] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const [selectedMentionIdx, setSelectedMentionIdx] = React.useState(0);
  const [mentionRange, setMentionRange] = React.useState<{ start: number; end: number } | null>(null);
  const [composerHeight, setComposerHeight] = React.useState(140);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const composerRef = React.useRef<HTMLDivElement | null>(null);

  const mentionCandidates = React.useMemo(() => {
    const q = mentionQuery.trim().toLowerCase();
    return chats
      .map((chat) => {
        const label = formatChatName(chat);
        const index = [
          chat.display_name,
          ...chat.participants,
          ...chat.participant_handles,
          chat.chat_identifier,
          chat.last_message_preview,
          chat.last_message_text,
        ]
          .filter(Boolean)
          .join("\0")
          .toLowerCase();
        return {
          chatId: chat.id,
          label,
          description: chat.participant_handles.join(", "),
          index,
        };
      })
      .filter((item) => item.chatId !== selectedChatId)
      .filter((item) => (q ? item.index.includes(q) || item.label.toLowerCase().includes(q) : true))
      .slice(0, 12)
      .map(({ chatId, label, description }) => ({ chatId, label, description }));
  }, [chats, mentionQuery, selectedChatId]);

  React.useEffect(() => {
    textareaRef.current?.focus();
  }, [selectedChatId]);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    node.scrollTop = node.scrollHeight;
  }, [messages, running]);

  React.useEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      setComposerHeight(node.getBoundingClientRect().height);
    });
    observer.observe(node);
    setComposerHeight(node.getBoundingClientRect().height);
    return () => observer.disconnect();
  }, []);

  React.useEffect(() => {
    if (!textareaRef.current) {
      return;
    }
    textareaRef.current.style.height = "auto";
    textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, MAX_TEXTAREA_HEIGHT)}px`;
  }, [draft]);

  const applyMentionDetection = React.useCallback((text: string, caret: number) => {
    const left = text.slice(0, caret);
    const at = left.lastIndexOf("@");
    if (at < 0) {
      setShowMentionMenu(false);
      setMentionQuery("");
      setMentionRange(null);
      return;
    }
    const token = left.slice(at + 1);
    if (token.includes(" ") || token.includes("\n") || token.includes("\t")) {
      setShowMentionMenu(false);
      setMentionQuery("");
      setMentionRange(null);
      return;
    }
    setShowMentionMenu(true);
    setMentionQuery(token);
    setMentionRange({ start: at, end: caret });
    setSelectedMentionIdx(0);
  }, []);

  const handleDraftChange = React.useCallback(
    (evt: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = evt.target.value;
      const caret = evt.target.selectionStart ?? value.length;
      onDraftChange(value);
      onMentionsChange(filterValidMentions(mentions, value));
      applyMentionDetection(value, caret);
    },
    [applyMentionDetection, mentions, onDraftChange, onMentionsChange],
  );

  const insertMention = React.useCallback(
    (candidate: MentionCandidate) => {
      if (!mentionRange) {
        return;
      }
      const insertion = `@${candidate.label} `;
      const nextText = `${draft.slice(0, mentionRange.start)}${insertion}${draft.slice(mentionRange.end)}`;
      const nextMentionStart = mentionRange.start;
      const nextMentionEnd = mentionRange.start + insertion.trimEnd().length;
      const offset = insertion.length - (mentionRange.end - mentionRange.start);

      const shiftedMentions = mentions
        .map((m) => {
          if (m.end <= mentionRange.start) {
            return m;
          }
          if (m.start >= mentionRange.end) {
            return {
              ...m,
              start: m.start + offset,
              end: m.end + offset,
            };
          }
          return null;
        })
        .filter((m): m is AssistantMention => m !== null)
        .filter((m) => m.chatId !== candidate.chatId);

      const nextMentions = [
        ...shiftedMentions,
        {
          chatId: candidate.chatId,
          label: candidate.label,
          start: nextMentionStart,
          end: nextMentionEnd,
        },
      ];

      onDraftChange(nextText);
      onMentionsChange(nextMentions);
      setShowMentionMenu(false);
      setMentionQuery("");
      setMentionRange(null);

      requestAnimationFrame(() => {
        const input = textareaRef.current;
        if (!input) {
          return;
        }
        input.focus();
        const cursor = mentionRange.start + insertion.length;
        input.setSelectionRange(cursor, cursor);
      });
    },
    [draft, mentionRange, mentions, onDraftChange, onMentionsChange],
  );

  const handleSubmit = React.useCallback(() => {
    if (running || !draft.trim()) {
      return;
    }
    onSubmit();
    setShowMentionMenu(false);
    setMentionQuery("");
    setMentionRange(null);
  }, [draft, onSubmit, running]);

  const activeChat = React.useMemo(
    () => chats.find((chat) => chat.id === selectedChatId) ?? null,
    [chats, selectedChatId],
  );

  if (!activeChat) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-sm text-muted-foreground">
        Select a conversation to chat with your message history.
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-transparent relative">
      <PaneNavHeader
        title="AI"
        collapsed={isHeaderCollapsed}
        accessory={(
          <div className="rounded-xl border border-border bg-background/95 p-2 shadow-xs">
            <div className="text-xs text-muted-foreground">
              Context includes: <span className="text-foreground font-medium">{formatChatName(activeChat)}</span>
            </div>
            <div className="mt-1 text-[11px] text-muted-foreground">
              Type <span className="font-medium text-foreground">@</span> to reference other chats.
            </div>
          </div>
        )}
      />

      <div
        ref={scrollRef}
        onScroll={(evt) => setIsHeaderCollapsed(evt.currentTarget.scrollTop > 12)}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-5"
        style={{ paddingBottom: composerHeight + 20 }}
      >
        {messages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card/70 p-3 text-xs text-muted-foreground">
            Ask about this conversation, cross-chat patterns, or timeline trends.
          </div>
        ) : null}

        {messages.map((message) => {
          const inlineCitations =
            message.role === "assistant"
              ? buildInlineCitations(message.text, message.citations ?? [], activeChat.id)
              : [];
          return (
            <div key={message.id} className="text-sm">
              <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground/90">
                {message.role === "assistant" ? "Assistant" : "You"}
              </div>

              {message.role === "assistant" ? (
                <div className="space-y-4">
                  <AssistantProcessingTrace
                    events={message.processing_events ?? []}
                    streaming={message.status === "streaming"}
                    durationMs={message.processing_duration_ms}
                  />
                  <AssistantMarkdown
                    text={message.text}
                    citationByRowid={Object.fromEntries(
                      inlineCitations.map((citation) => [
                        citation.rowid,
                        citation,
                      ]),
                    )}
                    onJumpToCitation={onJumpToCitation}
                  />
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words leading-relaxed">{message.text}</div>
              )}

              {inlineCitations.length > 0 ? (
                <CitationGroups
                  citations={inlineCitations}
                  chats={chats}
                  onJumpToCitation={onJumpToCitation}
                />
              ) : null}
            </div>
          );
        })}
      </div>

      <div
        ref={composerRef}
        className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-card/95 p-2 shadow-lg backdrop-blur"
      >
        {error ? (
          <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </div>
        ) : null}

        <div className="relative rounded-xl bg-transparent">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleDraftChange}
            onKeyDown={(evt) => {
              if (showMentionMenu && mentionCandidates.length > 0) {
                if (evt.key === "ArrowDown") {
                  evt.preventDefault();
                  setSelectedMentionIdx((prev) => (prev + 1) % mentionCandidates.length);
                  return;
                }
                if (evt.key === "ArrowUp") {
                  evt.preventDefault();
                  setSelectedMentionIdx((prev) =>
                    prev === 0 ? mentionCandidates.length - 1 : prev - 1,
                  );
                  return;
                }
                if (evt.key === "Enter" && !evt.shiftKey) {
                  evt.preventDefault();
                  const selected = mentionCandidates[selectedMentionIdx];
                  if (selected) {
                    insertMention(selected);
                  }
                  return;
                }
              }
              if (evt.key === "Escape") {
                setShowMentionMenu(false);
                return;
              }
              if (evt.key === "Enter" && !evt.shiftKey) {
                evt.preventDefault();
                handleSubmit();
              }
            }}
            placeholder="Ask about this chat. Use @ to include another chat..."
            className="w-full min-h-[56px] max-h-[180px] resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />

          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <AtSign className="h-3 w-3" />
              Mention chats for broader context
            </div>
            <Button
              type="button"
              size="sm"
              onClick={handleSubmit}
              disabled={running || !draft.trim()}
              className="rounded-lg"
            >
              {running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
              Send
            </Button>
          </div>

          {showMentionMenu ? (
            <div className="absolute bottom-[calc(100%+8px)] left-2 right-2 z-30 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
              {mentionCandidates.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">No matching chats</div>
              ) : (
                mentionCandidates.map((candidate, idx) => (
                  <button
                    key={candidate.chatId}
                    type="button"
                    className={cn(
                      "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                      idx === selectedMentionIdx
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/70",
                    )}
                    onMouseDown={(evt) => evt.preventDefault()}
                    onClick={() => insertMention(candidate)}
                  >
                    <div className="text-xs font-medium">{candidate.label}</div>
                    <div className="text-[10px] text-muted-foreground truncate">{candidate.description || "Conversation"}</div>
                  </button>
                ))
              )}
            </div>
          ) : null}
        </div>

        {mentions.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {mentions.map((mention) => (
              <button
                type="button"
                key={`${mention.chatId}-${mention.start}-${mention.end}`}
                onClick={() => {
                  const target = `@${mention.label}`;
                  const nextDraft = draft.replace(target, "").replace(/\s{2,}/g, " ").trimStart();
                  onDraftChange(nextDraft);
                  onMentionsChange(filterValidMentions(mentions.filter((m) => m !== mention), nextDraft));
                }}
                className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                @{mention.label}
                <X className="h-3 w-3" />
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function CitationGroups({
  citations,
  chats,
  onJumpToCitation,
}: {
  citations: AssistantCitation[];
  chats: Chat[];
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}) {
  const byChat = React.useMemo(() => {
    const map = new Map<number, AssistantCitation[]>();
    for (const citation of citations) {
      const current = map.get(citation.chat_id) ?? [];
      current.push(citation);
      map.set(citation.chat_id, current);
    }
    return Array.from(map.entries());
  }, [citations]);

  return (
    <div className="mt-2 space-y-2">
      {byChat.map(([chatId, rows]) => {
        const chat = chats.find((item) => item.id === chatId);
        const chatLabel =
          truncate(rows[0]?.chat_label ?? (chat ? formatChatName(chat) : "Conversation"), 42);
        const visibleRows = rows.slice(0, 3);
        const remainingRows = rows.slice(3);
        return (
          <div key={chatId} className="rounded-md border border-border/70 bg-background/70 p-2">
            <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
              <MessageSquare className="h-3 w-3 shrink-0" />
              <span className="truncate">{chatLabel}</span>
            </div>
            <div className="space-y-1">
              {visibleRows.map((citation) => (
                <button
                  key={`${chatId}-${citation.rowid}`}
                  type="button"
                  onClick={() =>
                    onJumpToCitation(citation.chat_id ?? null, citation.rowid)
                  }
                  className="w-full text-left rounded px-1.5 py-1 hover:bg-accent/60 transition-colors"
                >
                  <div className="text-[11px] text-muted-foreground">
                    {formatSpeaker(citation)}
                    {citation.date ? ` · ${formatLongDate(citation.date)}` : ""}
                  </div>
                  <div className="text-xs text-foreground/90">
                    {truncate(citation.message_text ?? citation.reason ?? "Referenced message", 130)}
                  </div>
                </button>
              ))}
              {remainingRows.length > 0 ? (
                <Popover>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      +{remainingRows.length} more
                      <ChevronDown className="h-3 w-3" />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="start"
                    className="w-[28rem] max-w-[calc(100vw-2rem)] p-1"
                  >
                    <div className="max-h-72 overflow-y-auto pr-1">
                      <div className="space-y-1 p-1">
                        {remainingRows.map((citation) => (
                          <button
                            key={`${chatId}-${citation.rowid}`}
                            type="button"
                            onClick={() => onJumpToCitation(citation.chat_id ?? null, citation.rowid)}
                            className="w-full min-w-0 rounded px-2 py-1.5 text-left hover:bg-accent/60 transition-colors"
                          >
                            <div className="min-w-0 break-words text-[11px] text-muted-foreground">
                              {formatSpeaker(citation)}
                              {citation.date ? ` · ${formatLongDate(citation.date)}` : ""}
                            </div>
                            <div className="min-w-0 break-words whitespace-normal text-xs text-foreground/90">
                              {truncate(citation.message_text ?? citation.reason ?? "Referenced message", 150)}
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function filterValidMentions(mentions: AssistantMention[], text: string): AssistantMention[] {
  return mentions.filter((mention) => text.slice(mention.start, mention.end) === `@${mention.label}`);
}

function formatChatName(chat: Chat): string {
  if (chat.display_name) {
    return chat.display_name;
  }
  if (chat.participants.length > 0) {
    return chat.participants.join(", ");
  }
  if (/^[0-9a-f]{16,}$/i.test(chat.chat_identifier)) {
    return "Group Conversation";
  }
  return chat.chat_identifier;
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function formatLongDate(value: string): string {
  try {
    const date = new Date(value);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function formatSpeaker(citation: AssistantCitation): string {
  const sender = citation.sender?.trim();
  if (sender) {
    return truncate(sender, 28);
  }
  return "You";
}
