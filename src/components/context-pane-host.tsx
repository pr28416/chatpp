import * as React from "react";

import { AssistantPane } from "@/components/assistant-pane";
import { ChatList } from "@/components/chat-list";
import { SearchSidebarPane } from "@/components/search-sidebar-pane";
import { TimelinePane } from "@/components/timeline-pane";
import type {
  AssistantMention,
  AssistantUiMessage,
  Chat,
  DateRange,
  PerChatTimelineUiState,
  SearchResult,
  SidebarMode,
} from "@/lib/types";

interface ContextPaneHostProps {
  mode: SidebarMode;
  chats: Chat[];
  selectedChatId: number | null;
  selectedChat: Chat | null;
  onSelectChat: (chatId: number) => void;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  scopeAll: boolean;
  onScopeAllChange: (value: boolean) => void;
  onJumpToRowid: (rowid: number) => void;
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
  onSearchResultsChange: (results: SearchResult[]) => void;
  onActiveResultChange: (rowid: number | null) => void;
  assistantDraft: string;
  assistantMentions: AssistantMention[];
  assistantMessages: AssistantUiMessage[];
  assistantRunning: boolean;
  assistantError: string | null;
  onAssistantDraftChange: (value: string) => void;
  onAssistantMentionsChange: (mentions: AssistantMention[]) => void;
  onAssistantSubmit: () => void;
  initialTimelineUiState?: PerChatTimelineUiState;
  onTimelineUiStateChange: (state: PerChatTimelineUiState) => void;
}

export function ContextPaneHost({
  mode,
  chats,
  selectedChatId,
  selectedChat,
  onSelectChat,
  searchQuery,
  onSearchQueryChange,
  dateRange,
  onDateRangeChange,
  scopeAll,
  onScopeAllChange,
  onJumpToRowid,
  onJumpToCitation,
  onSearchResultsChange,
  onActiveResultChange,
  assistantDraft,
  assistantMentions,
  assistantMessages,
  assistantRunning,
  assistantError,
  onAssistantDraftChange,
  onAssistantMentionsChange,
  onAssistantSubmit,
  initialTimelineUiState,
  onTimelineUiStateChange,
}: ContextPaneHostProps) {
  if (mode === "chats") {
    return (
      <ChatList
        chats={chats}
        selectedChatId={selectedChatId}
        onSelectChat={onSelectChat}
      />
    );
  }

  if (mode === "search") {
    return (
      <SearchSidebarPane
        chatId={selectedChat?.id ?? null}
        dateRange={dateRange}
        onDateRangeChange={onDateRangeChange}
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        scopeAll={scopeAll}
        onScopeAllChange={onScopeAllChange}
        onJumpToRowid={onJumpToRowid}
        onSearchResultsChange={onSearchResultsChange}
        onActiveResultChange={onActiveResultChange}
      />
    );
  }

  if (mode === "ai") {
    return (
      <AssistantPane
        chats={chats}
        selectedChatId={selectedChatId}
        draft={assistantDraft}
        mentions={assistantMentions}
        messages={assistantMessages}
        running={assistantRunning}
        error={assistantError}
        onDraftChange={onAssistantDraftChange}
        onMentionsChange={onAssistantMentionsChange}
        onSubmit={onAssistantSubmit}
        onJumpToCitation={onJumpToCitation}
      />
    );
  }

  if (!selectedChat) {
    return (
      <div className="h-full flex items-center justify-center p-6 text-center text-sm text-muted-foreground bg-transparent">
        Select a conversation to view timeline.
      </div>
    );
  }

  return (
    <TimelinePane
      chatId={selectedChat.id}
      onJumpToRowid={onJumpToRowid}
      initialUiState={initialTimelineUiState}
      onUiStateChange={onTimelineUiStateChange}
      embedded
    />
  );
}
