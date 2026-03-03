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
    pub last_message_preview: Option<String>,
    pub last_message_preview_kind: String,
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
    pub fast_initial: Option<bool>,
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

#[derive(Serialize, Deserialize)]
pub struct AssistantConversationTurn {
    pub role: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AssistantConversationContext {
    pub chat_id: i32,
    pub label: String,
    pub participants: Vec<String>,
}

#[derive(Deserialize)]
pub struct AssistantTurnRequest {
    pub selected_chat_id: Option<i32>,
    pub mentioned_chat_ids: Vec<i32>,
    pub selected_chat_context: Option<AssistantConversationContext>,
    pub mentioned_chat_contexts: Option<Vec<AssistantConversationContext>>,
    pub user_message: String,
    pub stream_id: String,
    pub conversation: Vec<AssistantConversationTurn>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AssistantCitation {
    pub chat_id: i32,
    pub rowid: i32,
    pub label: String,
    pub chat_label: Option<String>,
    pub sender: Option<String>,
    pub date: Option<String>,
    pub message_text: Option<String>,
    pub reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AssistantToolTrace {
    pub tool_name: String,
    pub input: String,
    pub output: String,
}

#[derive(Serialize, Deserialize)]
pub struct AssistantTurnResponse {
    pub text: String,
    pub duration_ms: Option<u64>,
    pub citations: Vec<AssistantCitation>,
    pub tool_traces: Vec<AssistantToolTrace>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct AssistantStreamEvent {
    pub kind: String,
    pub at_ms: u64,
    pub text: Option<String>,
    pub step_index: Option<u32>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub input_preview: Option<String>,
    pub output_preview: Option<String>,
    pub success: Option<bool>,
    pub duration_ms: Option<u64>,
    pub finish_reason: Option<String>,
}
