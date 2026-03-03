use crate::db;
use crate::state::AppState;
use crate::timeline_db;
use crate::types::{AssistantCitation, MessageParams, SearchParams};
use rusqlite::types::Value as SqlValue;
use serde_json::{json, Value};

const SQL_DEFAULT_LIMIT: usize = 200;
const SQL_MAX_LIMIT: usize = 500;

pub fn execute_tool(state: &AppState, tool_name: &str, args: Value) -> Result<Value, String> {
    match tool_name {
        "search_messages" => tool_search_messages(state, args),
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
    let sql = args
        .get("sql")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "sql is required".to_string())?
        .to_string();

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

    let conn = match db_name.as_str() {
        "timeline" => timeline_db::open_ro(&state.timeline_db_path).map_err(|e| e.to_string())?,
        "chat" => rusqlite::Connection::open_with_flags(
            &state.db_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())?,
        _ => return Err("db must be 'chat' or 'timeline'".to_string()),
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

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

    Ok(json!({
        "db": db_name,
        "columns": column_names,
        "rows": data_rows,
        "row_count": data_rows.len(),
        "capped": capped,
        "limit": limit,
    }))
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

fn contains_word(haystack: &str, needle: &str) -> bool {
    haystack
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '_')
        .any(|token| token == needle)
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

    for citation in citations {
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
                let sender = handle_id
                    .and_then(|hid| state.handles.get(&hid))
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
                    date: db::apple_timestamp_to_iso(apple_ts),
                    message_text: text,
                    reason: citation.reason.clone(),
                });
            }
            Err(_) => {
                enriched.push(AssistantCitation {
                    chat_id: citation.chat_id,
                    rowid: citation.rowid,
                    label: citation.label.clone(),
                    chat_label: chat_label_for(state, citation.chat_id),
                    sender: None,
                    date: None,
                    message_text: None,
                    reason: citation.reason.clone(),
                });
            }
        }
    }

    Ok(enriched)
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
