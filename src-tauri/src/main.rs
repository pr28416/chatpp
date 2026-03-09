#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod assistant_bridge;
mod assistant_tools;
mod commands;
mod db;
mod env_config;
mod state;
mod timeline_ai;
mod timeline_db;
mod timeline_indexer;
mod timeline_types;
mod types;

use imessage_database::util::platform::Platform;
use tauri::Manager;

fn main() {
    env_config::apply_env_files();

    add_platform_plugins(tauri::Builder::default())
        .manage(state::init_app_state())
        .register_uri_scheme_protocol("localfile", |ctx, request| {
            let handle = ctx.app_handle();
            let app_state = handle.state::<state::AppState>();
            serve_attachment(&app_state, &request)
        })
        .invoke_handler(tauri::generate_handler![
            commands::start_window_drag,
            commands::get_chats,
            commands::get_messages,
            commands::get_message_by_chat_rowid,
            commands::search_messages,
            commands::get_handles,
            commands::get_contacts,
            commands::get_contact_photo,
            commands::resolve_attachment,
            commands::start_timeline_index,
            commands::cancel_timeline_index,
            commands::get_timeline_index_state,
            commands::get_timeline_nodes,
            commands::get_timeline_node_occurrences,
            commands::get_timeline_group_children,
            commands::get_timeline_overview,
            commands::get_timeline_related_nodes,
            commands::retry_timeline_failed_batches,
            commands::jump_anchor_context,
            commands::get_timeline_node_message_rowids,
            commands::get_timeline_node_message_rowids_by_node,
            commands::assistant_run_turn,
            commands::get_assistant_provider_availability,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn add_platform_plugins(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    #[cfg(target_os = "macos")]
    {
        return builder.plugin(tauri_plugin_liquid_glass::init());
    }

    #[cfg(not(target_os = "macos"))]
    {
        builder
    }
}

fn serve_attachment(
    state: &state::AppState,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let path = request.uri().path();
    let id_str = path.trim_start_matches('/');
    let id: i32 = match id_str.parse() {
        Ok(id) => id,
        Err(_) => return error_response(400, "Invalid attachment ID"),
    };

    let db = match rusqlite::Connection::open_with_flags(
        &state.db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ) {
        Ok(db) => db,
        Err(e) => return error_response(500, &format!("DB error: {e}")),
    };

    let attachment = match db::get_attachment_by_id(&db, id) {
        Ok(Some(att)) => att,
        Ok(None) => return error_response(404, "Attachment not found"),
        Err(e) => return error_response(500, &format!("Query error: {e}")),
    };

    let file_path =
        match attachment.resolved_attachment_path(&Platform::macOS, &state.db_path, None) {
            Some(p) => p,
            None => return error_response(404, "Attachment file path not resolved"),
        };

    let mime = attachment
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    let (serve_path, content_type) = if commands::is_heic(&mime, &file_path) {
        match commands::convert_heic_to_jpeg(&file_path, id) {
            Ok(jpeg_path) => (jpeg_path, "image/jpeg".to_string()),
            Err(e) => return error_response(500, &format!("HEIC conversion error: {e}")),
        }
    } else {
        (file_path, mime)
    };

    let bytes = match std::fs::read(&serve_path) {
        Ok(b) => b,
        Err(e) => return error_response(404, &format!("File not readable: {} — {e}", serve_path)),
    };

    tauri::http::Response::builder()
        .status(200)
        .header("content-type", &content_type)
        .header("access-control-allow-origin", "*")
        .body(bytes)
        .unwrap()
}

fn error_response(status: u16, msg: &str) -> tauri::http::Response<Vec<u8>> {
    eprintln!("[localfile] {status}: {msg}");
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/plain")
        .body(msg.as_bytes().to_vec())
        .unwrap()
}
