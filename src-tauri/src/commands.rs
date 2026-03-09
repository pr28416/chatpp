use std::collections::BTreeSet;
use std::collections::HashMap;

use crate::assistant_bridge;
use crate::db;
use crate::state::AppState;
use crate::timeline_db;
use crate::timeline_indexer;
use crate::timeline_types::{
    TimelineJobState, TimelineNodeList, TimelineNodeOccurrenceList, TimelineOverview,
};
use crate::types::*;
use uuid::Uuid;

#[tauri::command]
pub fn start_window_drag(window: tauri::Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

fn reconcile_stale_timeline_job_state(
    state: &AppState,
    conn: &rusqlite::Connection,
    mut current: TimelineJobState,
) -> Result<TimelineJobState, String> {
    let is_running = state
        .running_timeline_jobs
        .lock()
        .map_err(|_| "Failed to lock running timeline jobs".to_string())?
        .contains(&current.chat_id);

    if is_running || !matches!(current.status.as_str(), "running" | "canceling") {
        return Ok(current);
    }

    if let Ok(mut canceled) = state.cancel_timeline_jobs.lock() {
        canceled.remove(&current.chat_id);
    }

    if current.status == "canceling" {
        current.status = "canceled".to_string();
        current.phase = "finalizing".to_string();
        current.error = Some("Canceled by user".to_string());
    } else {
        current.status = "failed".to_string();
        current.phase = "failed".to_string();
        current.error = Some("Timeline indexing stopped unexpectedly; previous worker is no longer running".to_string());
    }

    let now = timeline_db::now_iso();
    current.updated_at = Some(now.clone());
    current.finished_at = Some(now);
    let job_id = current
        .run_id
        .clone()
        .unwrap_or_else(|| format!("reconciled-{}", Uuid::new_v4()));
    timeline_db::set_job_state(conn, &current, &job_id).map_err(|e| e.to_string())?;
    Ok(current)
}

#[tauri::command]
pub fn get_chats(state: tauri::State<'_, AppState>) -> Result<Vec<ChatResponse>, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    db::get_chats(
        &db,
        &state.chat_participants,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_messages(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    start: Option<String>,
    end: Option<String>,
    before_rowid: Option<i32>,
    after_rowid: Option<i32>,
    limit: Option<usize>,
    fast_initial: Option<bool>,
) -> Result<PaginatedMessages, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let params = MessageParams {
        start,
        end,
        before_rowid,
        after_rowid,
        limit,
        fast_initial,
    };
    let effective_limit = params.limit.unwrap_or(10);

    db::query_messages(
        &db,
        chat_id,
        &params,
        effective_limit,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_message_by_chat_rowid(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    rowid: i32,
) -> Result<Option<MessageResponse>, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    db::get_message_by_chat_rowid(&db, chat_id, rowid, &state.handles, &state.contact_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn search_messages(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    q: String,
    start: Option<String>,
    end: Option<String>,
    limit: Option<usize>,
) -> Result<SearchResponse, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let params = SearchParams {
        q,
        start,
        end,
        limit,
    };

    db::search_messages(&db, chat_id, &params, &state.handles, &state.contact_names)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_handles(state: tauri::State<'_, AppState>) -> HashMap<i32, String> {
    state.handles.clone()
}

#[tauri::command]
pub fn get_contacts(state: tauri::State<'_, AppState>) -> HashMap<String, String> {
    state.contact_names.clone()
}

#[tauri::command]
pub fn get_contact_photo(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let normalized = if id.contains('@') {
        id.to_lowercase()
    } else {
        let digits: String = id.chars().filter(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() {
            return Ok(None);
        }
        match digits.len() {
            10 => format!("+1{}", digits),
            11 if digits.starts_with('1') => format!("+{}", digits),
            _ => format!("+{}", digits),
        }
    };

    let (db_path, zpk) = match state.contact_photos.get(&normalized) {
        Some(info) => info.clone(),
        None => return Ok(None),
    };

    let jpeg_data = db::load_contact_photo(&db_path, zpk).map_err(|e| e.to_string())?;

    match jpeg_data {
        Some(data) => {
            use base64::Engine;
            Ok(Some(
                base64::engine::general_purpose::STANDARD.encode(&data),
            ))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn resolve_attachment(
    state: tauri::State<'_, AppState>,
    id: i32,
) -> Result<ResolvedAttachment, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let attachment = db::get_attachment_by_id(&db, id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Attachment not found".to_string())?;

    use imessage_database::util::platform::Platform;
    let file_path = attachment
        .resolved_attachment_path(&Platform::macOS, &state.db_path, None)
        .ok_or_else(|| "Attachment file path not found".to_string())?;

    let mime = attachment
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let filename = attachment
        .transfer_name
        .clone()
        .or_else(|| attachment.filename().map(|s| s.to_string()))
        .unwrap_or_else(|| "attachment".to_string());

    if is_heic(&mime, &file_path) {
        let jpeg_path = convert_heic_to_jpeg(&file_path, id)?;
        let jpg_name = if let Some((stem, _)) = filename.rsplit_once('.') {
            format!("{}.jpg", stem)
        } else {
            format!("{}.jpg", filename)
        };
        Ok(ResolvedAttachment {
            path: jpeg_path,
            mime_type: "image/jpeg".to_string(),
            filename: jpg_name,
        })
    } else {
        Ok(ResolvedAttachment {
            path: file_path,
            mime_type: mime,
            filename,
        })
    }
}

pub fn is_heic(mime: &str, file_path: &str) -> bool {
    let m = mime.to_lowercase();
    if m == "image/heic"
        || m == "image/heif"
        || m == "image/heic-sequence"
        || m == "image/heif-sequence"
    {
        return true;
    }
    let lower = file_path.to_lowercase();
    lower.ends_with(".heic") || lower.ends_with(".heif")
}

pub fn convert_heic_to_jpeg(source: &str, attachment_id: i32) -> Result<String, String> {
    let cache_dir = std::env::temp_dir().join("imessage_search_heic_cache");
    std::fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed to create HEIC cache dir: {}", e))?;

    let dest = cache_dir.join(format!("{}.jpg", attachment_id));

    if dest.exists() {
        return Ok(dest.to_string_lossy().to_string());
    }

    let output = std::process::Command::new("sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "80",
            source,
            "--out",
        ])
        .arg(&dest)
        .output()
        .map_err(|e| format!("Failed to run sips: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("sips conversion failed: {}", stderr));
    }

    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn start_timeline_index(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    full_rebuild: Option<bool>,
    resume_failed_only: Option<bool>,
) -> Result<TimelineJobState, String> {
    start_timeline_index_impl(
        &state,
        chat_id,
        full_rebuild.unwrap_or(false),
        resume_failed_only.unwrap_or(false),
    )
}

pub fn start_timeline_index_impl(
    state: &AppState,
    chat_id: i32,
    full_rebuild: bool,
    resume_failed_only: bool,
) -> Result<TimelineJobState, String> {
    eprintln!(
        "[timeline-cmd] start chat_id={} full_rebuild={} resume_failed_only={}",
        chat_id, full_rebuild, resume_failed_only
    );

    {
        let mut running = state
            .running_timeline_jobs
            .lock()
            .map_err(|_| "Failed to lock running timeline jobs".to_string())?;
        if running.contains(&chat_id) {
            let conn = timeline_db::open_rw(&state.timeline_db_path).map_err(|e| e.to_string())?;
            return timeline_db::get_job_state(&conn, chat_id).map_err(|e| e.to_string());
        }
        running.insert(chat_id);
    }

    if let Ok(mut canceled) = state.cancel_timeline_jobs.lock() {
        canceled.remove(&chat_id);
    }

    let mut conn = match timeline_db::open_rw(&state.timeline_db_path) {
        Ok(c) => c,
        Err(e) => {
            if let Ok(mut running) = state.running_timeline_jobs.lock() {
                running.remove(&chat_id);
            }
            return Err(e.to_string());
        }
    };

    let job_id = Uuid::new_v4().to_string();
    let mut initial_state = TimelineJobState::idle(chat_id);
    initial_state.status = "running".to_string();
    initial_state.phase = "scanning".to_string();
    initial_state.progress = 0.01;
    initial_state.started_at = Some(timeline_db::now_iso());
    initial_state.updated_at = Some(timeline_db::now_iso());

    if let Err(e) = timeline_db::set_job_state(&mut conn, &initial_state, &job_id) {
        if let Ok(mut running) = state.running_timeline_jobs.lock() {
            running.remove(&chat_id);
        }
        return Err(format!("Failed to persist job state: {}", e));
    }

    let source_db_path = state.db_path.clone();
    let timeline_db_path = state.timeline_db_path.clone();
    let contact_names = state.contact_names.clone();
    let running_jobs = state.running_timeline_jobs.clone();
    let cancel_jobs = state.cancel_timeline_jobs.clone();

    std::thread::spawn(move || {
        timeline_indexer::run_timeline_index_job(
            source_db_path,
            timeline_db_path,
            contact_names,
            running_jobs,
            cancel_jobs,
            timeline_indexer::TimelineRunConfig {
                chat_id,
                full_rebuild,
                resume_failed_only,
            },
        );
    });

    Ok(initial_state)
}

#[tauri::command]
pub fn cancel_timeline_index(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    cancel_timeline_index_impl(&state, chat_id)
}

pub fn cancel_timeline_index_impl(
    state: &AppState,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    eprintln!("[timeline-cmd] cancel chat_id={}", chat_id);
    let is_running = state
        .running_timeline_jobs
        .lock()
        .map_err(|_| "Failed to lock running jobs".to_string())?
        .contains(&chat_id);

    let conn = timeline_db::open_rw(&state.timeline_db_path).map_err(|e| e.to_string())?;
    let mut current = timeline_db::get_job_state(&conn, chat_id).map_err(|e| e.to_string())?;
    current = reconcile_stale_timeline_job_state(state, &conn, current)?;

    let terminal = matches!(
        current.status.as_str(),
        "completed" | "failed" | "canceled" | "idle"
    );
    if terminal {
        if let Ok(mut canceled) = state.cancel_timeline_jobs.lock() {
            canceled.remove(&chat_id);
        }
        return Ok(current);
    }

    if is_running && current.status == "running" {
        let mut canceled = state
            .cancel_timeline_jobs
            .lock()
            .map_err(|_| "Failed to lock cancel jobs".to_string())?;
        canceled.insert(chat_id);

        current.status = "canceling".to_string();
        current.phase = "canceling".to_string();
        current.updated_at = Some(timeline_db::now_iso());
        if current.error.is_none() {
            current.error = Some("Cancel requested".to_string());
        }
        let job_id = current
            .run_id
            .clone()
            .unwrap_or_else(|| format!("cancel-{}", Uuid::new_v4()));
        timeline_db::set_job_state(&conn, &current, &job_id).map_err(|e| e.to_string())?;
        return Ok(current);
    }

    Ok(current)
}

#[tauri::command]
pub fn get_timeline_index_state(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    get_timeline_index_state_impl(&state, chat_id)
}

pub fn get_timeline_index_state_impl(
    state: &AppState,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    eprintln!("[timeline-cmd] get_state chat_id={}", chat_id);
    let conn = timeline_db::open_rw(&state.timeline_db_path).map_err(|e| e.to_string())?;
    let current = timeline_db::get_job_state(&conn, chat_id).map_err(|e| e.to_string())?;
    reconcile_stale_timeline_job_state(state, &conn, current)
}

#[tauri::command]
pub fn get_timeline_nodes(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    level: u8,
    parent_node_id: Option<i64>,
) -> Result<TimelineNodeList, String> {
    get_timeline_nodes_impl(&state, chat_id, level, parent_node_id)
}

pub fn get_timeline_nodes_impl(
    state: &AppState,
    chat_id: i32,
    level: u8,
    parent_node_id: Option<i64>,
) -> Result<TimelineNodeList, String> {
    eprintln!(
        "[timeline-cmd] get_nodes chat_id={} level={} parent_node_id={:?}",
        chat_id, level, parent_node_id
    );
    if level > 2 {
        return Err("Level 3 is deprecated".to_string());
    }

    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    timeline_db::get_nodes(&conn, chat_id, level, parent_node_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_timeline_node_occurrences(
    state: tauri::State<'_, AppState>,
    node_id: i64,
) -> Result<TimelineNodeOccurrenceList, String> {
    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    timeline_db::get_node_occurrences(&conn, node_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_timeline_group_children(
    state: tauri::State<'_, AppState>,
    node_id: i64,
    child_level: u8,
) -> Result<TimelineNodeList, String> {
    if child_level > 2 {
        return Err("Level 3 is deprecated".to_string());
    }
    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    timeline_db::get_group_children(&conn, node_id, child_level).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_timeline_overview(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
) -> Result<TimelineOverview, String> {
    get_timeline_overview_impl(&state, chat_id)
}

pub fn get_timeline_overview_impl(
    state: &AppState,
    chat_id: i32,
) -> Result<TimelineOverview, String> {
    eprintln!("[timeline-cmd] get_overview chat_id={}", chat_id);
    let conn = timeline_db::open_rw(&state.timeline_db_path).map_err(|e| e.to_string())?;
    let mut overview = timeline_db::get_overview(&conn, chat_id).map_err(|e| e.to_string())?;
    overview.source_max_rowid = query_source_max_rowid(&state.db_path, chat_id)?;
    Ok(overview)
}

#[tauri::command]
pub fn get_timeline_related_nodes(
    state: tauri::State<'_, AppState>,
    node_id: i64,
    limit: Option<i32>,
) -> Result<TimelineNodeList, String> {
    get_timeline_related_nodes_impl(&state, node_id, limit)
}

pub fn get_timeline_related_nodes_impl(
    state: &AppState,
    node_id: i64,
    limit: Option<i32>,
) -> Result<TimelineNodeList, String> {
    eprintln!(
        "[timeline-cmd] get_related_nodes node_id={} limit={}",
        node_id,
        limit.unwrap_or(8)
    );
    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    timeline_db::get_related_nodes(&conn, node_id, limit.unwrap_or(8).clamp(1, 24))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn retry_timeline_failed_batches(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    retry_timeline_failed_batches_impl(&state, chat_id)
}

pub fn retry_timeline_failed_batches_impl(
    state: &AppState,
    chat_id: i32,
) -> Result<TimelineJobState, String> {
    eprintln!("[timeline-cmd] retry_failed chat_id={}", chat_id);
    start_timeline_index_impl(state, chat_id, false, true)
}

#[tauri::command]
pub fn jump_anchor_context(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    rowid: i32,
    window: Option<usize>,
) -> Result<PaginatedMessages, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let win = window.unwrap_or(80).max(10);
    let half = (win / 2) as i32;
    let after = rowid.saturating_sub(half + 1);

    let params = MessageParams {
        start: None,
        end: None,
        before_rowid: None,
        after_rowid: Some(after),
        limit: Some(win),
        fast_initial: Some(false),
    };

    db::query_messages(
        &db,
        chat_id,
        &params,
        win,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_timeline_node_message_rowids(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    start_rowid: i32,
    end_rowid: i32,
    limit: Option<i32>,
) -> Result<Vec<i32>, String> {
    let db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let effective_limit = limit.unwrap_or(5000).clamp(1, 20000);
    let start = start_rowid.min(end_rowid);
    let end = start_rowid.max(end_rowid);

    let mut stmt = db
        .prepare(
            "SELECT m.ROWID
             FROM message m
             JOIN chat_message_join c ON c.message_id = m.ROWID
             WHERE c.chat_id = ?1
               AND m.ROWID BETWEEN ?2 AND ?3
               AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
             ORDER BY m.ROWID ASC
             LIMIT ?4",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(
            rusqlite::params![chat_id, start, end, effective_limit],
            |row| row.get::<_, i32>(0),
        )
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

#[tauri::command]
pub fn get_timeline_node_message_rowids_by_node(
    state: tauri::State<'_, AppState>,
    chat_id: i32,
    node_id: i64,
    scope: Option<String>,
    occurrence_ordinal: Option<i32>,
    limit: Option<i32>,
) -> Result<Vec<i32>, String> {
    let source_db = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let timeline_conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;

    let effective_limit = limit.unwrap_or(5000).clamp(1, 20000) as usize;
    let selected_scope = scope.unwrap_or_else(|| "all_occurrences".to_string());

    let occurrences = timeline_db::get_node_occurrences(&timeline_conn, node_id)
        .map_err(|e| e.to_string())?
        .occurrences;

    let ranges: Vec<(i32, i32)> = if occurrences.is_empty() {
        let mut stmt = timeline_conn
            .prepare("SELECT start_rowid, end_rowid FROM timeline_nodes WHERE id = ?1")
            .map_err(|e| e.to_string())?;
        let mut rows = stmt.query([node_id]).map_err(|e| e.to_string())?;
        if let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let start: i32 = row.get(0).map_err(|e| e.to_string())?;
            let end: i32 = row.get(1).map_err(|e| e.to_string())?;
            vec![(start.min(end), start.max(end))]
        } else {
            Vec::new()
        }
    } else if selected_scope == "single_occurrence" {
        let ordinal = occurrence_ordinal
            .ok_or_else(|| "occurrence_ordinal is required for single_occurrence".to_string())?;
        let maybe = occurrences.iter().find(|o| o.ordinal == ordinal).map(|o| {
            (
                o.start_rowid.min(o.end_rowid),
                o.start_rowid.max(o.end_rowid),
            )
        });
        maybe.map(|r| vec![r]).ok_or_else(|| {
            format!(
                "Occurrence ordinal {} not found for node {}",
                ordinal, node_id
            )
        })?
    } else {
        occurrences
            .iter()
            .map(|o| {
                (
                    o.start_rowid.min(o.end_rowid),
                    o.start_rowid.max(o.end_rowid),
                )
            })
            .collect()
    };

    if ranges.is_empty() {
        return Ok(Vec::new());
    }

    let mut deduped = BTreeSet::<i32>::new();
    for (start, end) in ranges {
        let mut stmt = source_db
            .prepare(
                "SELECT m.ROWID
                 FROM message m
                 JOIN chat_message_join c ON c.message_id = m.ROWID
                 WHERE c.chat_id = ?1
                   AND m.ROWID BETWEEN ?2 AND ?3
                   AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
                 ORDER BY m.ROWID ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(rusqlite::params![chat_id, start, end], |row| {
                row.get::<_, i32>(0)
            })
            .map_err(|e| e.to_string())?;
        for rowid in rows.flatten() {
            deduped.insert(rowid);
            if deduped.len() >= effective_limit {
                break;
            }
        }
        if deduped.len() >= effective_limit {
            break;
        }
    }

    Ok(deduped.into_iter().take(effective_limit).collect())
}

#[tauri::command]
pub async fn assistant_run_turn(
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    request: AssistantTurnRequest,
) -> Result<AssistantTurnResponse, String> {
    let state_clone = state.inner().clone();
    let app_handle_clone = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        assistant_bridge::run_assistant_turn(&state_clone, &request, &app_handle_clone)
    })
    .await
    .map_err(|e| format!("Assistant task join error: {}", e))?
}

#[tauri::command]
pub fn get_assistant_provider_availability() -> HashMap<String, bool> {
    let mut out = HashMap::new();
    out.insert(
        "openai".to_string(),
        crate::env_config::get_env_var("OPENAI_API_KEY").is_some(),
    );
    out.insert(
        "anthropic".to_string(),
        crate::env_config::get_env_var("ANTHROPIC_API_KEY").is_some(),
    );
    out.insert(
        "google".to_string(),
        crate::env_config::get_env_var("GOOGLE_GENERATIVE_AI_API_KEY").is_some(),
    );
    out.insert(
        "xai".to_string(),
        crate::env_config::get_env_var("XAI_API_KEY").is_some(),
    );
    out
}

fn query_source_max_rowid(db_path: &std::path::Path, chat_id: i32) -> Result<i32, String> {
    let db =
        rusqlite::Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;

    db.query_row(
        "SELECT COALESCE(MAX(m.ROWID), 0)
         FROM message m
         JOIN chat_message_join c ON c.message_id = m.ROWID
         WHERE c.chat_id = ?1",
        [chat_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod smoke_tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::{Duration, Instant};

    fn load_env_files_for_test() {
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let candidates = [cwd.join(".env"), cwd.join("src-tauri").join(".env")];
        for path in candidates {
            if path.exists() {
                let _ = dotenvy::from_path(path);
            }
        }
    }

    fn make_test_state() -> AppState {
        let timeline_db_path = std::env::temp_dir().join(format!(
            "chatpp-timeline-test-{}.db",
            Uuid::new_v4()
        ));
        crate::timeline_db::init_timeline_db(&timeline_db_path).expect("init test timeline db");
        AppState {
            db_path: PathBuf::from("/tmp/chat.db"),
            timeline_db_path,
            handles: HashMap::new(),
            chat_participants: HashMap::new(),
            contact_names: HashMap::new(),
            contact_photos: HashMap::new(),
            running_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
            cancel_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
        }
    }

    #[test]
    fn get_timeline_state_reconciles_stale_canceling_job() {
        let state = make_test_state();
        let mut conn = crate::timeline_db::open_rw(&state.timeline_db_path).expect("open timeline db");
        let mut job = TimelineJobState::idle(42);
        job.status = "canceling".to_string();
        job.phase = "canceling".to_string();
        job.progress = 0.25;
        job.run_id = Some("run-42".to_string());
        crate::timeline_db::set_job_state(&mut conn, &job, "job-42").expect("persist job");

        let next = get_timeline_index_state_impl(&state, 42).expect("get reconciled state");

        assert_eq!(next.status, "canceled");
        assert_eq!(next.phase, "finalizing");
        assert_eq!(next.error.as_deref(), Some("Canceled by user"));
        assert!(next.finished_at.is_some());
    }

    #[test]
    fn get_timeline_state_reconciles_stale_running_job() {
        let state = make_test_state();
        let mut conn = crate::timeline_db::open_rw(&state.timeline_db_path).expect("open timeline db");
        let mut job = TimelineJobState::idle(43);
        job.status = "running".to_string();
        job.phase = "image-enrichment".to_string();
        job.progress = 0.10;
        job.run_id = Some("run-43".to_string());
        crate::timeline_db::set_job_state(&mut conn, &job, "job-43").expect("persist job");

        let next = get_timeline_index_state_impl(&state, 43).expect("get reconciled state");

        assert_eq!(next.status, "failed");
        assert_eq!(next.phase, "failed");
        assert_eq!(
            next.error.as_deref(),
            Some("Timeline indexing stopped unexpectedly; previous worker is no longer running")
        );
        assert!(next.finished_at.is_some());
    }

    #[test]
    #[ignore]
    fn timeline_endpoint_smoke_loop() {
        load_env_files_for_test();
        let state = crate::state::init_app_state();

        let chat_id = std::env::var("TIMELINE_SMOKE_CHAT_ID")
            .ok()
            .and_then(|v| v.parse::<i32>().ok())
            .unwrap_or(1592);
        let max_wait_secs = std::env::var("TIMELINE_SMOKE_WAIT_SECS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(180);

        let overview_before =
            get_timeline_overview_impl(&state, chat_id).expect("overview before should work");
        eprintln!(
            "[timeline-smoke] before chat={} indexed={} health={} source_max={} indexed_max={}",
            chat_id,
            overview_before.indexed,
            overview_before.index_health,
            overview_before.source_max_rowid,
            overview_before.indexed_max_rowid
        );

        let started =
            start_timeline_index_impl(&state, chat_id, false, false).expect("start should work");
        eprintln!(
            "[timeline-smoke] started status={} phase={} run_id={:?}",
            started.status, started.phase, started.run_id
        );

        thread::sleep(Duration::from_secs(2));
        let canceled = cancel_timeline_index_impl(&state, chat_id).expect("cancel should work");
        eprintln!(
            "[timeline-smoke] cancel status={} phase={} error={:?}",
            canceled.status, canceled.phase, canceled.error
        );

        let cancel_deadline = Instant::now() + Duration::from_secs(40);
        loop {
            let state_now =
                get_timeline_index_state_impl(&state, chat_id).expect("state poll after cancel");
            eprintln!(
                "[timeline-smoke] post-cancel status={} phase={} progress={:.2}",
                state_now.status, state_now.phase, state_now.progress
            );
            if state_now.status != "running" && state_now.status != "canceling" {
                break;
            }
            assert!(
                Instant::now() < cancel_deadline,
                "cancel did not settle in time"
            );
            thread::sleep(Duration::from_secs(2));
        }

        let started_retry =
            retry_timeline_failed_batches_impl(&state, chat_id).expect("retry/start should work");
        eprintln!(
            "[timeline-smoke] retry-start status={} phase={} run_id={:?}",
            started_retry.status, started_retry.phase, started_retry.run_id
        );

        let deadline = Instant::now() + Duration::from_secs(max_wait_secs);
        let final_state = loop {
            let s = get_timeline_index_state_impl(&state, chat_id).expect("state should work");
            eprintln!(
                "[timeline-smoke] running status={} phase={} progress={:.2} processed={}/{} failed={} completed={}",
                s.status,
                s.phase,
                s.progress,
                s.processed_messages,
                s.total_messages,
                s.failed_batches,
                s.completed_batches
            );
            if s.status != "running" && s.status != "canceling" {
                break s;
            }
            assert!(
                Instant::now() < deadline,
                "index run exceeded smoke timeout"
            );
            thread::sleep(Duration::from_secs(3));
        };

        eprintln!(
            "[timeline-smoke] final status={} phase={} degraded={} error={:?}",
            final_state.status, final_state.phase, final_state.degraded, final_state.error
        );

        let overview_after =
            get_timeline_overview_impl(&state, chat_id).expect("overview after should work");
        eprintln!(
            "[timeline-smoke] after indexed={} health={} source_max={} indexed_max={}",
            overview_after.indexed,
            overview_after.index_health,
            overview_after.source_max_rowid,
            overview_after.indexed_max_rowid
        );

        let _ = get_timeline_nodes_impl(&state, chat_id, 2, None).expect("nodes level 2");
    }
}
