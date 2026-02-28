use serde::{Deserialize, Serialize};

pub const TIMELINE_SCHEMA_VERSION: i32 = 5;
pub const TIMELINE_PROMPT_VERSION: i32 = 6;

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineNodeResponse {
    pub id: i64,
    pub chat_id: i32,
    /// L0 = moments (finest), L1 = contiguous subtopics, L2 = broad topics.
    pub level: u8,
    pub parent_id: Option<i64>,
    pub ordinal: i32,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub start_ts: String,
    pub end_ts: String,
    pub title: String,
    pub summary: String,
    pub keywords: Vec<String>,
    pub message_count: i32,
    pub media_count: i32,
    pub reaction_count: i32,
    pub reply_count: i32,
    pub confidence: f32,
    pub ai_rationale: Option<String>,
    pub source_batch_id: Option<String>,
    pub is_draft: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineNodeList {
    pub nodes: Vec<TimelineNodeResponse>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineNodeOccurrenceResponse {
    pub id: i64,
    pub node_id: i64,
    pub ordinal: i32,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub start_ts: String,
    pub end_ts: String,
    pub message_count: i32,
    pub media_count: i32,
    pub reaction_count: i32,
    pub reply_count: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineNodeOccurrenceList {
    pub occurrences: Vec<TimelineNodeOccurrenceResponse>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TimelineLevelCounts {
    pub level_0: i32,
    pub level_1: i32,
    pub level_2: i32,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct TimelineOverview {
    pub chat_id: i32,
    pub indexed: bool,
    pub source_max_rowid: i32,
    pub indexed_max_rowid: i32,
    pub earliest_ts: Option<String>,
    pub latest_ts: Option<String>,
    pub level_counts: TimelineLevelCounts,
    pub media_caption_coverage: f32,
    pub index_health: String,
    pub last_successful_run_at: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TimelineJobState {
    pub chat_id: i32,
    pub status: String,
    pub phase: String,
    pub progress: f32,
    pub processed_messages: i32,
    pub total_messages: i32,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
    pub finished_at: Option<String>,
    pub error: Option<String>,
    pub openai_used: bool,
    pub degraded: bool,
    pub failed_batches: i32,
    pub completed_batches: i32,
    pub run_id: Option<String>,
}

impl TimelineJobState {
    pub fn idle(chat_id: i32) -> Self {
        Self {
            chat_id,
            status: "idle".to_string(),
            phase: "idle".to_string(),
            progress: 0.0,
            processed_messages: 0,
            total_messages: 0,
            started_at: None,
            updated_at: None,
            finished_at: None,
            error: None,
            openai_used: false,
            degraded: false,
            failed_batches: 0,
            completed_batches: 0,
            run_id: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TimelineMetaRecord {
    pub chat_id: i32,
    pub schema_version: i32,
    pub source_max_rowid: i32,
    pub indexed_max_rowid: i32,
    pub indexed_at: Option<String>,
    pub openai_used: bool,
    pub last_error: Option<String>,
    pub prompt_version: i32,
    pub index_health: String,
    pub last_successful_run_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TimelineNodeInsert {
    pub temp_id: i64,
    pub chat_id: i32,
    /// L0 = moments (finest), L1 = contiguous subtopics, L2 = broad topics.
    pub level: u8,
    pub parent_temp_id: Option<i64>,
    pub ordinal: i32,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub start_ts: String,
    pub end_ts: String,
    pub title: String,
    pub summary: String,
    pub keywords: Vec<String>,
    pub message_count: i32,
    pub media_count: i32,
    pub reaction_count: i32,
    pub reply_count: i32,
    pub confidence: f32,
    pub ai_rationale: Option<String>,
    pub source_batch_id: Option<String>,
    pub is_draft: bool,
}

#[derive(Clone, Debug)]
pub struct TimelineEvidenceInsert {
    pub node_temp_id: i64,
    pub rowid: i32,
    pub reason: String,
    pub weight: f32,
}

#[derive(Clone, Debug)]
pub struct TimelineMediaInsightInsert {
    pub chat_id: i32,
    pub message_rowid: i32,
    pub attachment_rowid: i32,
    pub mime_type: String,
    pub caption: String,
    pub model: String,
    pub created_at: String,
}

#[derive(Clone, Debug)]
pub struct TimelineNodeLinkInsert {
    pub source_temp_id: i64,
    pub target_temp_id: i64,
    pub link_type: String,
    pub weight: f32,
    pub rationale: String,
}

#[derive(Clone, Debug)]
pub struct TimelineMemoryInsert {
    pub memory_id: String,
    pub chat_id: i32,
    pub memory_type: String,
    pub summary: String,
    pub confidence: f32,
    pub first_seen_rowid: i32,
    pub last_seen_rowid: i32,
    pub support_rowids: Vec<i32>,
    pub updated_at: String,
}

#[derive(Clone, Debug)]
pub struct TimelineNodeMemoryLinkInsert {
    pub node_temp_id: i64,
    pub memory_id: String,
    pub weight: f32,
}

#[derive(Clone, Debug)]
pub struct TimelineNodeOccurrenceInsert {
    pub node_temp_id: i64,
    pub ordinal: i32,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub start_ts: String,
    pub end_ts: String,
    pub message_count: i32,
    pub media_count: i32,
    pub reaction_count: i32,
    pub reply_count: i32,
}

#[derive(Clone, Debug)]
pub struct TimelineNodeMembershipInsert {
    pub parent_temp_id: i64,
    pub child_temp_id: i64,
    pub weight: f32,
    pub reason: Option<String>,
}

#[derive(Clone, Debug)]
pub struct TimelineBatchRecord {
    pub batch_id: String,
    pub run_id: String,
    pub seq: i32,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub status: String,
    pub retry_count: i32,
    pub error: Option<String>,
    pub completed_at: Option<String>,
}
