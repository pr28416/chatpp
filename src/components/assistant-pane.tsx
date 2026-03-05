import * as React from "react";
import {
  AtSign,
  Bot,
  Check,
  ChevronDown,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Send,
  X,
} from "lucide-react";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import { AssistantStreamBlocks } from "@/components/assistant-stream-blocks";
import { PaneNavHeader } from "@/components/pane-nav-header";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  ASSISTANT_MODEL_OPTIONS,
  getAssistantModelOption,
  getMissingProviderKeyMessage,
} from "@/lib/assistant-models";
import { extractInlineCitationRefs, makeCitationKey } from "@/lib/assistant-citations";
import { buildDisplayBlocksFromEvents } from "@/lib/assistant-stream-blocks";
import { getMessageByChatRowid } from "@/lib/commands";
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
  selectedModelId: string;
  mentions: AssistantMention[];
  messages: AssistantUiMessage[];
  running: boolean;
  error: string | null;
  providerAvailability: Record<string, boolean>;
  onDraftChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onMentionsChange: (mentions: AssistantMention[]) => void;
  onSubmit: () => void;
  onNewChat: () => void;
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}

interface MentionCandidate {
  chatId: number;
  label: string;
  description: string;
  isThisChat: boolean;
}

const MAX_TEXTAREA_HEIGHT = 180;
const citationCache = new Map<string, AssistantCitation | null>();

export function AssistantPane({
  chats,
  selectedChatId,
  draft,
  selectedModelId,
  mentions,
  messages,
  running,
  error,
  providerAvailability,
  onDraftChange,
  onModelChange,
  onMentionsChange,
  onSubmit,
  onNewChat,
  onJumpToCitation,
}: AssistantPaneProps) {
  const [showMentionMenu, setShowMentionMenu] = React.useState(false);
  const [mentionQuery, setMentionQuery] = React.useState("");
  const [selectedMentionIdx, setSelectedMentionIdx] = React.useState(0);
  const [mentionRange, setMentionRange] = React.useState<{
    start: number;
    end: number;
  } | null>(null);
  const [composerHeight, setComposerHeight] = React.useState(140);
  const [showProcessingTrace, setShowProcessingTrace] = React.useState(true);
  const [scrollTop, setScrollTop] = React.useState(0);

  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const composerRef = React.useRef<HTMLDivElement | null>(null);
  const mentionOptionRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  const selectedModelOption =
    getAssistantModelOption(selectedModelId) ??
    getAssistantModelOption(ASSISTANT_MODEL_OPTIONS[0]?.id ?? "");
  const groupedModels = React.useMemo(() => {
    const groups = new Map<string, typeof ASSISTANT_MODEL_OPTIONS>();
    for (const model of ASSISTANT_MODEL_OPTIONS) {
      const existing = groups.get(model.providerLabel) ?? [];
      groups.set(model.providerLabel, [...existing, model]);
    }
    return Array.from(groups.entries());
  }, []);
  const isProviderReady =
    selectedModelOption == null
      ? false
      : providerAvailability[selectedModelOption.provider] ?? false;
  const missingProviderKeyMessage =
    selectedModelOption && !isProviderReady
      ? getMissingProviderKeyMessage(selectedModelOption)
      : null;

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
          isThisChat: chat.id === selectedChatId,
          index,
        };
      })
      .filter((item) =>
        q
          ? item.index.includes(q) || item.label.toLowerCase().includes(q)
          : true,
      )
      .slice(0, 12)
      .map(({ chatId, label, description, isThisChat }) => ({
        chatId,
        label,
        description,
        isThisChat,
      }));
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

  React.useEffect(() => {
    mentionOptionRefs.current = mentionOptionRefs.current.slice(0, mentionCandidates.length);
  }, [mentionCandidates.length]);

  React.useEffect(() => {
    if (!showMentionMenu || mentionCandidates.length === 0) {
      return;
    }
    mentionOptionRefs.current[selectedMentionIdx]?.scrollIntoView({ block: "nearest" });
  }, [mentionCandidates.length, selectedMentionIdx, showMentionMenu]);

  const applyMentionDetection = React.useCallback(
    (text: string, caret: number) => {
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
    },
    [],
  );

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
    if (running || !draft.trim() || !!missingProviderKeyMessage) {
      return;
    }
    onSubmit();
    setShowMentionMenu(false);
    setMentionQuery("");
    setMentionRange(null);
  }, [draft, missingProviderKeyMessage, onSubmit, running]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-transparent relative">
      <PaneNavHeader
        title="Assistant"
        collapsed={scrollTop > 12}
        leading={<Bot className="h-4 w-4 text-primary" />}
        trailing={(
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              className="h-8 w-8"
              onClick={onNewChat}
              disabled={running}
              aria-label="Start new chat"
            >
              <MessageSquarePlus className="h-4 w-4" />
            </Button>
          </div>
        )}
      />

      <div
        ref={scrollRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-5"
        style={{ paddingBottom: composerHeight + 20 }}
        onScroll={(evt) => setScrollTop(evt.currentTarget.scrollTop)}
      >
        {messages.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-card/70 p-3 text-xs text-muted-foreground">
            Ask about your archive, then add chats with @mentions as needed.
          </div>
        ) : null}

        <AssistantTranscript
          messages={messages}
          showProcessingTrace={showProcessingTrace}
          selectedChatId={selectedChatId}
          chats={chats}
          onJumpToCitation={onJumpToCitation}
        />
      </div>

      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-36 bg-gradient-to-t from-background via-background/80 to-transparent"
      />

      <div
        ref={composerRef}
        className="absolute inset-x-3 bottom-3 z-20 rounded-xl border border-border bg-card/95 p-2 shadow-lg backdrop-blur"
      >
        {error ? (
          <div className="mb-2 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">
            {error}
          </div>
        ) : null}
        {missingProviderKeyMessage ? (
          <div className="mb-2 rounded-md border border-amber-400/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            {missingProviderKeyMessage}
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
                  setSelectedMentionIdx(
                    (prev) => (prev + 1) % mentionCandidates.length,
                  );
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
            placeholder="Ask anything. Use @ to include chats..."
            className="w-full min-h-[56px] max-h-[180px] resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
          />

          <div className="mt-1 flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2 pl-1">
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex max-w-[220px] items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    <span className="truncate">
                      {selectedModelOption
                        ? selectedModelOption.label
                        : "Select model"}
                    </span>
                    <ChevronDown className="h-3 w-3 shrink-0" />
                  </button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-[300px] p-1">
                  <div className="max-h-72 overflow-y-auto pr-1">
                    {groupedModels.map(([providerLabel, models]) => (
                      <div key={providerLabel} className="mb-2 last:mb-0">
                        <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {providerLabel}
                        </div>
                        <div className="space-y-0.5">
                          {models.map((model) => (
                            <button
                              key={model.id}
                              type="button"
                              onClick={() => onModelChange(model.id)}
                              className={cn(
                                "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                                selectedModelOption?.id === model.id
                                  ? "bg-accent text-accent-foreground"
                                  : "hover:bg-accent/70",
                              )}
                            >
                              <span className="truncate">{model.label}</span>
                              {selectedModelOption?.id === model.id ? (
                                <Check className="h-3 w-3 shrink-0" />
                              ) : null}
                            </button>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                <AtSign className="h-3 w-3" />
                Mention
              </div>
            </div>
            <Button
              type="button"
              size="icon-sm"
              onClick={handleSubmit}
              disabled={running || !draft.trim() || !!missingProviderKeyMessage}
              className="rounded-lg"
            >
              {running ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>

          {showMentionMenu ? (
            <div className="absolute bottom-[calc(100%+8px)] left-2 right-2 z-30 max-h-64 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
              {mentionCandidates.length === 0 ? (
                <div className="px-2 py-2 text-xs text-muted-foreground">
                  No matching chats
                </div>
              ) : (
                mentionCandidates.map((candidate, idx) => (
                  <button
                    key={candidate.chatId}
                    type="button"
                    ref={(node) => {
                      mentionOptionRefs.current[idx] = node;
                    }}
                    className={cn(
                      "w-full rounded-md px-2 py-1.5 text-left transition-colors",
                      idx === selectedMentionIdx
                        ? "bg-accent text-accent-foreground"
                        : "hover:bg-accent/70",
                    )}
                    onMouseDown={(evt) => evt.preventDefault()}
                    onClick={() => insertMention(candidate)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs font-medium truncate">
                        {candidate.label}
                      </div>
                      {candidate.isThisChat ? (
                        <span className="shrink-0 rounded-full border border-border/80 bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          This chat
                        </span>
                      ) : null}
                    </div>
                    <div className="text-[10px] text-muted-foreground truncate">
                      {candidate.description || "Conversation"}
                    </div>
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
                  const nextDraft = draft
                    .replace(target, "")
                    .replace(/\s{2,}/g, " ")
                    .trimStart();
                  onDraftChange(nextDraft);
                  onMentionsChange(
                    filterValidMentions(
                      mentions.filter((m) => m !== mention),
                      nextDraft,
                    ),
                  );
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
        const chatLabel = truncate(
          rows[0]?.chat_label ?? (chat ? formatChatName(chat) : "Conversation"),
          42,
        );
        const visibleRows = rows.slice(0, 3);
        const remainingRows = rows.slice(3);
        return (
          <div
            key={chatId}
            className="rounded-md border border-border/70 bg-background/70 p-2"
          >
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
                    {truncate(
                      citation.message_text ??
                        citation.reason ??
                        `Citation rowid ${citation.rowid}`,
                      130,
                    )}
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
                            onClick={() =>
                              onJumpToCitation(
                                citation.chat_id ?? null,
                                citation.rowid,
                              )
                            }
                            className="w-full min-w-0 rounded px-2 py-1.5 text-left hover:bg-accent/60 transition-colors"
                          >
                            <div className="min-w-0 break-words text-[11px] text-muted-foreground">
                              {formatSpeaker(citation)}
                              {citation.date
                                ? ` · ${formatLongDate(citation.date)}`
                                : ""}
                            </div>
                            <div className="min-w-0 break-words whitespace-normal text-xs text-foreground/90">
                              {truncate(
                                citation.message_text ??
                                  citation.reason ??
                                  `Citation rowid ${citation.rowid}`,
                                150,
                              )}
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

const AssistantTranscript = React.memo(function AssistantTranscript({
  messages,
  showProcessingTrace,
  selectedChatId,
  chats,
  onJumpToCitation,
}: {
  messages: AssistantUiMessage[];
  showProcessingTrace: boolean;
  selectedChatId: number | null;
  chats: Chat[];
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}) {
  return (
    <>
      {messages.map((message) => (
        <AssistantMessageItem
          key={message.id}
          message={message}
          showProcessingTrace={showProcessingTrace}
          chats={chats}
          onJumpToCitation={onJumpToCitation}
        />
      ))}
    </>
  );
});

const AssistantMessageItem = React.memo(function AssistantMessageItem({
  message,
  showProcessingTrace,
  chats,
  onJumpToCitation,
}: {
  message: AssistantUiMessage;
  showProcessingTrace: boolean;
  chats: Chat[];
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}) {
  const orderedBlocks = React.useMemo(
    () =>
      message.role === "assistant"
        ? buildDisplayBlocksFromEvents(
            message.processing_events ?? [],
            message.id,
            message.text,
          )
        : [],
    [message.role, message.processing_events, message.id, message.text],
  );

  const inlineRefs = React.useMemo(
    () => (message.role === "assistant" ? extractInlineCitationRefs(message.text) : []),
    [message.role, message.text],
  );
  const [citationDetails, setCitationDetails] = React.useState<Record<string, AssistantCitation>>({});

  React.useEffect(() => {
    if (inlineRefs.length === 0) {
      setCitationDetails({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        inlineRefs.map(async (ref): Promise<[string, AssistantCitation] | null> => {
          const key = makeCitationKey(ref.chatId, ref.rowid);
          const cached = citationCache.get(key);
          if (cached === null) {
            return [
              key,
              {
                chat_id: ref.chatId,
                rowid: ref.rowid,
                label: `cite:${ref.chatId}:${ref.rowid}`,
              },
            ];
          }
          if (cached) {
            return [key, cached];
          }
          try {
            const row = await getMessageByChatRowid(ref.chatId, ref.rowid);
            const chatLabel = chats.find((chat) => chat.id === ref.chatId)?.display_name ?? undefined;
            const mapped: AssistantCitation = row
              ? {
                  chat_id: ref.chatId,
                  rowid: ref.rowid,
                  label: `cite:${ref.chatId}:${ref.rowid}`,
                  chat_label: chatLabel,
                  sender: row.sender,
                  sender_handle: row.sender_handle,
                  date: row.date,
                  message_text: row.text ?? undefined,
                }
              : {
                  chat_id: ref.chatId,
                  rowid: ref.rowid,
                  label: `cite:${ref.chatId}:${ref.rowid}`,
                  chat_label: chatLabel,
                };
            citationCache.set(key, mapped);
            return [key, mapped];
          } catch {
            citationCache.set(key, null);
            return [
              key,
              {
                chat_id: ref.chatId,
                rowid: ref.rowid,
                label: `cite:${ref.chatId}:${ref.rowid}`,
              },
            ];
          }
        }),
      );
      if (cancelled) return;
      setCitationDetails(
        Object.fromEntries(entries.filter((entry): entry is [string, AssistantCitation] => entry !== null)),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [chats, inlineRefs]);

  const citationsForLookup = React.useMemo(
    () =>
      inlineRefs.map((ref) => {
        const key = makeCitationKey(ref.chatId, ref.rowid);
        return (
          citationDetails[key] ?? {
            chat_id: ref.chatId,
            rowid: ref.rowid,
            label: `cite:${ref.chatId}:${ref.rowid}`,
          }
        );
      }),
    [citationDetails, inlineRefs],
  );

  const citationByKey = React.useMemo(
    () =>
      Object.fromEntries(
        citationsForLookup.map((citation) => [
          makeCitationKey(citation.chat_id, citation.rowid),
          citation,
        ]),
      ),
    [citationsForLookup],
  );

  const citationByUniqueRowid = React.useMemo(() => {
    const rowidCounts = new Map<number, number>();
    for (const citation of citationsForLookup) {
      rowidCounts.set(citation.rowid, (rowidCounts.get(citation.rowid) ?? 0) + 1);
    }
    return Object.fromEntries(
      citationsForLookup
        .filter((citation) => (rowidCounts.get(citation.rowid) ?? 0) === 1)
        .map((citation) => [citation.rowid, citation]),
    );
  }, [citationsForLookup]);
  const showCitationGroups =
    message.role === "assistant" &&
    message.status !== "streaming" &&
    citationsForLookup.length > 0;

  return (
    <div className="text-sm">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-muted-foreground/90">
        {message.role === "assistant" ? "Assistant" : "You"}
      </div>

      {message.role === "assistant" ? (
        <div className="space-y-4">
          {showProcessingTrace && orderedBlocks.length > 0 ? (
            <AssistantStreamBlocks
              blocks={orderedBlocks}
              citationByKey={citationByKey}
              citationByUniqueRowid={citationByUniqueRowid}
              renderUnresolvedAsInvalid={message.status !== "streaming"}
              onJumpToCitation={onJumpToCitation}
            />
          ) : (
            <AssistantMarkdown
              text={message.text}
              citationByKey={citationByKey}
              citationByUniqueRowid={citationByUniqueRowid}
              renderUnresolvedAsInvalid={message.status !== "streaming"}
              onJumpToCitation={onJumpToCitation}
            />
          )}
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words leading-relaxed">
          {message.text}
        </div>
      )}

      {showCitationGroups ? (
        <CitationGroups
          citations={citationsForLookup}
          chats={chats}
          onJumpToCitation={onJumpToCitation}
        />
      ) : null}
    </div>
  );
});

function filterValidMentions(
  mentions: AssistantMention[],
  text: string,
): AssistantMention[] {
  return mentions.filter(
    (mention) => text.slice(mention.start, mention.end) === `@${mention.label}`,
  );
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
