use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct AppState {
    pub db_path: PathBuf,
    pub timeline_db_path: PathBuf,
    pub handles: HashMap<i32, String>,
    /// chat_id → Vec<(display_name, raw_handle)>
    pub chat_participants: HashMap<i32, Vec<(String, String)>>,
    pub contact_names: HashMap<String, String>,
    /// normalized identifier → (AddressBook db path, Z_PK) for lazy photo loading
    pub contact_photos: HashMap<String, (PathBuf, i64)>,
    pub running_timeline_jobs: Arc<Mutex<HashSet<i32>>>,
    pub cancel_timeline_jobs: Arc<Mutex<HashSet<i32>>>,
}

pub fn init_app_state() -> AppState {
    let db_path = resolve_path("~/Library/Messages/chat.db");
    let timeline_db_path = resolve_timeline_db_path();

    if !db_path.exists() {
        eprintln!("Warning: chat.db not found at {}", db_path.display());
        eprintln!("Make sure Full Disk Access is enabled for this app.");
        return AppState {
            db_path,
            timeline_db_path,
            handles: HashMap::new(),
            chat_participants: HashMap::new(),
            contact_names: HashMap::new(),
            contact_photos: HashMap::new(),
            running_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
            cancel_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
        };
    }

    if let Some(parent) = timeline_db_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            eprintln!(
                "Warning: failed to create timeline DB directory {}: {}",
                parent.display(),
                e
            );
        }
    }

    if let Err(e) = crate::timeline_db::init_timeline_db(&timeline_db_path) {
        eprintln!(
            "Warning: failed to initialize timeline DB at {}: {}",
            timeline_db_path.display(),
            e
        );
    }

    match crate::db::init_app_state(db_path.clone(), timeline_db_path.clone()) {
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
                timeline_db_path,
                handles: HashMap::new(),
                chat_participants: HashMap::new(),
                contact_names: HashMap::new(),
                contact_photos: HashMap::new(),
                running_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
                cancel_timeline_jobs: Arc::new(Mutex::new(HashSet::new())),
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

fn resolve_timeline_db_path() -> PathBuf {
    if let Ok(override_path) = std::env::var("TIMELINE_DB_PATH") {
        let trimmed = override_path.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }

    if let Ok(home) = std::env::var("HOME") {
        return PathBuf::from(home)
            .join("Library")
            .join("Application Support")
            .join("imessage-search-desktop")
            .join("timeline.db");
    }

    PathBuf::from("timeline.db")
}
