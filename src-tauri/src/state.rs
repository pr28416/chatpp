use std::collections::HashMap;
use std::path::PathBuf;

pub struct AppState {
    pub db_path: PathBuf,
    pub handles: HashMap<i32, String>,
    /// chat_id → Vec<(display_name, raw_handle)>
    pub chat_participants: HashMap<i32, Vec<(String, String)>>,
    pub contact_names: HashMap<String, String>,
    /// normalized identifier → (AddressBook db path, Z_PK) for lazy photo loading
    pub contact_photos: HashMap<String, (PathBuf, i64)>,
}

pub fn init_app_state() -> AppState {
    let db_path = resolve_path("~/Library/Messages/chat.db");

    if !db_path.exists() {
        eprintln!("Warning: chat.db not found at {}", db_path.display());
        eprintln!("Make sure Full Disk Access is enabled for this app.");
        return AppState {
            db_path,
            handles: HashMap::new(),
            chat_participants: HashMap::new(),
            contact_names: HashMap::new(),
            contact_photos: HashMap::new(),
        };
    }

    match crate::db::init_app_state(db_path.clone()) {
        Ok(state) => {
            println!(
                "Loaded {} handles, {} chats with participants, {} contacts ({} with photos)",
                state.handles.len(),
                state.chat_participants.len(),
                state.contact_names.len(),
                state.contact_photos.len()
            );
            state
        }
        Err(e) => {
            eprintln!("Error initializing app state: {}", e);
            AppState {
                db_path,
                handles: HashMap::new(),
                chat_participants: HashMap::new(),
                contact_names: HashMap::new(),
                contact_photos: HashMap::new(),
            }
        }
    }
}

fn resolve_path(path: &str) -> PathBuf {
    if path.starts_with("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return PathBuf::from(format!("{}/{}", home, &path[2..]));
        }
    }
    PathBuf::from(path)
}
