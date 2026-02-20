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
