import * as React from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { assistantRunTurn, fetchChats } from "@/lib/commands";
import type {
  AssistantConversationContext,
  AssistantMention,
  AssistantProcessingEvent,
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
  const [searchMatchesByChat, setSearchMatchesByChat] = React.useState<
    Record<number, number[]>
  >({});
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const {
    requestedJumpRowid,
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
    const current = assistantUi;
    const trimmed = current.draft.trim();
    if (!trimmed || current.running) {
      return;
    }

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
      processing_duration_ms: 0,
    });
    updateAssistantUi({
      draft: "",
      mentions: [],
      running: true,
      error: null,
    });

    const validMentionIds = current.mentions
      .filter((mention: AssistantMention) => trimmed.includes(`@${mention.label}`))
      .map((mention: AssistantMention) => mention.chatId);
    const dedupedMentionIds = Array.from(new Set(validMentionIds));
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
    try {
      unlisten = await listen<AssistantProcessingEvent>(
        `assistant-stream:${streamId}`,
        (event) => {
          const payload = event.payload;
          if (!payload) return;
          updateAssistantMessage(pendingAssistantId, (previous) => {
            const nextEvents = [...(previous?.processing_events ?? []), payload];
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
              processing_duration_ms:
                payload.duration_ms ??
                previous?.processing_duration_ms ??
                payload.at_ms,
            };
          });
        },
      );

      const response = await assistantRunTurn({
        selected_chat_id: null,
        mentioned_chat_ids: dedupedMentionIds,
        mentioned_chat_contexts: mentionedChatContexts,
        user_message: trimmed,
        stream_id: streamId,
        conversation: convo,
      });
      updateAssistantMessage(pendingAssistantId, {
        text: response.text,
        status: "done",
        processing_duration_ms: response.duration_ms,
        citations: response.citations,
        tool_traces: response.tool_traces,
      });
      updateAssistantUi({
        running: false,
        error: null,
      });
    } catch (err) {
      const reason = formatUnknownError(err);
      updateAssistantMessage(pendingAssistantId, {
        text: `Failed to generate response: ${reason}`,
        status: "error",
      });
      updateAssistantUi({
        running: false,
        error: reason,
      });
    } finally {
      if (unlisten) {
        unlisten();
      }
    }
  }, [
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
        window.setTimeout(() => requestJump(rowid), 40);
        return;
      }
      requestJump(rowid);
    },
    [requestJump, selectedChatId],
  );

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
      onJumpHandled={acknowledgeJump}
      onJumpToRowid={requestJump}
      onJumpToCitation={handleAssistantCitationJump}
      onHighlightChange={setActiveHighlightRowid}
      assistantDraft={assistantUi.draft}
      assistantMentions={assistantUi.mentions}
      assistantMessages={assistantUi.messages}
      assistantRunning={assistantUi.running}
      assistantError={assistantUi.error}
      onAssistantDraftChange={(value) =>
        updateAssistantUi({
          draft: value,
          mentions: assistantUi.mentions.filter((m) => value.includes(`@${m.label}`)),
          error: null,
        })
      }
      onAssistantMentionsChange={(mentions) => updateAssistantUi({ mentions })}
      onAssistantSubmit={handleAssistantSubmit}
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
