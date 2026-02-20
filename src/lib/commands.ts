import { invoke } from "@tauri-apps/api/core";
import type { Chat, PaginatedMessages, SearchResponse } from "./types";

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
  },
): Promise<PaginatedMessages> {
  return invoke("get_messages", {
    chatId,
    start: params.start,
    end: params.end,
    beforeRowid: params.before_rowid,
    afterRowid: params.after_rowid,
    limit: params.limit,
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
