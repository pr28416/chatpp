use std::collections::HashMap;

use crate::db;
use crate::state::AppState;
use crate::types::*;

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
