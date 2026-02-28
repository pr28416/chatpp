// Types mirroring the Rust backend API response types

export interface Chat {
  id: number;
  chat_identifier: string;
  display_name: string | null;
  service_name: string | null;
  participants: string[];
  /** Raw handle identifiers (phone/email) parallel to participants */
  participant_handles: string[];
  last_message_date: string | null;
  last_message_text: string | null;
}

export interface Attachment {
  rowid: number;
  filename: string | null;
  mime_type: string | null;
  transfer_name: string | null;
  total_bytes: number;
  is_sticker: boolean;
}

export interface Reaction {
  reaction_type: string;
  sender: string | null;
  is_from_me: boolean;
  date: string;
}

export interface Message {
  rowid: number;
  guid: string;
  text: string | null;
  is_from_me: boolean;
  date: string;
  date_read: string | null;
  sender: string | null;
  /** Raw handle identifier (phone/email) for the sender */
  sender_handle: string | null;
  service: string | null;
  associated_message_type: number | null;
  associated_message_guid: string | null;
  num_attachments: number;
  attachments: Attachment[];
  reactions: Reaction[];
  reply_to_guid: string | null;
  reply_to_part: string | null;
  num_replies: number;
  is_tapback: boolean;
}

export interface PaginatedMessages {
  messages: Message[];
  has_more: boolean;
  has_previous: boolean;
}

export interface DateRange {
  start?: string;
  end?: string;
}

export interface SearchResult {
  rowid: number;
  guid: string;
  text: string | null;
  is_from_me: boolean;
  date: string;
  sender: string | null;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
}

export type SidebarMode = "chats" | "search" | "timeline";

export interface PerChatSearchUiState {
  searchQuery: string;
  dateRange: DateRange;
  scopeAll: boolean;
}

export interface PerChatTimelineUiState {
  view: "topics_list" | "topic_detail";
  topicQuery: string;
  selectedTopicId: number | null;
  selectedDetailNodeId: number | null;
  expandedSubtopicIds: Record<number, boolean>;
  selectedOccurrenceIdxByNode: Record<number, number>;
}

export interface WorkspaceLayoutState {
  contextPaneWidth: number;
}

export type TimelineLevel = 0 | 1 | 2;

export interface TimelineNode {
  id: number;
  chat_id: number;
  level: TimelineLevel;
  parent_id: number | null;
  ordinal: number;
  start_rowid: number;
  end_rowid: number;
  representative_rowid: number;
  start_ts: string;
  end_ts: string;
  title: string;
  summary: string;
  keywords: string[];
  message_count: number;
  media_count: number;
  reaction_count: number;
  reply_count: number;
  confidence: number;
  ai_rationale: string | null;
  source_batch_id: string | null;
  is_draft: boolean;
}

export interface TimelineNodeList {
  nodes: TimelineNode[];
}

export interface TimelineOccurrence {
  id: number;
  node_id: number;
  ordinal: number;
  start_rowid: number;
  end_rowid: number;
  representative_rowid: number;
  start_ts: string;
  end_ts: string;
  message_count: number;
  media_count: number;
  reaction_count: number;
  reply_count: number;
}

export interface TimelineOccurrenceList {
  occurrences: TimelineOccurrence[];
}

export type TimelineNodeMessageScope = "all_occurrences" | "single_occurrence";

export interface TimelineLevelCounts {
  level_0: number;
  level_1: number;
  level_2: number;
}

export interface TimelineOverview {
  chat_id: number;
  indexed: boolean;
  source_max_rowid: number;
  indexed_max_rowid: number;
  earliest_ts: string | null;
  latest_ts: string | null;
  level_counts: TimelineLevelCounts;
  media_caption_coverage: number;
  index_health: "complete" | "partial" | "failed" | "stale";
  last_successful_run_at: string | null;
}

export interface TimelineJobState {
  chat_id: number;
  status: "idle" | "running" | "canceling" | "completed" | "failed" | "canceled";
  phase:
    | "idle"
    | "loading"
    | "image-enrichment"
    | "l0-generation"
    | "l1-aggregate"
    | "l2-aggregate"
    | "persist"
    | "canceling"
    | "finalizing";
  progress: number;
  processed_messages: number;
  total_messages: number;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  error: string | null;
  openai_used: boolean;
  degraded: boolean;
  failed_batches: number;
  completed_batches: number;
  run_id: string | null;
}
