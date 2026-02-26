import { invoke } from "@tauri-apps/api/core";
import type {
  Chat,
  PaginatedMessages,
  SearchResponse,
  TimelineJobState,
  TimelineLevel,
  TimelineNodeList,
  TimelineOverview,
} from "./types";

export async function fetchChats(): Promise<Chat[]> {
  return invoke("get_chats");
}

export async function fetchMessages(
  chatId: number,
  params: {
    start?: string;
    end?: string;
    before_rowid?: number;
    after_rowid?: number;
    limit?: number;
    fast_initial?: boolean;
  },
): Promise<PaginatedMessages> {
  return invoke("get_messages", {
    chatId,
    start: params.start,
    end: params.end,
    beforeRowid: params.before_rowid,
    afterRowid: params.after_rowid,
    limit: params.limit,
    fastInitial: params.fast_initial,
  });
}

export async function searchMessages(
  chatId: number,
  params: { q: string; start?: string; end?: string },
): Promise<SearchResponse> {
  return invoke("search_messages", {
    chatId,
    q: params.q,
    start: params.start,
    end: params.end,
  });
}

export async function fetchHandles(): Promise<Record<number, string>> {
  return invoke("get_handles");
}

export interface ResolvedAttachment {
  path: string;
  mime_type: string;
  filename: string;
}

export async function resolveAttachment(
  id: number,
): Promise<ResolvedAttachment> {
  return invoke("resolve_attachment", { id });
}

export async function getContactPhoto(id: string): Promise<string | null> {
  return invoke("get_contact_photo", { id });
}

export async function startTimelineIndex(
  chatId: number,
  fullRebuild = false,
  resumeFailedOnly = false,
): Promise<TimelineJobState> {
  return invoke("start_timeline_index", { chatId, fullRebuild, resumeFailedOnly });
}

export async function cancelTimelineIndex(
  chatId: number,
): Promise<TimelineJobState> {
  return invoke("cancel_timeline_index", { chatId });
}

export async function getTimelineIndexState(
  chatId: number,
): Promise<TimelineJobState> {
  return invoke("get_timeline_index_state", { chatId });
}

export async function getTimelineNodes(
  chatId: number,
  level: TimelineLevel,
  parentNodeId?: number | null,
): Promise<TimelineNodeList> {
  return invoke("get_timeline_nodes", { chatId, level, parentNodeId });
}

export async function getTimelineOverview(
  chatId: number,
): Promise<TimelineOverview> {
  return invoke("get_timeline_overview", { chatId });
}

export async function getTimelineRelatedNodes(
  nodeId: number,
  limit = 8,
): Promise<TimelineNodeList> {
  return invoke("get_timeline_related_nodes", { nodeId, limit });
}

export async function retryTimelineFailedBatches(
  chatId: number,
): Promise<TimelineJobState> {
  return invoke("retry_timeline_failed_batches", { chatId });
}

export async function jumpAnchorContext(
  chatId: number,
  rowid: number,
  window = 80,
): Promise<PaginatedMessages> {
  return invoke("jump_anchor_context", { chatId, rowid, window });
}
