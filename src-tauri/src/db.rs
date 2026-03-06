use crate::state::AppState;
use crate::types::*;
use imessage_database::tables::attachment::Attachment;
use imessage_database::tables::messages::Message;
use imessage_database::tables::table::Table;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// Seconds between Unix epoch (1970-01-01) and Apple epoch (2001-01-01).
const APPLE_EPOCH_OFFSET: i64 = 978307200;

/// Apple stores timestamps in nanoseconds on modern macOS.
const NANOSECOND: i64 = 1_000_000_000;

// ── Initialization ──────────────────────────────────────────────────────────

/// Load handles, chat participants, and contacts from disk at startup.
pub fn init_app_state(
    db_path: PathBuf,
    timeline_db_path: PathBuf,
) -> Result<AppState, Box<dyn std::error::Error>> {
    let db = Connection::open_with_flags(&db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let contacts_data = load_contacts();

    let handles = load_handles(&db)?;
    let chat_participants = load_chat_participants(&db, &handles, &contacts_data.names)?;

    Ok(AppState {
        db_path,
        timeline_db_path,
        handles,
        chat_participants,
        contact_names: contacts_data.names,
        contact_photos: contacts_data.photos,
        running_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
        cancel_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
    })
}

// ── Contacts ────────────────────────────────────────────────────────────────

fn normalize_phone(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return String::new();
    }
    match digits.len() {
        10 => format!("+1{}", digits),
        11 if digits.starts_with('1') => format!("+{}", digits),
        _ => format!("+{}", digits),
    }
}

pub fn normalize_handle_identifier(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.contains('@') {
        return trimmed.to_lowercase();
    }
    normalize_phone(trimmed)
}

pub fn resolve_handle_name(
    handle_id: &str,
    contact_names: &HashMap<String, String>,
) -> Option<String> {
    let normalized = normalize_handle_identifier(handle_id);
    if normalized.is_empty() {
        return None;
    }
    contact_names.get(&normalized).cloned()
}

pub struct ContactsData {
    pub names: HashMap<String, String>,
    pub photos: HashMap<String, (PathBuf, i64)>,
}

pub fn load_contacts() -> ContactsData {
    let mut names: HashMap<String, String> = HashMap::new();
    let mut photos: HashMap<String, (PathBuf, i64)> = HashMap::new();

    let home = match std::env::var("HOME") {
        Ok(h) => h,
        Err(_) => return ContactsData { names, photos },
    };

    let base = PathBuf::from(&home).join("Library/Application Support/AddressBook");

    let mut db_paths: Vec<PathBuf> = Vec::new();

    let root_db = base.join("AddressBook-v22.abcddb");
    if root_db.exists() {
        db_paths.push(root_db);
    }

    let sources_dir = base.join("Sources");
    if let Ok(entries) = std::fs::read_dir(&sources_dir) {
        for entry in entries.flatten() {
            let candidate = entry.path().join("AddressBook-v22.abcddb");
            if candidate.exists() {
                db_paths.push(candidate);
            }
        }
    }

    for db_path in db_paths {
        if let Err(e) = load_contacts_from_db(&db_path, &mut names, &mut photos) {
            eprintln!(
                "Warning: failed to load contacts from {}: {}",
                db_path.display(),
                e
            );
        }
    }

    ContactsData { names, photos }
}

fn load_contacts_from_db(
    db_path: &PathBuf,
    contacts: &mut HashMap<String, String>,
    photos: &mut HashMap<String, (PathBuf, i64)>,
) -> Result<(), Box<dyn std::error::Error>> {
    let db = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;

    let mut record_has_photo: HashMap<i64, bool> = HashMap::new();
    {
        let mut stmt = db.prepare(
            "SELECT Z_PK FROM ZABCDRECORD
             WHERE ZTHUMBNAILIMAGEDATA IS NOT NULL AND LENGTH(ZTHUMBNAILIMAGEDATA) > 100",
        )?;
        let rows = stmt.query_map([], |row| row.get::<_, i64>(0))?;
        for row in rows.flatten() {
            record_has_photo.insert(row, true);
        }
    }

    {
        let mut stmt = db.prepare(
            "SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER, r.Z_PK
             FROM ZABCDRECORD r
             JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
             WHERE p.ZFULLNUMBER IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;

        for row in rows.flatten() {
            let (first, last, phone, zpk) = row;
            let name = format_contact_name(first.as_deref(), last.as_deref());
            if name.is_empty() {
                continue;
            }
            let normalized = normalize_phone(&phone);
            if !normalized.is_empty() {
                contacts.entry(normalized.clone()).or_insert(name);
                if record_has_photo.contains_key(&zpk) {
                    photos.entry(normalized).or_insert((db_path.clone(), zpk));
                }
            }
        }
    }

    {
        let mut stmt = db.prepare(
            "SELECT r.ZFIRSTNAME, r.ZLASTNAME, e.ZADDRESS, r.Z_PK
             FROM ZABCDRECORD r
             JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
             WHERE e.ZADDRESS IS NOT NULL",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?;

        for row in rows.flatten() {
            let (first, last, email, zpk) = row;
            let name = format_contact_name(first.as_deref(), last.as_deref());
            if name.is_empty() {
                continue;
            }
            let normalized_email = email.to_lowercase();
            contacts.entry(normalized_email.clone()).or_insert(name);
            if record_has_photo.contains_key(&zpk) {
                photos
                    .entry(normalized_email)
                    .or_insert((db_path.clone(), zpk));
            }
        }
    }

    Ok(())
}

pub fn load_contact_photo(
    db_path: &PathBuf,
    zpk: i64,
) -> Result<Option<Vec<u8>>, Box<dyn std::error::Error + Send + Sync>> {
    let db = Connection::open_with_flags(db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let mut stmt = db.prepare(
        "SELECT ZTHUMBNAILIMAGEDATA FROM ZABCDRECORD WHERE Z_PK = ?1 AND ZTHUMBNAILIMAGEDATA IS NOT NULL",
    )?;
    let result = stmt.query_row([zpk], |row| row.get::<_, Vec<u8>>(0));
    match result {
        Ok(data) => {
            if data.len() > 1 {
                Ok(Some(data[1..].to_vec()))
            } else {
                Ok(None)
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(Box::new(e)),
    }
}

fn format_contact_name(first: Option<&str>, last: Option<&str>) -> String {
    match (first, last) {
        (Some(f), Some(l)) if !f.is_empty() && !l.is_empty() => format!("{} {}", f, l),
        (Some(f), _) if !f.is_empty() => f.to_string(),
        (_, Some(l)) if !l.is_empty() => l.to_string(),
        _ => String::new(),
    }
}

fn load_handles(db: &Connection) -> Result<HashMap<i32, String>, rusqlite::Error> {
    let mut handles = HashMap::new();
    let mut stmt = db.prepare("SELECT ROWID, id FROM handle")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (id, name) = row?;
        handles.insert(id, name);
    }
    Ok(handles)
}

fn load_chat_participants(
    db: &Connection,
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> Result<HashMap<i32, Vec<(String, String)>>, rusqlite::Error> {
    let mut chat_participants: HashMap<i32, Vec<(String, String)>> = HashMap::new();
    let mut stmt = db.prepare("SELECT chat_id, handle_id FROM chat_handle_join")?;
    let rows = stmt.query_map([], |row| Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?)))?;
    for row in rows {
        let (chat_id, handle_id) = row?;
        let raw_handle = handles
            .get(&handle_id)
            .cloned()
            .unwrap_or_else(|| format!("Unknown({})", handle_id));
        let display_name =
            resolve_handle_name(&raw_handle, contact_names).unwrap_or_else(|| raw_handle.clone());
        chat_participants
            .entry(chat_id)
            .or_default()
            .push((display_name, raw_handle));
    }
    Ok(chat_participants)
}

#[derive(Clone)]
struct ChatPreviewMeta {
    rowid: Option<i32>,
    text: Option<String>,
    associated_message_type: Option<i32>,
    item_type: Option<i32>,
    cache_has_attachments: bool,
    attachment_count: i32,
    attachment_mime_type: Option<String>,
    attachment_is_sticker: bool,
}

fn clean_preview_text(raw: Option<&str>) -> Option<String> {
    raw.map(|t| t.replace('\u{FFFC}', "").trim().to_string())
        .filter(|t| !t.is_empty())
}

fn is_reaction_associated_type(associated_message_type: Option<i32>) -> bool {
    matches!(
        associated_message_type,
        Some(2000..=2005) | Some(3000..=3005)
    )
}

fn infer_preview_kind(meta: &ChatPreviewMeta) -> &'static str {
    if meta.rowid.is_none() {
        return "none";
    }

    if is_reaction_associated_type(meta.associated_message_type) {
        return "reaction";
    }

    if meta.attachment_is_sticker || meta.item_type.unwrap_or_default() == 2 {
        return "sticker";
    }

    if meta.attachment_count > 0 || meta.cache_has_attachments {
        if let Some(mime) = meta.attachment_mime_type.as_deref() {
            if mime.starts_with("image/") {
                return "photo";
            }
        }
        return "attachment";
    }

    "message"
}

fn placeholder_for_kind(kind: &str) -> Option<String> {
    match kind {
        "reaction" => Some("Reaction".to_string()),
        "sticker" => Some("Sticker".to_string()),
        "photo" => Some("Photo".to_string()),
        "attachment" => Some("Attachment".to_string()),
        "message" => Some("Message".to_string()),
        _ => None,
    }
}

fn generate_text_preview_for_rowid(db: &Connection, rowid: i32) -> Option<String> {
    let mut stmt = db
        .prepare(
            "SELECT *, c.chat_id,
                    (SELECT COUNT(*) FROM message_attachment_join a WHERE m.ROWID = a.message_id) AS num_attachments,
                    NULL AS deleted_from,
                    0 AS num_replies
             FROM message AS m
             LEFT JOIN chat_message_join AS c ON m.ROWID = c.message_id
             WHERE m.ROWID = ?1
             LIMIT 1",
        )
        .ok()?;
    let row_result = stmt.query_row([rowid], |row| Ok(Message::from_row(row)));
    let Ok(Ok(mut msg)) = row_result else {
        return None;
    };
    if clean_preview_text(msg.text.as_deref()).is_none() {
        let _ = msg.generate_text(db);
    }
    clean_preview_text(msg.text.as_deref())
}

fn derive_chat_preview(db: &Connection, meta: &ChatPreviewMeta) -> (Option<String>, String) {
    if let Some(text) = clean_preview_text(meta.text.as_deref()) {
        return (Some(text), "text".to_string());
    }

    if let Some(rowid) = meta.rowid {
        if let Some(text) = generate_text_preview_for_rowid(db, rowid) {
            return (Some(text), "text".to_string());
        }
    }

    let kind = infer_preview_kind(meta).to_string();
    (placeholder_for_kind(&kind), kind)
}

// ── Chat Queries ────────────────────────────────────────────────────────────

pub fn get_chats(
    db: &Connection,
    participants: &HashMap<i32, Vec<(String, String)>>,
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> Result<Vec<ChatResponse>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = db.prepare(
        "WITH chat_latest AS (
             SELECT c.ROWID AS chat_id,
                    c.chat_identifier,
                    c.display_name,
                    c.service_name,
                    MAX(m.date) AS last_message_date,
                    (SELECT m2.ROWID
                     FROM message m2
                     JOIN chat_message_join cmj2 ON m2.ROWID = cmj2.message_id
                     WHERE cmj2.chat_id = c.ROWID
                     ORDER BY m2.date DESC LIMIT 1) AS latest_message_rowid
             FROM chat c
             LEFT JOIN chat_message_join cmj ON c.ROWID = cmj.chat_id
             LEFT JOIN message m ON cmj.message_id = m.ROWID
             GROUP BY c.ROWID
         )
         SELECT cl.chat_id,
                cl.chat_identifier,
                cl.display_name,
                cl.service_name,
                cl.last_message_date,
                cl.latest_message_rowid,
                lm.text,
                lm.associated_message_type,
                lm.item_type,
                COALESCE(lm.cache_has_attachments, 0),
                (SELECT COUNT(*) FROM message_attachment_join maj WHERE maj.message_id = cl.latest_message_rowid),
                (SELECT a.mime_type
                 FROM attachment a
                 JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                 WHERE maj.message_id = cl.latest_message_rowid
                 ORDER BY a.ROWID DESC
                 LIMIT 1),
                COALESCE((SELECT a.is_sticker
                 FROM attachment a
                 JOIN message_attachment_join maj ON maj.attachment_id = a.ROWID
                 WHERE maj.message_id = cl.latest_message_rowid
                 ORDER BY a.ROWID DESC
                 LIMIT 1), 0)
         FROM chat_latest cl
         LEFT JOIN message lm ON lm.ROWID = cl.latest_message_rowid
         ORDER BY cl.last_message_date DESC",
    )?;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<String>>(3)?,
            row.get::<_, Option<i64>>(4)?,
            row.get::<_, Option<i32>>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<i32>>(7)?,
            row.get::<_, Option<i32>>(8)?,
            row.get::<_, i32>(9)?,
            row.get::<_, i32>(10)?,
            row.get::<_, Option<String>>(11)?,
            row.get::<_, i32>(12)?,
        ))
    })?;

    let mut chats = Vec::new();
    for row in rows {
        let (
            id,
            chat_identifier,
            display_name,
            service_name,
            last_date,
            latest_message_rowid,
            latest_message_text,
            latest_associated_message_type,
            latest_item_type,
            latest_cache_has_attachments,
            latest_attachment_count,
            latest_attachment_mime_type,
            latest_attachment_is_sticker,
        ) = row?;

        let preview_meta = ChatPreviewMeta {
            rowid: latest_message_rowid,
            text: latest_message_text,
            associated_message_type: latest_associated_message_type,
            item_type: latest_item_type,
            cache_has_attachments: latest_cache_has_attachments != 0,
            attachment_count: latest_attachment_count,
            attachment_mime_type: latest_attachment_mime_type,
            attachment_is_sticker: latest_attachment_is_sticker != 0,
        };
        let (last_message_preview, last_message_preview_kind) =
            derive_chat_preview(db, &preview_meta);
        let last_message_text = if last_message_preview_kind == "text" {
            last_message_preview.clone()
        } else {
            None
        };
        let parts = participants.get(&id).cloned().unwrap_or_default();
        let display_names: Vec<String> = parts.iter().map(|(name, _)| name.clone()).collect();
        let raw_handles: Vec<String> = parts.iter().map(|(_, handle)| handle.clone()).collect();
        chats.push(ChatResponse {
            id,
            chat_identifier,
            display_name,
            service_name,
            participants: display_names,
            participant_handles: raw_handles,
            last_message_date: last_date.and_then(apple_timestamp_to_iso),
            last_message_text,
            last_message_preview,
            last_message_preview_kind,
        });
    }

    let missing_ids: Vec<i32> = chats
        .iter()
        .filter(|c| c.participants.is_empty() && c.display_name.is_none())
        .map(|c| c.id)
        .collect();

    if !missing_ids.is_empty() {
        let placeholders: Vec<String> =
            (1..=missing_ids.len()).map(|i| format!("?{}", i)).collect();
        let sql = format!(
            "SELECT cmj.chat_id, m.handle_id
             FROM message m
             JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
             WHERE cmj.chat_id IN ({})
               AND m.handle_id IS NOT NULL
               AND m.handle_id != 0
               AND m.is_from_me = 0
             GROUP BY cmj.chat_id, m.handle_id",
            placeholders.join(",")
        );

        let mut stmt = db.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = missing_ids
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();

        let mut fallback_parts: HashMap<i32, Vec<(String, String)>> = HashMap::new();
        let rows = stmt.query_map(param_refs.as_slice(), |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?))
        })?;

        for row in rows {
            let (chat_id, handle_id) = row?;
            let raw_handle = handles
                .get(&handle_id)
                .cloned()
                .unwrap_or_else(|| format!("Unknown({})", handle_id));
            let display_name = resolve_handle_name(&raw_handle, contact_names)
                .unwrap_or_else(|| raw_handle.clone());
            fallback_parts
                .entry(chat_id)
                .or_default()
                .push((display_name, raw_handle));
        }

        for chat in &mut chats {
            if let Some(parts) = fallback_parts.remove(&chat.id) {
                chat.participants = parts.iter().map(|(name, _)| name.clone()).collect();
                chat.participant_handles = parts.iter().map(|(_, handle)| handle.clone()).collect();
            }
        }
    }

    Ok(chats)
}

// ── Attachment Queries ──────────────────────────────────────────────────────

pub fn get_attachment_by_id(
    db: &Connection,
    attachment_id: i32,
) -> Result<Option<Attachment>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = db.prepare("SELECT * FROM attachment WHERE ROWID = ?1")?;
    let result = stmt.query_row([attachment_id], |row| Ok(Attachment::from_row(row)));
    match result {
        Ok(Ok(att)) => Ok(Some(att)),
        Ok(Err(_)) => Ok(None),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(Box::new(e)),
    }
}

// ── Message Queries ─────────────────────────────────────────────────────────

pub fn query_messages(
    db: &Connection,
    chat_id: i32,
    params: &MessageParams,
    limit: usize,
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> Result<PaginatedMessages, Box<dyn std::error::Error + Send + Sync>> {
    let query_started_at = Instant::now();
    let sql_fetch_ms: u128;
    let enrichment_ms: u128;
    let reaction_ms: u128;

    let has_recovery_table = db
        .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='chat_recoverable_message_join'",
        )
        .and_then(|mut s| s.exists([]))
        .unwrap_or(false);

    let recovery_join = if has_recovery_table {
        "LEFT JOIN chat_recoverable_message_join AS d ON m.ROWID = d.message_id"
    } else {
        ""
    };
    let recovery_col = if has_recovery_table {
        "d.chat_id AS deleted_from"
    } else {
        "NULL AS deleted_from"
    };

    let mut conditions = vec!["c.chat_id = ?1".to_string()];
    let mut sql_params: Vec<i64> = vec![chat_id as i64];
    let mut idx = 2;

    if let Some(start) = &params.start {
        let ts = iso_to_apple_timestamp(start);
        conditions.push(format!("m.date >= ?{}", idx));
        sql_params.push(ts);
        idx += 1;
    }
    if let Some(end) = &params.end {
        let ts = iso_to_apple_timestamp(end);
        conditions.push(format!("m.date <= ?{}", idx));
        sql_params.push(ts);
        idx += 1;
    }

    let needs_reverse;
    if let Some(after_rowid) = params.after_rowid {
        conditions.push(format!("m.ROWID > ?{}", idx));
        sql_params.push(after_rowid as i64);
        needs_reverse = false;
    } else if let Some(before_rowid) = params.before_rowid {
        conditions.push(format!("m.ROWID < ?{}", idx));
        sql_params.push(before_rowid as i64);
        needs_reverse = true;
    } else {
        needs_reverse = true;
    }

    let order = if needs_reverse {
        "ORDER BY m.ROWID DESC"
    } else {
        "ORDER BY m.ROWID ASC"
    };

    let where_clause = conditions.join(" AND ");
    let apply_limit = limit > 0;

    let limit_clause = if apply_limit {
        format!("LIMIT {}", limit + 1)
    } else {
        String::new()
    };

    let effective_order = if !apply_limit {
        "ORDER BY m.ROWID ASC"
    } else {
        order
    };

    let sql = format!(
        "SELECT *, c.chat_id,
            (SELECT COUNT(*) FROM message_attachment_join a WHERE m.ROWID = a.message_id) AS num_attachments,
            {recovery_col},
            0 AS num_replies
        FROM message AS m
        LEFT JOIN chat_message_join AS c ON m.ROWID = c.message_id
        {recovery_join}
        WHERE {where_clause}
        {effective_order}
        {limit_clause}"
    );

    let sql_fetch_started = Instant::now();
    let mut messages: Vec<Message> = {
        let mut stmt = db.prepare(&sql)?;
        let param_refs: Vec<&dyn rusqlite::types::ToSql> = sql_params
            .iter()
            .map(|v| v as &dyn rusqlite::types::ToSql)
            .collect();
        let results = stmt.query_map(param_refs.as_slice(), |row| Ok(Message::from_row(row)))?;

        let mut msgs = Vec::new();
        for result in results {
            match result {
                Ok(Ok(msg)) => msgs.push(msg),
                Ok(Err(e)) => eprintln!("Warning: failed to parse message row: {:?}", e),
                Err(e) => eprintln!("Warning: failed to read row: {:?}", e),
            }
        }
        msgs
    };
    sql_fetch_ms = sql_fetch_started.elapsed().as_millis();

    let has_extra = if apply_limit {
        let extra = messages.len() > limit;
        if extra {
            messages.truncate(limit);
        }
        extra
    } else {
        false
    };

    if apply_limit && needs_reverse {
        messages.reverse();
    }

    let mut responses = Vec::new();
    let mut guid_to_index: HashMap<String, usize> = HashMap::new();

    let enrichment_started = Instant::now();
    for mut msg in messages {
        let has_text = msg
            .text
            .as_ref()
            .map(|t| !t.trim().is_empty())
            .unwrap_or(false);
        if !has_text {
            let _ = msg.generate_text(db);
        }

        let raw_handle = msg.handle_id.and_then(|hid| handles.get(&hid)).cloned();

        let sender = raw_handle.as_ref().map(|handle_id_str| {
            resolve_handle_name(handle_id_str, contact_names)
                .unwrap_or_else(|| handle_id_str.clone())
        });

        let is_tapback = msg.is_tapback();

        let attachments = if !is_tapback && msg.num_attachments > 0 {
            match Attachment::from_message(db, &msg) {
                Ok(atts) => atts
                    .into_iter()
                    .map(|a| AttachmentResponse {
                        rowid: a.rowid,
                        filename: a.filename().map(|s| s.to_string()),
                        mime_type: a.mime_type.clone(),
                        transfer_name: a.transfer_name.clone(),
                        total_bytes: a.total_bytes,
                        is_sticker: a.is_sticker,
                    })
                    .collect(),
                Err(e) => {
                    eprintln!(
                        "Warning: failed to fetch attachments for msg {}: {:?}",
                        msg.rowid, e
                    );
                    Vec::new()
                }
            }
        } else {
            Vec::new()
        };

        let response = MessageResponse {
            rowid: msg.rowid,
            guid: msg.guid.clone(),
            text: msg.text.clone(),
            is_from_me: msg.is_from_me,
            date: apple_timestamp_to_iso(msg.date).unwrap_or_default(),
            date_read: if msg.date_read != 0 {
                apple_timestamp_to_iso(msg.date_read)
            } else {
                None
            },
            sender,
            sender_handle: raw_handle,
            service: msg.service.clone(),
            associated_message_type: msg.associated_message_type,
            associated_message_guid: msg.associated_message_guid.clone(),
            num_attachments: msg.num_attachments,
            attachments,
            reactions: Vec::new(),
            reply_to_guid: msg.thread_originator_guid.clone(),
            reply_to_part: msg.thread_originator_part.clone(),
            num_replies: msg.num_replies,
            is_tapback,
        };

        let idx = responses.len();
        if !is_tapback {
            guid_to_index.insert(msg.guid.clone(), idx);
        }
        responses.push(response);
    }
    enrichment_ms = enrichment_started.elapsed().as_millis();

    let reaction_started = Instant::now();
    let mut reactions_map: HashMap<String, Vec<ReactionResponse>> = HashMap::new();
    let tapback_rowids: Vec<i32> = responses
        .iter()
        .filter(|resp| resp.is_tapback)
        .map(|resp| resp.rowid)
        .collect();
    let tapback_emojis = fetch_tapback_emojis(db, &tapback_rowids);

    for resp in &responses {
        if !resp.is_tapback {
            continue;
        }
        if let Some(ref assoc_guid) = resp.associated_message_guid {
            let target_guid = extract_target_guid(assoc_guid);
            let reaction_type = reaction_type_from_associated(
                resp.associated_message_type,
                tapback_emojis.get(&resp.rowid).map(String::as_str),
            );

            reactions_map
                .entry(target_guid)
                .or_default()
                .push(ReactionResponse {
                    reaction_type,
                    sender: resp.sender.clone(),
                    is_from_me: resp.is_from_me,
                    date: resp.date.clone(),
                });
        }
    }

    let visible_guids: Vec<String> = guid_to_index.keys().cloned().collect();
    let skip_external_reactions = params.fast_initial.unwrap_or(false);
    if !skip_external_reactions && !visible_guids.is_empty() {
        let external_reactions =
            fetch_external_reactions(db, &visible_guids, handles, contact_names);
        for (target_guid, mut ext_reactions) in external_reactions {
            reactions_map
                .entry(target_guid)
                .or_default()
                .append(&mut ext_reactions);
        }
    }

    for (target_guid, reactions) in reactions_map {
        if let Some(&idx) = guid_to_index.get(&target_guid) {
            responses[idx].reactions = reactions;
        }
    }
    reaction_ms = reaction_started.elapsed().as_millis();

    let (has_more, has_previous) = if !apply_limit {
        (false, false)
    } else if params.after_rowid.is_some() {
        (has_extra, true)
    } else if params.before_rowid.is_some() {
        (true, has_extra)
    } else {
        (false, has_extra)
    };

    if cfg!(debug_assertions) {
        eprintln!(
            "[perf][query_messages] chat_id={} fast_initial={} total={}ms sql={}ms enrich={}ms reactions={}ms rows={}",
            chat_id,
            skip_external_reactions,
            query_started_at.elapsed().as_millis(),
            sql_fetch_ms,
            enrichment_ms,
            reaction_ms,
            responses.len()
        );
    }

    Ok(PaginatedMessages {
        messages: responses,
        has_more,
        has_previous,
    })
}

pub fn get_message_by_chat_rowid(
    db: &Connection,
    chat_id: i32,
    rowid: i32,
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> Result<Option<MessageResponse>, Box<dyn std::error::Error + Send + Sync>> {
    let sql = "SELECT *, c.chat_id,
            (SELECT COUNT(*) FROM message_attachment_join a WHERE m.ROWID = a.message_id) AS num_attachments,
            NULL AS deleted_from,
            0 AS num_replies
        FROM message AS m
        JOIN chat_message_join AS c ON m.ROWID = c.message_id
        WHERE c.chat_id = ?1 AND m.ROWID = ?2
        LIMIT 1";

    let mut stmt = db.prepare(sql)?;
    let row = stmt.query_row([chat_id, rowid], |row| Ok(Message::from_row(row)));
    let mut msg = match row {
        Ok(Ok(parsed)) => parsed,
        Ok(Err(_)) => return Ok(None),
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(err) => return Err(Box::new(err)),
    };

    let has_text = msg
        .text
        .as_ref()
        .map(|t| !t.trim().is_empty())
        .unwrap_or(false);
    if !has_text {
        let _ = msg.generate_text(db);
    }

    let raw_handle = msg.handle_id.and_then(|hid| handles.get(&hid)).cloned();
    let sender = raw_handle.as_ref().map(|handle_id_str| {
        resolve_handle_name(handle_id_str, contact_names).unwrap_or_else(|| handle_id_str.clone())
    });
    let is_tapback = msg.is_tapback();

    Ok(Some(MessageResponse {
        rowid: msg.rowid,
        guid: msg.guid,
        text: msg.text,
        is_from_me: msg.is_from_me,
        date: apple_timestamp_to_iso(msg.date).unwrap_or_default(),
        date_read: if msg.date_read != 0 {
            apple_timestamp_to_iso(msg.date_read)
        } else {
            None
        },
        sender,
        sender_handle: raw_handle,
        service: msg.service,
        associated_message_type: msg.associated_message_type,
        associated_message_guid: msg.associated_message_guid,
        num_attachments: msg.num_attachments,
        attachments: Vec::new(),
        reactions: Vec::new(),
        reply_to_guid: msg.thread_originator_guid,
        reply_to_part: msg.thread_originator_part,
        num_replies: msg.num_replies,
        is_tapback,
    }))
}

// ── Reaction Helpers ────────────────────────────────────────────────────────

fn extract_target_guid(assoc_guid: &str) -> String {
    if let Some(pos) = assoc_guid.find('/') {
        assoc_guid[pos + 1..].to_string()
    } else if let Some(stripped) = assoc_guid.strip_prefix("bp:") {
        stripped.to_string()
    } else {
        assoc_guid.to_string()
    }
}

fn reaction_type_from_associated(assoc_type: Option<i32>, assoc_emoji: Option<&str>) -> String {
    let emoji = assoc_emoji
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    match assoc_type {
        Some(2000) => "Loved".to_string(),
        Some(2001) => "Liked".to_string(),
        Some(2002) => "Disliked".to_string(),
        Some(2003) => "Laughed".to_string(),
        Some(2004) => "Emphasized".to_string(),
        Some(2005) => "Questioned".to_string(),
        Some(2006) => emoji.unwrap_or_else(|| "Emoji".to_string()),
        Some(3000) => "Removed Loved".to_string(),
        Some(3001) => "Removed Liked".to_string(),
        Some(3002) => "Removed Disliked".to_string(),
        Some(3003) => "Removed Laughed".to_string(),
        Some(3004) => "Removed Emphasized".to_string(),
        Some(3005) => "Removed Questioned".to_string(),
        Some(3006) => format!("Removed {}", emoji.unwrap_or_else(|| "Emoji".to_string())),
        Some(n) => format!("Unknown({})", n),
        None => "Unknown".to_string(),
    }
}

fn fetch_tapback_emojis(db: &Connection, rowids: &[i32]) -> HashMap<i32, String> {
    let mut result: HashMap<i32, String> = HashMap::new();
    if rowids.is_empty() {
        return result;
    }

    let mut placeholders = Vec::with_capacity(rowids.len());
    let mut params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::with_capacity(rowids.len());
    for (idx, rowid) in rowids.iter().enumerate() {
        placeholders.push(format!("?{}", idx + 1));
        params.push(Box::new(*rowid));
    }

    let sql = format!(
        "SELECT ROWID, associated_message_emoji
         FROM message
         WHERE ROWID IN ({})
           AND associated_message_emoji IS NOT NULL",
        placeholders.join(",")
    );

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|v| v.as_ref()).collect();

    let mut stmt = match db.prepare(&sql) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Warning: failed to prepare tapback emoji query: {:?}", e);
            return result;
        }
    };

    let rows = match stmt.query_map(param_refs.as_slice(), |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, Option<String>>(1)?))
    }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Warning: failed to fetch tapback emojis: {:?}", e);
            return result;
        }
    };

    for row in rows.flatten() {
        let (rowid, emoji) = row;
        if let Some(e) = emoji {
            let trimmed = e.trim();
            if !trimmed.is_empty() {
                result.insert(rowid, trimmed.to_string());
            }
        }
    }

    result
}

fn fetch_external_reactions(
    db: &Connection,
    target_guids: &[String],
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> HashMap<String, Vec<ReactionResponse>> {
    let mut result: HashMap<String, Vec<ReactionResponse>> = HashMap::new();

    if target_guids.is_empty() {
        return result;
    }

    let mut conditions = Vec::new();
    let mut params: Vec<String> = Vec::new();

    for guid in target_guids {
        let idx = params.len() + 1;
        conditions.push(format!("m.associated_message_guid LIKE '%' || ?{idx}"));
        params.push(guid.clone());
    }

    let where_clause = conditions.join(" OR ");
    let sql = format!(
        "SELECT m.ROWID, m.guid, m.associated_message_guid, m.associated_message_type,
                m.associated_message_emoji, m.handle_id, m.is_from_me, m.date
         FROM message m
         WHERE ({where_clause})
           AND m.associated_message_type IS NOT NULL
           AND m.associated_message_type >= 2000"
    );

    let stmt = db.prepare(&sql);
    let mut stmt = match stmt {
        Ok(s) => s,
        Err(e) => {
            eprintln!(
                "Warning: failed to prepare external reactions query: {:?}",
                e
            );
            return result;
        }
    };

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params
        .iter()
        .map(|v| v as &dyn rusqlite::types::ToSql)
        .collect();

    let rows = match stmt.query_map(param_refs.as_slice(), |row| {
        Ok((
            row.get::<_, Option<String>>(2)?,
            row.get::<_, Option<i32>>(3)?,
            row.get::<_, Option<String>>(4)?,
            row.get::<_, Option<i32>>(5)?,
            row.get::<_, bool>(6)?,
            row.get::<_, i64>(7)?,
        ))
    }) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("Warning: failed to query external reactions: {:?}", e);
            return result;
        }
    };

    for row in rows {
        if let Ok((Some(assoc_guid), assoc_type, assoc_emoji, handle_id, is_from_me, date)) = row {
            let target_guid = extract_target_guid(&assoc_guid);
            let sender = handle_id
                .and_then(|hid| handles.get(&hid))
                .map(|handle_id_str| {
                    resolve_handle_name(handle_id_str, contact_names)
                        .unwrap_or_else(|| handle_id_str.clone())
                });
            let reaction_type = reaction_type_from_associated(assoc_type, assoc_emoji.as_deref());

            if reaction_type.starts_with("Removed") {
                continue;
            }

            result
                .entry(target_guid)
                .or_default()
                .push(ReactionResponse {
                    reaction_type,
                    sender,
                    is_from_me,
                    date: apple_timestamp_to_iso(date).unwrap_or_default(),
                });
        }
    }

    result
}

// ── Search Queries ──────────────────────────────────────────────────────────

pub fn search_messages(
    db: &Connection,
    chat_id: i32,
    params: &SearchParams,
    handles: &HashMap<i32, String>,
    contact_names: &HashMap<String, String>,
) -> Result<SearchResponse, Box<dyn std::error::Error + Send + Sync>> {
    let limit = params.limit.unwrap_or(500);
    let query_lower = normalize_search_query(&params.q);

    let mut conditions = vec![
        "c.chat_id = ?1".to_string(),
        "(m.associated_message_type IS NULL OR m.associated_message_type = 0)".to_string(),
    ];
    let mut sql_params: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();
    sql_params.push(Box::new(chat_id as i64));
    let mut idx = 2;

    if let Some(start) = &params.start {
        let ts = iso_to_apple_timestamp(start);
        conditions.push(format!("m.date >= ?{}", idx));
        sql_params.push(Box::new(ts));
        idx += 1;
    }
    if let Some(end) = &params.end {
        let ts = iso_to_apple_timestamp(end);
        conditions.push(format!("m.date <= ?{}", idx));
        sql_params.push(Box::new(ts));
        idx += 1;
    }

    conditions.push(format!(
        "INSTR(LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(m.text, ''), '’', char(39)), '‘', char(39)), '“', '\"'), '”', '\"'), '—', '-'), ' ', ' ')), ?{}) > 0",
        idx
    ));
    sql_params.push(Box::new(query_lower.clone()));

    let where_clause = conditions.join(" AND ");

    let sql = format!(
        "SELECT m.ROWID, m.guid, m.text, m.is_from_me, m.date, m.handle_id
         FROM message AS m
         LEFT JOIN chat_message_join AS c ON m.ROWID = c.message_id
         WHERE {where_clause}
         ORDER BY m.ROWID DESC
         LIMIT {limit}"
    );

    let param_refs: Vec<&dyn rusqlite::types::ToSql> =
        sql_params.iter().map(|v| v.as_ref()).collect();

    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, bool>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<i32>>(5)?,
        ))
    })?;

    let mut results = Vec::new();
    for row in rows {
        let (rowid, guid, text, is_from_me, date, handle_id) = row?;

        let raw_handle = handle_id.and_then(|hid| handles.get(&hid)).cloned();
        let sender = raw_handle
            .as_ref()
            .map(|h| resolve_handle_name(h, contact_names).unwrap_or_else(|| h.clone()));

        results.push(SearchResult {
            rowid,
            guid,
            text,
            is_from_me,
            date: apple_timestamp_to_iso(date).unwrap_or_default(),
            sender,
        });
    }

    let total = results.len();
    Ok(SearchResponse { results, total })
}

fn normalize_search_query(input: &str) -> String {
    input
        .replace('\u{2019}', "'")
        .replace('\u{2018}', "'")
        .replace('\u{201C}', "\"")
        .replace('\u{201D}', "\"")
        .replace('\u{2014}', "-")
        .replace('\u{00A0}', " ")
        .to_lowercase()
}

// ── Date Conversion Helpers ─────────────────────────────────────────────────

pub fn apple_timestamp_to_iso(timestamp: i64) -> Option<String> {
    if timestamp == 0 {
        return None;
    }
    let seconds = timestamp / NANOSECOND;
    let unix_seconds = seconds + APPLE_EPOCH_OFFSET;
    let nanos = (timestamp % NANOSECOND) as u32;
    chrono::DateTime::from_timestamp(unix_seconds, nanos).map(|dt| dt.to_rfc3339())
}

pub fn iso_to_apple_timestamp(iso: &str) -> i64 {
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(iso) {
        let unix_seconds = dt.timestamp();
        let apple_seconds = unix_seconds - APPLE_EPOCH_OFFSET;
        return apple_seconds * NANOSECOND;
    }
    if let Ok(date) = chrono::NaiveDate::parse_from_str(iso, "%Y-%m-%d") {
        if let Some(dt) = date.and_hms_opt(0, 0, 0) {
            let unix_seconds = dt.and_utc().timestamp();
            let apple_seconds = unix_seconds - APPLE_EPOCH_OFFSET;
            return apple_seconds * NANOSECOND;
        }
    }
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_handle_identifier_phone_variants_match() {
        assert_eq!(
            normalize_handle_identifier("+1 (407) 717-8849"),
            "+14077178849"
        );
        assert_eq!(normalize_handle_identifier("4077178849"), "+14077178849");
        assert_eq!(
            normalize_handle_identifier("1-407-717-8849"),
            "+14077178849"
        );
    }

    #[test]
    fn normalize_handle_identifier_email_lowercases() {
        assert_eq!(
            normalize_handle_identifier("TeSt@Example.com"),
            "test@example.com"
        );
    }

    #[test]
    fn resolve_handle_name_prefers_contact_map() {
        let mut contacts = HashMap::new();
        contacts.insert("+14077178849".to_string(), "Pranav Ramesh".to_string());
        assert_eq!(
            resolve_handle_name("407-717-8849", &contacts),
            Some("Pranav Ramesh".to_string())
        );
    }

    #[test]
    fn resolve_handle_name_missing_returns_none() {
        let contacts: HashMap<String, String> = HashMap::new();
        assert_eq!(resolve_handle_name("407-717-8849", &contacts), None);
    }

    #[test]
    fn clean_preview_text_removes_object_replacement_chars() {
        assert_eq!(
            clean_preview_text(Some(" \u{FFFC}\u{FFFC} hi \u{FFFC} ")),
            Some("hi".to_string())
        );
        assert_eq!(clean_preview_text(Some("\u{FFFC}\u{FFFC}")), None);
    }

    #[test]
    fn infer_preview_kind_prefers_reaction_and_media() {
        let reaction = ChatPreviewMeta {
            rowid: Some(1),
            text: None,
            associated_message_type: Some(2000),
            item_type: Some(0),
            cache_has_attachments: false,
            attachment_count: 0,
            attachment_mime_type: None,
            attachment_is_sticker: false,
        };
        assert_eq!(infer_preview_kind(&reaction), "reaction");

        let photo = ChatPreviewMeta {
            rowid: Some(2),
            text: None,
            associated_message_type: Some(0),
            item_type: Some(0),
            cache_has_attachments: true,
            attachment_count: 1,
            attachment_mime_type: Some("image/jpeg".to_string()),
            attachment_is_sticker: false,
        };
        assert_eq!(infer_preview_kind(&photo), "photo");

        let sticker = ChatPreviewMeta {
            rowid: Some(3),
            text: None,
            associated_message_type: Some(0),
            item_type: Some(2),
            cache_has_attachments: true,
            attachment_count: 1,
            attachment_mime_type: Some("image/png".to_string()),
            attachment_is_sticker: true,
        };
        assert_eq!(infer_preview_kind(&sticker), "sticker");
    }

    #[test]
    fn derive_chat_preview_returns_placeholders_and_none() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        let meta = ChatPreviewMeta {
            rowid: Some(5),
            text: None,
            associated_message_type: Some(2001),
            item_type: Some(0),
            cache_has_attachments: false,
            attachment_count: 0,
            attachment_mime_type: None,
            attachment_is_sticker: false,
        };
        let (preview, kind) = derive_chat_preview(&conn, &meta);
        assert_eq!(kind, "reaction");
        assert_eq!(preview, Some("Reaction".to_string()));

        let empty = ChatPreviewMeta {
            rowid: None,
            text: None,
            associated_message_type: None,
            item_type: None,
            cache_has_attachments: false,
            attachment_count: 0,
            attachment_mime_type: None,
            attachment_is_sticker: false,
        };
        let (preview, kind) = derive_chat_preview(&conn, &empty);
        assert_eq!(kind, "none");
        assert_eq!(preview, None);
    }

    #[test]
    fn search_messages_returns_newest_first() {
        let conn = Connection::open_in_memory().expect("in-memory sqlite");
        conn.execute_batch(
            "
            CREATE TABLE message (
              guid TEXT NOT NULL,
              text TEXT,
              is_from_me INTEGER NOT NULL,
              date INTEGER NOT NULL,
              handle_id INTEGER,
              associated_message_type INTEGER
            );
            CREATE TABLE chat_message_join (
              chat_id INTEGER NOT NULL,
              message_id INTEGER NOT NULL
            );
            ",
        )
        .expect("schema");

        for idx in 1..=3 {
            conn.execute(
                "INSERT INTO message (guid, text, is_from_me, date, handle_id, associated_message_type)
                 VALUES (?1, ?2, 0, ?3, 1, 0)",
                rusqlite::params![format!("guid-{}", idx), "hello world", idx as i64],
            )
            .expect("insert message");
            conn.execute(
                "INSERT INTO chat_message_join (chat_id, message_id) VALUES (1, ?1)",
                rusqlite::params![idx],
            )
            .expect("insert join");
        }

        let mut handles = HashMap::new();
        handles.insert(1, "+15555550123".to_string());
        let contact_names: HashMap<String, String> = HashMap::new();

        let params = SearchParams {
            q: "hello".to_string(),
            start: None,
            end: None,
            limit: Some(10),
        };

        let response =
            search_messages(&conn, 1, &params, &handles, &contact_names).expect("search works");

        let rowids: Vec<i32> = response.results.into_iter().map(|r| r.rowid).collect();
        assert_eq!(rowids, vec![3, 2, 1]);
    }
}
