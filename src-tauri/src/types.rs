use serde::{Deserialize, Serialize};

// ── API Response Types ──────────────────────────────────────────────────────

#[derive(Serialize, Clone)]
pub struct ChatResponse {
    pub id: i32,
    pub chat_identifier: String,
    pub display_name: Option<String>,
    pub service_name: Option<String>,
    pub participants: Vec<String>,
    pub participant_handles: Vec<String>,
    pub last_message_date: Option<String>,
    pub last_message_text: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct AttachmentResponse {
    pub rowid: i32,
    pub filename: Option<String>,
    pub mime_type: Option<String>,
    pub transfer_name: Option<String>,
    pub total_bytes: i64,
    pub is_sticker: bool,
}

#[derive(Serialize, Clone)]
pub struct ReactionResponse {
    pub reaction_type: String,
    pub sender: Option<String>,
    pub is_from_me: bool,
    pub date: String,
}

#[derive(Serialize, Clone)]
pub struct MessageResponse {
    pub rowid: i32,
    pub guid: String,
    pub text: Option<String>,
    pub is_from_me: bool,
    pub date: String,
    pub date_read: Option<String>,
    pub sender: Option<String>,
    pub sender_handle: Option<String>,
    pub service: Option<String>,
    pub associated_message_type: Option<i32>,
    pub associated_message_guid: Option<String>,
    pub num_attachments: i32,
    pub attachments: Vec<AttachmentResponse>,
    pub reactions: Vec<ReactionResponse>,
    pub reply_to_guid: Option<String>,
    pub reply_to_part: Option<String>,
    pub num_replies: i32,
    pub is_tapback: bool,
}

#[derive(Serialize)]
pub struct PaginatedMessages {
    pub messages: Vec<MessageResponse>,
    pub has_more: bool,
    pub has_previous: bool,
}

// ── Query Parameters ────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct MessageParams {
    pub start: Option<String>,
    pub end: Option<String>,
    pub before_rowid: Option<i32>,
    pub after_rowid: Option<i32>,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
pub struct SearchParams {
    pub q: String,
    pub start: Option<String>,
    pub end: Option<String>,
    pub limit: Option<usize>,
}

// ── Search Response Types ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct SearchResult {
    pub rowid: i32,
    pub guid: String,
    pub text: Option<String>,
    pub is_from_me: bool,
    pub date: String,
    pub sender: Option<String>,
}

#[derive(Serialize)]
pub struct SearchResponse {
    pub results: Vec<SearchResult>,
    pub total: usize,
}

// ── Attachment Resolution ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ResolvedAttachment {
    pub path: String,
    pub mime_type: String,
    pub filename: String,
}
