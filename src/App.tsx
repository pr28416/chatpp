import * as React from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  assistantRunTurn,
  fetchChats,
  getAssistantProviderAvailability,
} from "@/lib/commands";
import {
  appendEventToDisplayBlocks,
  syncDisplayBlocksWithFinalText,
} from "@/lib/assistant-stream-blocks";
import {
  DEFAULT_ASSISTANT_MODEL_ID,
  getAssistantModelOption,
  getMissingProviderKeyMessage,
} from "@/lib/assistant-models";
import type {
  AssistantConversationContext,
  AssistantMention,
  AssistantProcessingEvent,
  AssistantProviderAvailability,
  AssistantUiMessage,
  Chat,
  PerChatAssistantUiState,
  PerChatSearchUiState,
  PerChatTimelineUiState,
  SearchResult,
  SidebarMode,
} from "@/lib/types";
import { ChatList } from "@/components/chat-list";
import { MessageView } from "@/components/message-view";
import { WorkspaceShell } from "@/components/workspace-shell";
import { useRowidJumpBridge } from "@/hooks/use-rowid-jump-bridge";

const THREE_PANE_FLAG =
  ((
    import.meta as ImportMeta & {
      env?: { DEV?: boolean; VITE_UI_THREE_PANE?: string };
    }
  ).env?.DEV ??
    false) ||
  (import.meta as ImportMeta & { env?: { VITE_UI_THREE_PANE?: string } }).env
    ?.VITE_UI_THREE_PANE === "1";

function defaultSearchUiState(): PerChatSearchUiState {
  return {
    searchQuery: "",
    dateRange: {},
    scopeAll: true,
  };
}

function defaultTimelineUiState(): PerChatTimelineUiState {
  return {
    view: "topics_list",
    topicQuery: "",
    selectedTopicId: null,
    selectedDetailNodeId: null,
    expandedSubtopicIds: {},
    selectedOccurrenceIdxByNode: {},
  };
}

function defaultAssistantUiState(): PerChatAssistantUiState {
  return {
    draft: "",
    selected_model_id: DEFAULT_ASSISTANT_MODEL_ID,
    mentions: [],
    messages: [],
    running: false,
    error: null,
  };
}

export default function App() {
  const [chats, setChats] = React.useState<Chat[]>([]);
  const [selectedChatId, setSelectedChatId] = React.useState<number | null>(
    null,
  );
  const [activeMode, setActiveMode] = React.useState<SidebarMode>("chats");
  const [searchUiByChat, setSearchUiByChat] = React.useState<
    Record<number, PerChatSearchUiState>
  >({});
  const [timelineUiByChat, setTimelineUiByChat] = React.useState<
    Record<number, PerChatTimelineUiState>
  >({});
  const [assistantUi, setAssistantUi] = React.useState<PerChatAssistantUiState>(
    defaultAssistantUiState(),
  );
  const [assistantProviderAvailability, setAssistantProviderAvailability] =
    React.useState<AssistantProviderAvailability>({
      openai: false,
      anthropic: false,
      google: false,
      xai: false,
    });
  const [searchMatchesByChat, setSearchMatchesByChat] = React.useState<
    Record<number, number[]>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const assistantRunInFlightRef = React.useRef(false);
  const activeAssistantRunRef = React.useRef<{
    streamId: string;
    pendingAssistantId: string;
    runId: string | null;
    phase: "streaming" | "final_received" | "closed";
    unlisten: UnlistenFn | null;
  } | null>(null);

  const {
    requestedJumpRowid,
    requestedJumpChatId,
    requestJump,
    acknowledgeJump,
    setActiveHighlightRowid,
  } = useRowidJumpBridge();

  React.useEffect(() => {
    fetchChats()
      .then((data) => {
        setChats(data);
        setLoading(false);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Failed to fetch chats:", err);
        setError(
          "Failed to load conversations. Make sure Full Disk Access is enabled for this app in System Settings > Privacy & Security.",
        );
        setLoading(false);
      });
  }, []);

  React.useEffect(() => {
    getAssistantProviderAvailability()
      .then((availability) => {
        setAssistantProviderAvailability(availability);
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.error("Failed to load assistant provider availability:", err);
      });
  }, []);

  const selectedChat = React.useMemo(
    () => chats.find((c) => c.id === selectedChatId) || null,
    [chats, selectedChatId],
  );

  const selectedSearchUi = React.useMemo(() => {
    if (!selectedChatId) return defaultSearchUiState();
    return searchUiByChat[selectedChatId] ?? defaultSearchUiState();
  }, [searchUiByChat, selectedChatId]);

  const selectedTimelineUi = React.useMemo(() => {
    if (!selectedChatId) return defaultTimelineUiState();
    return timelineUiByChat[selectedChatId] ?? defaultTimelineUiState();
  }, [selectedChatId, timelineUiByChat]);

  const selectedSearchMatchRowids = React.useMemo(() => {
    if (!selectedChatId) return undefined;
    const rowids = searchMatchesByChat[selectedChatId] ?? [];
    return rowids.length > 0 ? new Set(rowids) : undefined;
  }, [searchMatchesByChat, selectedChatId]);

  const updateSelectedSearchUi = React.useCallback(
    (next: Partial<PerChatSearchUiState>) => {
      if (!selectedChatId) return;
      setSearchUiByChat((prev) => ({
        ...prev,
        [selectedChatId]: {
          ...(prev[selectedChatId] ?? defaultSearchUiState()),
          ...next,
        },
      }));
    },
    [selectedChatId],
  );

  const updateSelectedTimelineUi = React.useCallback(
    (next: PerChatTimelineUiState) => {
      if (!selectedChatId) return;
      setTimelineUiByChat((prev) => ({
        ...prev,
        [selectedChatId]: next,
      }));
    },
    [selectedChatId],
  );

  const updateAssistantUi = React.useCallback(
    (next: Partial<PerChatAssistantUiState>) => {
      setAssistantUi((prev) => ({
        ...prev,
        ...next,
      }));
    },
    [],
  );

  const appendAssistantMessage = React.useCallback(
    (message: AssistantUiMessage) => {
      setAssistantUi((prev) => ({
        ...prev,
        messages: [...prev.messages, message],
      }));
    },
    [],
  );

  const updateAssistantMessage = React.useCallback(
    (
      messageId: string,
      patch:
        | Partial<AssistantUiMessage>
        | ((current: AssistantUiMessage | undefined) => Partial<AssistantUiMessage>),
    ) => {
      setAssistantUi((prev) => ({
        ...prev,
        messages: prev.messages.map((message) => {
          if (message.id !== messageId) {
            return message;
          }
          const resolvedPatch =
            typeof patch === "function" ? patch(message) : patch;
          return { ...message, ...resolvedPatch };
        }),
      }));
    },
    [],
  );

  const handleAssistantSubmit = React.useCallback(async () => {
    if (assistantRunInFlightRef.current) {
      return;
    }
    assistantRunInFlightRef.current = true;
    const current = assistantUi;
    const trimmed = current.draft.trim();
    if (!trimmed || current.running) {
      assistantRunInFlightRef.current = false;
      return;
    }
    const selectedModel = getAssistantModelOption(current.selected_model_id);
    if (!selectedModel) {
      updateAssistantUi({
        error: `Unknown selected model: ${current.selected_model_id}`,
      });
      assistantRunInFlightRef.current = false;
      return;
    }
    if (!assistantProviderAvailability[selectedModel.provider]) {
      updateAssistantUi({
        error: getMissingProviderKeyMessage(selectedModel),
      });
      assistantRunInFlightRef.current = false;
      return;
    }

    const validMentionIds = current.mentions
      .filter((mention: AssistantMention) => trimmed.includes(`@${mention.label}`))
      .map((mention: AssistantMention) => mention.chatId)
      .filter((chatId) => Number.isInteger(chatId) && chatId > 0);
    const inferredScope = inferMentionedChatScopeFromDraft(trimmed, chats);
    const structuredMentionTokens = new Set(
      current.mentions
        .map((mention) => normalizeMentionToken(mention.label).split(" ")[0])
        .filter((value) => value.length > 0),
    );
    const unresolvedAmbiguous = inferredScope.ambiguousTokens.filter(
      (token) => !structuredMentionTokens.has(normalizeMentionToken(token.replace(/^@+/, ""))),
    );
    if (unresolvedAmbiguous.length > 0) {
      updateAssistantUi({
        error: `Mention is ambiguous: ${unresolvedAmbiguous.join(", ")}. Pick a specific conversation from the @ menu.`,
      });
      assistantRunInFlightRef.current = false;
      return;
    }
    const dedupedMentionIds = Array.from(
      new Set([...validMentionIds, ...inferredScope.chatIds]),
    ).filter((chatId) => Number.isInteger(chatId) && chatId > 0);

    const nowIso = new Date().toISOString();
    const userMsg: AssistantUiMessage = {
      id: `user-${nowIso}-${Math.random().toString(36).slice(2, 9)}`,
      role: "user",
      text: trimmed,
      created_at: nowIso,
    };
    appendAssistantMessage(userMsg);
    const pendingAssistantId = `assistant-pending-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const streamId = `stream-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    appendAssistantMessage({
      id: pendingAssistantId,
      role: "assistant",
      text: "",
      created_at: new Date().toISOString(),
      status: "streaming",
      processing_events: [],
      display_blocks: [],
      processing_duration_ms: 0,
    });
    updateAssistantUi({
      draft: "",
      mentions: [],
      running: true,
      error: null,
    });
    const mentionedChatContexts = dedupedMentionIds
      .map((chatId) =>
        buildAssistantConversationContext(
          chats.find((chat) => chat.id === chatId) ?? null,
        ),
      )
      .filter((ctx): ctx is AssistantConversationContext => ctx !== null);
    const convo = [...current.messages, userMsg].map((msg) => ({
      role: msg.role,
      text: msg.text,
    }));

    let unlisten: UnlistenFn | null = null;
    activeAssistantRunRef.current = {
      streamId,
      pendingAssistantId,
      runId: null,
      phase: "streaming",
      unlisten: null,
    };
    try {
      unlisten = await listen<AssistantProcessingEvent>(
        `assistant-stream:${streamId}`,
        (event) => {
          const session = activeAssistantRunRef.current;
          if (!session || session.streamId !== streamId || session.phase !== "streaming") {
            return;
          }
          const payload = event.payload;
          if (!payload) return;
          if (payload.run_id) {
            if (session.runId && session.runId !== payload.run_id) {
              return;
            }
            if (!session.runId) {
              session.runId = payload.run_id;
            }
          } else if (session.runId) {
            return;
          }
          if (payload.kind === "run-finish") {
            session.phase = "final_received";
            if (session.unlisten) {
              const stop = session.unlisten;
              session.unlisten = null;
              stop();
            }
          }
          updateAssistantMessage(pendingAssistantId, (previous) => {
            const nextEvents = [...(previous?.processing_events ?? []), payload];
            const nextBlocks = appendEventToDisplayBlocks(
              previous?.display_blocks ?? [],
              payload,
              pendingAssistantId,
            );
            let nextText = previous?.text ?? "";
            if (payload.kind === "text-delta" && payload.text) {
              nextText += payload.text;
            }
            if (payload.kind === "run-error" && payload.text) {
              nextText = `Error: ${payload.text}`;
            }
            return {
              text: nextText,
              processing_events: nextEvents,
              display_blocks: nextBlocks,
              processing_duration_ms:
                payload.duration_ms ??
                previous?.processing_duration_ms ??
                payload.at_ms,
            };
          });
        },
      );
      if (activeAssistantRunRef.current?.streamId === streamId) {
        activeAssistantRunRef.current.unlisten = unlisten;
      }

      const response = await assistantRunTurn({
        selected_chat_id: null,
        mentioned_chat_ids: dedupedMentionIds,
        mentioned_chat_contexts: mentionedChatContexts,
        model_provider: selectedModel.provider,
        model_id: selectedModel.id,
        user_message: trimmed,
        stream_id: streamId,
        conversation: convo,
      });
      const session = activeAssistantRunRef.current;
      if (session && session.streamId === streamId) {
        session.phase = "final_received";
        if (session.unlisten) {
          const stop = session.unlisten;
          session.unlisten = null;
          stop();
        }
      }
      unlisten = null;
      updateAssistantMessage(pendingAssistantId, (previous) => ({
        text: response.text,
        status: "done",
        display_blocks: syncDisplayBlocksWithFinalText(
          previous?.display_blocks ?? [],
          response.text,
          pendingAssistantId,
        ),
        processing_duration_ms: response.duration_ms,
        citations: response.citations,
        tool_traces: response.tool_traces,
      }));
      updateAssistantUi({
        running: false,
        error: null,
      });
    } catch (err) {
      const reason = formatUnknownError(err);
      updateAssistantMessage(pendingAssistantId, (previous) => ({
        text: `Failed to generate response: ${reason}`,
        status: "error",
        display_blocks: [
          ...(previous?.display_blocks ?? []),
          {
            id: `${pendingAssistantId}:error:${Date.now()}`,
            kind: "error",
            text: `Error: ${reason}`,
          },
        ],
      }));
      updateAssistantUi({
        running: false,
        error: reason,
      });
    } finally {
      if (unlisten) {
        unlisten();
      }
      const session = activeAssistantRunRef.current;
      if (session && session.streamId === streamId) {
        session.phase = "closed";
        activeAssistantRunRef.current = null;
      }
      assistantRunInFlightRef.current = false;
    }
  }, [
    assistantProviderAvailability,
    appendAssistantMessage,
    assistantUi,
    chats,
    updateAssistantMessage,
    updateAssistantUi,
  ]);

  const handleSearchResultsChange = React.useCallback(
    (results: SearchResult[]) => {
      if (!selectedChatId) return;
      setSearchMatchesByChat((prev) => ({
        ...prev,
        [selectedChatId]: results.map((r) => r.rowid),
      }));
    },
    [selectedChatId],
  );

  const handleAssistantCitationJump = React.useCallback(
    (chatId: number | null, rowid: number) => {
      if (chatId != null && chatId !== selectedChatId) {
        setSelectedChatId(chatId);
      }
      requestJump(rowid, chatId ?? selectedChatId ?? null);
    },
    [requestJump, selectedChatId],
  );

  const handleAssistantNewChat = React.useCallback(() => {
    setAssistantUi((prev) => ({
      ...prev,
      draft: "",
      mentions: [],
      messages: [],
      running: false,
      error: null,
    }));
  }, []);

  if (error) {
    return (
      <div className="h-screen flex items-center justify-center p-8">
        <div className="text-center max-w-md">
          <h1 className="text-xl font-semibold text-destructive mb-2">
            Connection Error
          </h1>
          <p className="text-muted-foreground text-sm">{error}</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <p className="text-muted-foreground">Loading conversations...</p>
      </div>
    );
  }

  if (!THREE_PANE_FLAG) {
    return (
      <div className="h-screen flex overflow-hidden">
        <div className="w-80 flex-shrink-0">
          <ChatList
            chats={chats}
            selectedChatId={selectedChatId}
            onSelectChat={setSelectedChatId}
          />
        </div>
        <MessageView
          chat={selectedChat}
          dateRange={selectedSearchUi.dateRange}
          requestedJumpRowid={requestedJumpRowid}
          requestedJumpChatId={requestedJumpChatId}
          onJumpHandled={acknowledgeJump}
          onHighlightChange={setActiveHighlightRowid}
          searchQuery={selectedSearchUi.searchQuery}
          searchMatchRowids={selectedSearchMatchRowids}
        />
      </div>
    );
  }

  return (
    <WorkspaceShell
      chats={chats}
      selectedChatId={selectedChatId}
      selectedChat={selectedChat}
      onSelectChat={setSelectedChatId}
      activeMode={activeMode}
      onModeChange={setActiveMode}
      searchQuery={selectedSearchUi.searchQuery}
      onSearchQueryChange={(value) =>
        updateSelectedSearchUi({ searchQuery: value })
      }
      dateRange={selectedSearchUi.dateRange}
      onDateRangeChange={(dateRange) => updateSelectedSearchUi({ dateRange })}
      scopeAll={selectedSearchUi.scopeAll}
      onScopeAllChange={(scopeAll) => updateSelectedSearchUi({ scopeAll })}
      onSearchResultsChange={handleSearchResultsChange}
      searchMatchRowids={selectedSearchMatchRowids}
      onActiveResultChange={setActiveHighlightRowid}
      requestedJumpRowid={requestedJumpRowid}
      requestedJumpChatId={requestedJumpChatId}
      onJumpHandled={acknowledgeJump}
      onJumpToRowid={requestJump}
      onJumpToCitation={handleAssistantCitationJump}
      onHighlightChange={setActiveHighlightRowid}
      assistantDraft={assistantUi.draft}
      assistantSelectedModelId={assistantUi.selected_model_id}
      assistantMentions={assistantUi.mentions}
      assistantMessages={assistantUi.messages}
      assistantRunning={assistantUi.running}
      assistantError={assistantUi.error}
      assistantProviderAvailability={assistantProviderAvailability}
      onAssistantDraftChange={(value) =>
        updateAssistantUi({
          draft: value,
          mentions: assistantUi.mentions.filter((m) => value.includes(`@${m.label}`)),
          error: null,
        })
      }
      onAssistantModelChange={(selected_model_id) =>
        updateAssistantUi({ selected_model_id, error: null })
      }
      onAssistantMentionsChange={(mentions) => updateAssistantUi({ mentions })}
      onAssistantSubmit={handleAssistantSubmit}
      onAssistantNewChat={handleAssistantNewChat}
      initialTimelineUiState={selectedTimelineUi}
      onTimelineUiStateChange={updateSelectedTimelineUi}
    />
  );
}

function buildAssistantConversationContext(chat: Chat | null): AssistantConversationContext | null {
  if (!chat) {
    return null;
  }
  return {
    chat_id: chat.id,
    label: formatAssistantChatLabel(chat),
    participants: chat.participants.filter((value) => value.trim().length > 0),
  };
}

function formatAssistantChatLabel(chat: Chat): string {
  if (chat.display_name && chat.display_name.trim().length > 0) {
    return chat.display_name.trim();
  }
  const participants = chat.participants
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (participants.length > 0) {
    return participants.join(", ");
  }
  return "Conversation";
}

function inferMentionedChatScopeFromDraft(
  draft: string,
  chats: Chat[],
): { chatIds: number[]; ambiguousTokens: string[] } {
  const tokens = Array.from(
    new Set(
      [...draft.matchAll(/@([^\s@]{2,})/g)]
        .map((match) => normalizeMentionToken(match[1]))
        .filter((value) => value.length > 0),
    ),
  );

  if (tokens.length === 0) {
    return { chatIds: [], ambiguousTokens: [] };
  }

  const matches: number[] = [];
  const ambiguousTokens: string[] = [];
  for (const token of tokens) {
    const found = chats.filter((chat) => {
      const index = normalizeMentionToken(
        [
          chat.display_name ?? "",
          ...chat.participants,
          ...chat.participant_handles,
          chat.chat_identifier,
        ].join(" "),
      );
      return index.includes(token);
    });
    if (found.length === 1) {
      if (Number.isInteger(found[0].id) && found[0].id > 0) {
        matches.push(found[0].id);
      }
      continue;
    }
    if (found.length > 1) {
      ambiguousTokens.push(`@${token}`);
    }
  }

  return { chatIds: matches, ambiguousTokens };
}

function normalizeMentionToken(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatUnknownError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (typeof err === "string" && err.trim()) {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return "Assistant request failed";
  }
}
