import * as React from "react";

import { fetchChats } from "@/lib/commands";
import type {
  Chat,
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
      onHighlightChange={setActiveHighlightRowid}
      initialTimelineUiState={selectedTimelineUi}
      onTimelineUiStateChange={updateSelectedTimelineUi}
    />
  );
}
