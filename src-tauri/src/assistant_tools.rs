use crate::db;
use crate::state::AppState;
use crate::timeline_db;
use crate::types::{AssistantCitation, AssistantMessageEvidenceRow, MessageParams, SearchParams};
use chrono::{DateTime, Local};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Value};
use std::collections::HashSet;

const SQL_DEFAULT_LIMIT: usize = 200;
const SQL_MAX_LIMIT: usize = 500;

pub fn execute_tool(state: &AppState, tool_name: &str, args: Value) -> Result<Value, String> {
    match tool_name {
        "search_messages" => tool_search_messages(state, args),
        "search_all_chats" => tool_search_all_chats(state, args),
        "search_contacts" => tool_search_contacts(state, args),
        "find_chats_by_contact" => tool_find_chats_by_contact(state, args),
        "search_messages_by_contact" => tool_search_messages_by_contact(state, args),
        "get_recent_messages" => tool_get_recent_messages(state, args),
        "get_message_context" => tool_get_message_context(state, args),
        "search_timeline" => tool_search_timeline(state, args),
        "timeline_overview" => tool_timeline_overview(state, args),
        "run_readonly_sql" => tool_run_readonly_sql(state, args),
        _ => Err(format!("Unknown tool: {}", tool_name)),
    }
}

fn tool_search_messages(state: &AppState, args: Value) -> Result<Value, String> {
    let chat_id = as_i32(args.get("chat_id")).ok_or_else(|| "chat_id is required".to_string())?;
    let q = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "q is required".to_string())?
        .to_string();

    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 500));

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let params = SearchParams {
        q,
        start: None,
        end: None,
        limit,
    };

    let response = db::search_messages(
        &conn,
        chat_id,
        &params,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "chat_id": chat_id,
        "results": response.results,
        "total": response.total,
    }))
}

fn tool_get_recent_messages(state: &AppState, args: Value) -> Result<Value, String> {
    let chat_id = as_i32(args.get("chat_id")).ok_or_else(|| "chat_id is required".to_string())?;
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 100))
        .unwrap_or(5);
    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(0, 5000))
        .unwrap_or(0);
    let sender_filter = args
        .get("sender")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_lowercase());

    let scan_limit = (offset.saturating_add(limit).saturating_mul(6)).clamp(200, 5000);

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let params = MessageParams {
        start: None,
        end: None,
        before_rowid: None,
        after_rowid: None,
        limit: Some(scan_limit),
        fast_initial: Some(false),
    };

    let response = db::query_messages(
        &conn,
        chat_id,
        &params,
        scan_limit,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())?;

    let mut results: Vec<Value> = Vec::with_capacity(limit);
    let mut skipped = 0_usize;
    for message in response.messages.into_iter().rev() {
        if message.is_tapback {
            continue;
        }
        if let Some(filter) = sender_filter.as_ref() {
            let sender = message
                .sender
                .as_ref()
                .map(|v| v.to_lowercase())
                .unwrap_or_default();
            let sender_handle = message
                .sender_handle
                .as_ref()
                .map(|v| v.to_lowercase())
                .unwrap_or_default();
            if !sender.contains(filter) && !sender_handle.contains(filter) {
                continue;
            }
        }
        if skipped < offset {
            skipped += 1;
            continue;
        }
        results.push(serde_json::to_value(message).map_err(|e| e.to_string())?);
        if results.len() >= limit {
            break;
        }
    }

    Ok(json!({
        "chat_id": chat_id,
        "results": results,
        "total": results.len(),
        "scan_limit": scan_limit,
        "offset": offset,
        }))
}

fn tool_search_all_chats(state: &AppState, args: Value) -> Result<Value, String> {
    let q = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "q is required".to_string())?
        .to_string();
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 240))
        .unwrap_or(120);

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT c.chat_id AS chat_id, m.ROWID AS rowid
             FROM message m
             JOIN chat_message_join c ON c.message_id = m.ROWID
             WHERE m.text IS NOT NULL
               AND LOWER(m.text) LIKE LOWER(?1)
             ORDER BY m.ROWID DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let mut rows = stmt
        .query(rusqlite::params![format!("%{}%", q), i64::try_from(limit).unwrap_or(120)])
        .map_err(|e| e.to_string())?;

    let mut data_rows: Vec<Vec<Value>> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let chat_id: i32 = row.get(0).map_err(|e| e.to_string())?;
        let rowid: i32 = row.get(1).map_err(|e| e.to_string())?;
        data_rows.push(vec![json!(chat_id), json!(rowid)]);
    }
    let column_names = vec!["chat_id".to_string(), "rowid".to_string()];
    let normalized_rows =
        normalize_sql_rows_to_messages(state, &conn, &column_names, &data_rows, true)?;

    Ok(json!({
        "query": q,
        "results": normalized_rows,
        "total": normalized_rows.len(),
    }))
}

fn tool_search_contacts(state: &AppState, args: Value) -> Result<Value, String> {
    let q = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "q is required".to_string())?
        .to_string();
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 50))
        .unwrap_or(12);
    let needle = normalize_contact_token(&q);

    let mut scored: Vec<(i32, Value)> = Vec::new();
    for (handle, display_name) in &state.contact_names {
        let handle_norm = normalize_contact_token(handle);
        let name_norm = normalize_contact_token(display_name);
        let score = contact_match_score(&needle, &name_norm, &handle_norm);
        if score <= 0 {
            continue;
        }
        let chat_ids = matching_chat_ids_for_contact(state, display_name, handle, 24);
        scored.push((
            score,
            json!({
                "display_name": display_name,
                "handle": handle,
                "score": score,
                "chat_ids": chat_ids,
            }),
        ));
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let results: Vec<Value> = scored.into_iter().take(limit).map(|(_, row)| row).collect();
    Ok(json!({
        "query": q,
        "results": results,
        "total": results.len(),
    }))
}

fn tool_find_chats_by_contact(state: &AppState, args: Value) -> Result<Value, String> {
    let q = args
        .get("name_or_handle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "name_or_handle is required".to_string())?
        .to_string();
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 80))
        .unwrap_or(24);
    let ids = matching_chat_ids_for_contact(state, &q, &q, limit);
    let results: Vec<Value> = ids
        .into_iter()
        .map(|chat_id| {
            let participants = state
                .chat_participants
                .get(&chat_id)
                .map(|pairs| {
                    pairs
                        .iter()
                        .map(|(name, _)| name.clone())
                        .collect::<Vec<String>>()
                })
                .unwrap_or_default();
            let label = participants.join(", ");
            json!({
                "chat_id": chat_id,
                "participants": participants,
                "label": label,
            })
        })
        .collect();
    Ok(json!({
        "query": q,
        "results": results,
        "total": results.len(),
    }))
}

fn tool_search_messages_by_contact(state: &AppState, args: Value) -> Result<Value, String> {
    let q = args
        .get("name_or_handle")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "name_or_handle is required".to_string())?
        .to_string();
    let text_filter = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(normalize_sql_input);
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 240))
        .unwrap_or(120);
    let chat_ids = matching_chat_ids_for_contact(state, &q, &q, 80);
    if chat_ids.is_empty() {
        return Ok(json!({
            "query": q,
            "results": [],
            "total": 0,
        }));
    }

    let placeholders = std::iter::repeat("?")
        .take(chat_ids.len())
        .collect::<Vec<_>>()
        .join(",");
    let sql = if text_filter.is_some() {
        format!(
            "SELECT c.chat_id AS chat_id, m.ROWID AS rowid
             FROM message m
             JOIN chat_message_join c ON c.message_id = m.ROWID
             WHERE c.chat_id IN ({})
               AND m.text IS NOT NULL
               AND INSTR(LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(m.text, ''), '’', char(39)), '‘', char(39)), '“', '\"'), '”', '\"'), '—', '-'), ' ', ' ')), ?) > 0
             ORDER BY m.ROWID DESC
             LIMIT ?",
            placeholders
        )
    } else {
        format!(
            "SELECT c.chat_id AS chat_id, m.ROWID AS rowid
             FROM message m
             JOIN chat_message_join c ON c.message_id = m.ROWID
             WHERE c.chat_id IN ({})
               AND m.text IS NOT NULL
             ORDER BY m.ROWID DESC
             LIMIT ?",
            placeholders
        )
    };

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut params: Vec<SqlValue> = chat_ids
        .iter()
        .map(|chat_id| SqlValue::Integer(*chat_id as i64))
        .collect();
    if let Some(filter) = text_filter {
        params.push(SqlValue::Text(filter.to_lowercase()));
    }
    params.push(SqlValue::Integer(i64::try_from(limit).unwrap_or(120)));

    let mut rows = stmt
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;
    let mut data_rows: Vec<Vec<Value>> = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let chat_id: i32 = row.get(0).map_err(|e| e.to_string())?;
        let rowid: i32 = row.get(1).map_err(|e| e.to_string())?;
        data_rows.push(vec![json!(chat_id), json!(rowid)]);
    }
    let column_names = vec!["chat_id".to_string(), "rowid".to_string()];
    let normalized_rows =
        normalize_sql_rows_to_messages(state, &conn, &column_names, &data_rows, true)?;

    Ok(json!({
        "query": q,
        "results": normalized_rows,
        "total": normalized_rows.len(),
        "chat_ids": chat_ids,
    }))
}

fn tool_get_message_context(state: &AppState, args: Value) -> Result<Value, String> {
    let chat_id = as_i32(args.get("chat_id")).ok_or_else(|| "chat_id is required".to_string())?;
    let rowid = as_i32(args.get("rowid")).ok_or_else(|| "rowid is required".to_string())?;
    let window = args
        .get("window")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(10, 120))
        .unwrap_or(40);

    let half = (window / 2) as i32;

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let params = MessageParams {
        start: None,
        end: None,
        before_rowid: None,
        after_rowid: Some(rowid.saturating_sub(half + 1)),
        limit: Some(window),
        fast_initial: Some(false),
    };

    let response = db::query_messages(
        &conn,
        chat_id,
        &params,
        window,
        &state.handles,
        &state.contact_names,
    )
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "chat_id": chat_id,
        "messages": response.messages,
        "has_more": response.has_more,
        "has_previous": response.has_previous,
    }))
}

fn tool_search_timeline(state: &AppState, args: Value) -> Result<Value, String> {
    let chat_id = as_i32(args.get("chat_id")).ok_or_else(|| "chat_id is required".to_string())?;
    let q = args
        .get("q")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "q is required".to_string())?
        .to_lowercase();
    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, 64))
        .unwrap_or(20);

    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    let mut out: Vec<Value> = Vec::new();

    for level in [2_u8, 1_u8, 0_u8] {
        let list =
            timeline_db::get_nodes(&conn, chat_id, level, None).map_err(|e| e.to_string())?;
        for node in list.nodes {
            let haystack = format!(
                "{} {}",
                node.title.to_lowercase(),
                node.summary.to_lowercase()
            );
            if haystack.contains(&q) {
                out.push(serde_json::to_value(node).map_err(|e| e.to_string())?);
                if out.len() >= limit {
                    return Ok(json!({ "nodes": out, "total": out.len() }));
                }
            }
        }
    }

    Ok(json!({ "nodes": out, "total": out.len() }))
}

fn tool_timeline_overview(state: &AppState, args: Value) -> Result<Value, String> {
    let chat_id = as_i32(args.get("chat_id")).ok_or_else(|| "chat_id is required".to_string())?;
    let conn = timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?;
    let overview = timeline_db::get_overview(&conn, chat_id).map_err(|e| e.to_string())?;
    serde_json::to_value(overview).map_err(|e| e.to_string())
}

fn tool_run_readonly_sql(state: &AppState, args: Value) -> Result<Value, String> {
    let sql_raw = args
        .get("sql")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "sql is required".to_string())?
        .to_string();
    let sql = normalize_sql_input(&sql_raw);

    validate_readonly_sql(&sql)?;

    let db_name = args
        .get("db")
        .and_then(Value::as_str)
        .unwrap_or("chat")
        .to_lowercase();

    let limit = args
        .get("limit")
        .and_then(Value::as_u64)
        .map(|v| (v as usize).clamp(1, SQL_MAX_LIMIT))
        .unwrap_or(SQL_DEFAULT_LIMIT);

    let params: Vec<SqlValue> = args
        .get("params")
        .and_then(Value::as_array)
        .map(|arr| arr.iter().map(json_to_sql_value).collect())
        .unwrap_or_default();

    if db_name != "chat" {
        return Err(
            "run_readonly_sql only supports db='chat' and must return message keys (rowid, chat_id)"
                .to_string(),
        );
    }

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(&sql).map_err(|e| {
        format!(
            "{}. Schema hints: message(ROWID,guid,text,date,handle_id,is_from_me), chat(ROWID,chat_identifier,display_name), chat_message_join(chat_id,message_id), handle(ROWID,id). Use chat.ROWID AS chat_id.",
            e
        )
    })?;

    if !stmt.readonly() {
        return Err("Only read-only SQL queries are allowed".to_string());
    }

    let column_count = stmt.column_count();
    let column_names: Vec<String> = (0..column_count)
        .map(|i| stmt.column_name(i).unwrap_or("").to_string())
        .collect();

    let mut rows = stmt
        .query(rusqlite::params_from_iter(params))
        .map_err(|e| e.to_string())?;

    let mut data_rows: Vec<Vec<Value>> = Vec::new();
    let mut capped = false;

    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if data_rows.len() >= limit {
            capped = true;
            break;
        }
        let mut out_row: Vec<Value> = Vec::with_capacity(column_count);
        for idx in 0..column_count {
            let value: SqlValue = row.get(idx).map_err(|e| e.to_string())?;
            out_row.push(sql_to_json_value(value));
        }
        data_rows.push(out_row);
    }

    let normalized_rows =
        normalize_sql_rows_to_messages(state, &conn, &column_names, &data_rows, false)?;

    Ok(json!({
        "db": db_name,
        "results": normalized_rows,
        "total": normalized_rows.len(),
        "source_row_count": data_rows.len(),
        "capped": capped,
        "limit": limit,
    }))
}

fn normalize_sql_rows_to_messages(
    state: &AppState,
    conn: &rusqlite::Connection,
    column_names: &[String],
    rows: &[Vec<Value>],
    allow_empty: bool,
) -> Result<Vec<AssistantMessageEvidenceRow>, String> {
    let rowid_idx = find_column_index(
        column_names,
        &["rowid", "ROWID", "message_id", "message_rowid"],
    )
    .ok_or_else(|| {
        "SQL result cannot be normalized: include message row id as `rowid` (or message_id/message_rowid)".to_string()
    })?;
    let chat_id_idx =
        find_column_index(column_names, &["chat_id", "chatId"]).ok_or_else(|| {
            "SQL result cannot be normalized: include conversation id as `chat_id`".to_string()
        })?;

    let mut keys: Vec<(i32, i32)> = Vec::new();
    let mut seen = HashSet::new();
    for (row_idx, row) in rows.iter().enumerate() {
        let rowid = row
            .get(rowid_idx)
            .and_then(value_to_i32)
            .ok_or_else(|| format!("SQL row {} has invalid rowid", row_idx + 1))?;
        let chat_id = row
            .get(chat_id_idx)
            .and_then(value_to_i32)
            .ok_or_else(|| format!("SQL row {} has invalid chat_id", row_idx + 1))?;
        if seen.insert((chat_id, rowid)) {
            keys.push((chat_id, rowid));
        }
    }

    let mut out = Vec::with_capacity(keys.len());
    for (chat_id, rowid) in keys {
        let message = db::get_message_by_chat_rowid(
            conn,
            chat_id,
            rowid,
            &state.handles,
            &state.contact_names,
        )
        .map_err(|e| e.to_string())?;
        if let Some(message) = message {
            let date_human = format_human_date(&message.date);
            out.push(AssistantMessageEvidenceRow {
                chat_id,
                chat_label: chat_label_for(state, chat_id),
                rowid,
                guid: message.guid,
                sender: message.sender,
                is_from_me: message.is_from_me,
                text: message.text,
                date_iso: message.date,
                date_human,
            });
        }
    }

    if out.is_empty() && !allow_empty {
        return Err("SQL result did not map to any valid messages in the selected chats".to_string());
    }

    Ok(out)
}

fn find_column_index(column_names: &[String], aliases: &[&str]) -> Option<usize> {
    column_names.iter().position(|col| {
        aliases
            .iter()
            .any(|alias| col.eq_ignore_ascii_case(alias))
    })
}

fn value_to_i32(value: &Value) -> Option<i32> {
    match value {
        Value::Number(n) => n.as_i64().and_then(|v| i32::try_from(v).ok()),
        Value::String(s) => s.parse::<i64>().ok().and_then(|v| i32::try_from(v).ok()),
        _ => None,
    }
}

fn format_human_date(iso: &str) -> String {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(iso) {
        return parsed
            .with_timezone(&Local)
            .format("%b %-d, %Y, %-I:%M %p")
            .to_string();
    }
    iso.to_string()
}

fn validate_readonly_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL query is empty".to_string());
    }

    if trimmed.contains(';') {
        let stripped = trimmed.trim_end_matches(';').trim();
        if stripped.contains(';') {
            return Err("Only a single SQL statement is allowed".to_string());
        }
    }

    let lower = trimmed.to_lowercase();
    let blocked = [
        "insert",
        "update",
        "delete",
        "drop",
        "alter",
        "create",
        "replace",
        "truncate",
        "attach",
        "detach",
        "vacuum",
        "reindex",
        "pragma",
        "begin",
        "commit",
        "rollback",
        "savepoint",
        "release",
        "analyze",
    ];

    if blocked.iter().any(|kw| contains_word(&lower, kw)) {
        return Err("SQL contains blocked non-read-only operation".to_string());
    }

    let allowed_prefix = ["select", "with", "explain select"];
    if !allowed_prefix
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        return Err("Only SELECT/WITH read-only queries are allowed".to_string());
    }

    Ok(())
}

fn normalize_sql_input(input: &str) -> String {
    input
        .replace('\u{2019}', "'")
        .replace('\u{2018}', "'")
        .replace('\u{201C}', "\"")
        .replace('\u{201D}', "\"")
        .replace('\u{2014}', "-")
        .replace('\u{00A0}', " ")
}

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| token == needle)
}

fn normalize_contact_token(input: &str) -> String {
    normalize_sql_input(input)
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '@' || c == '+' || c == '.' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn contact_match_score(needle: &str, name_norm: &str, handle_norm: &str) -> i32 {
    if needle.is_empty() {
        return 0;
    }
    if name_norm == needle || handle_norm == needle {
        return 100;
    }
    if name_norm.starts_with(needle) || handle_norm.starts_with(needle) {
        return 80;
    }
    if name_norm.contains(needle) || handle_norm.contains(needle) {
        return 60;
    }
    let terms: Vec<&str> = needle.split_whitespace().collect();
    if terms.is_empty() {
        return 0;
    }
    let mut matches = 0_i32;
    for term in terms {
        if name_norm.contains(term) || handle_norm.contains(term) {
            matches += 1;
        }
    }
    if matches == 0 {
        return 0;
    }
    30 + matches * 10
}

fn matching_chat_ids_for_contact(
    state: &AppState,
    display_name: &str,
    handle: &str,
    limit: usize,
) -> Vec<i32> {
    let name_norm = normalize_contact_token(display_name);
    let handle_norm = normalize_contact_token(handle);
    let mut scored: Vec<(i32, i32)> = Vec::new();
    for (chat_id, participants) in &state.chat_participants {
        let mut best = 0_i32;
        for (participant_name, participant_handle) in participants {
            let participant_name_norm = normalize_contact_token(participant_name);
            let participant_handle_norm = normalize_contact_token(participant_handle);
            best = best.max(contact_match_score(
                &name_norm,
                &participant_name_norm,
                &participant_handle_norm,
            ));
            best = best.max(contact_match_score(
                &handle_norm,
                &participant_name_norm,
                &participant_handle_norm,
            ));
        }
        if best > 0 {
            scored.push((best, *chat_id));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(limit)
        .map(|(_, chat_id)| chat_id)
        .collect()
}

fn as_i32(value: Option<&Value>) -> Option<i32> {
    value
        .and_then(Value::as_i64)
        .and_then(|v| i32::try_from(v).ok())
}

fn json_to_sql_value(value: &Value) -> SqlValue {
    match value {
        Value::Null => SqlValue::Null,
        Value::Bool(v) => SqlValue::Integer(i64::from(*v)),
        Value::Number(n) => {
            if let Some(v) = n.as_i64() {
                SqlValue::Integer(v)
            } else if let Some(v) = n.as_f64() {
                SqlValue::Real(v)
            } else {
                SqlValue::Null
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        _ => SqlValue::Text(value.to_string()),
    }
}

fn sql_to_json_value(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(v) => json!(v),
        SqlValue::Real(v) => json!(v),
        SqlValue::Text(v) => json!(v),
        SqlValue::Blob(v) => {
            use base64::Engine;
            json!(base64::engine::general_purpose::STANDARD.encode(v))
        }
    }
}

pub fn enrich_citations(
    state: &AppState,
    citations: &[AssistantCitation],
) -> Result<Vec<AssistantCitation>, String> {
    if citations.is_empty() {
        return Ok(Vec::new());
    }

    let conn = rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare(
            "SELECT m.text, m.date, m.handle_id, m.is_from_me
             FROM message m
             JOIN chat_message_join c ON c.message_id = m.ROWID
             WHERE c.chat_id = ?1 AND m.ROWID = ?2
             LIMIT 1",
        )
        .map_err(|e| e.to_string())?;

    let mut enriched: Vec<AssistantCitation> = Vec::with_capacity(citations.len());
    let mut seen: HashSet<(i32, i32)> = HashSet::new();
    let debug_enabled = assistant_debug_enabled();
    let mut dropped_missing = 0usize;

    for citation in citations {
        if !seen.insert((citation.chat_id, citation.rowid)) {
            continue;
        }
        let row = stmt.query_row(rusqlite::params![citation.chat_id, citation.rowid], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<i32>>(2)?,
                row.get::<_, i32>(3)?,
            ))
        });

        match row {
            Ok((text, apple_ts, handle_id, is_from_me)) => {
                let sender_handle = handle_id.and_then(|hid| state.handles.get(&hid)).cloned();
                let sender = sender_handle
                    .as_ref()
                    .map(|raw| {
                        db::resolve_handle_name(raw, &state.contact_names)
                            .unwrap_or_else(|| raw.clone())
                    })
                    .or_else(|| {
                        if is_from_me == 1 {
                            Some("You".to_string())
                        } else {
                            None
                        }
                    });
                enriched.push(AssistantCitation {
                    chat_id: citation.chat_id,
                    rowid: citation.rowid,
                    label: citation.label.clone(),
                    chat_label: chat_label_for(state, citation.chat_id),
                    sender,
                    sender_handle,
                    date: db::apple_timestamp_to_iso(apple_ts),
                    message_text: text,
                    reason: citation.reason.clone(),
                });
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                dropped_missing += 1;
            }
            Err(err) => return Err(err.to_string()),
        }
    }

    if debug_enabled {
        eprintln!(
            "[assistant-debug] citations enrich requested={} enriched={} dropped_missing={}",
            citations.len(),
            enriched.len(),
            dropped_missing
        );
    }

    Ok(enriched)
}

fn assistant_debug_enabled() -> bool {
    std::env::var("ASSISTANT_DEBUG")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn chat_label_for(state: &AppState, chat_id: i32) -> Option<String> {
    state
        .chat_participants
        .get(&chat_id)
        .and_then(|participants| {
            if participants.is_empty() {
                None
            } else {
                let joined = participants
                    .iter()
                    .map(|(display_name, _)| display_name.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                Some(joined)
            }
        })
}
