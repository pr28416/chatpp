use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn apply_env_files() {
    for path in candidate_paths() {
        if !path.exists() {
            continue;
        }
        let Ok(iter) = dotenvy::from_path_iter(&path) else {
            continue;
        };
        for item in iter.flatten() {
            if std::env::var_os(&item.0).is_none() {
                unsafe {
                    std::env::set_var(&item.0, &item.1);
                }
            }
        }
    }
}

pub fn get_env_var(name: &str) -> Option<String> {
    if let Ok(value) = std::env::var(name) {
        if !value.trim().is_empty() {
            return Some(value);
        }
    }

    for path in candidate_paths() {
        if !path.exists() {
            continue;
        }
        let Ok(iter) = dotenvy::from_path_iter(&path) else {
            continue;
        };
        for item in iter.flatten() {
            if item.0 == name && !item.1.trim().is_empty() {
                return Some(item.1);
            }
        }
    }

    None
}

pub fn assistant_env_overrides() -> HashMap<String, String> {
    const KEYS: &[&str] = &[
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GOOGLE_GENERATIVE_AI_API_KEY",
        "XAI_API_KEY",
        "OPENAI_MODEL",
        "OPENAI_MODEL_TIMELINE_TEXT",
        "OPENAI_MODEL_TIMELINE_MEDIA",
        "TIMELINE_DB_PATH",
        "TIMELINE_AI_MOCK",
    ];

    KEYS.iter()
        .filter_map(|key| get_env_var(key).map(|value| ((*key).to_string(), value)))
        .collect()
}

fn candidate_paths() -> Vec<PathBuf> {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let mut paths = vec![cwd.join(".env"), cwd.join("src-tauri").join(".env")];

    if let Some(repo_root) = repo_root_from(&cwd) {
        paths.push(repo_root.join(".env"));
        paths.push(repo_root.join("src-tauri").join(".env"));
    }

    dedupe_paths(paths)
}

fn repo_root_from(cwd: &Path) -> Option<PathBuf> {
    if cwd.join("assistant-agent").exists() && cwd.join("src-tauri").exists() {
        return Some(cwd.to_path_buf());
    }

    let parent = cwd.parent()?;
    if parent.join("assistant-agent").exists() && parent.join("src-tauri").exists() {
        return Some(parent.to_path_buf());
    }

    None
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for path in paths {
        if !out.iter().any(|existing| existing == &path) {
            out.push(path);
        }
    }
    out
}
