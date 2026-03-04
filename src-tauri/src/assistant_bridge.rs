use crate::assistant_tools;
use crate::state::AppState;
use crate::types::{
    AssistantStreamEvent, AssistantToolTrace, AssistantTurnRequest, AssistantTurnResponse,
};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Condvar, Mutex};
use tauri::Emitter;

pub fn run_assistant_turn(
    state: &AppState,
    request: &AssistantTurnRequest,
    app_handle: &tauri::AppHandle,
) -> Result<AssistantTurnResponse, String> {
    const MAX_PARALLEL_TOOL_CALLS: usize = 4;
    let debug_enabled = assistant_debug_enabled();
    let mut child = spawn_agent_process()?;
    if debug_enabled {
        eprintln!(
            "[assistant-debug] bridge run-start stream_id={} selected_chat_id={:?} mentioned_chat_ids={:?}",
            request.stream_id, request.selected_chat_id, request.mentioned_chat_ids
        );
    }

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to open assistant stdin".to_string())?;
    let stdin = Arc::new(Mutex::new(stdin));
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to open assistant stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to open assistant stderr".to_string())?;

    let stderr_lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let stderr_lines_thread = Arc::clone(&stderr_lines);
    let stderr_handle = std::thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if let Ok(mut store) = stderr_lines_thread.lock() {
                store.push(line.clone());
                if store.len() > 20 {
                    store.remove(0);
                }
            }
            eprintln!("[assistant-agent] {}", line);
        }
    });

    let init = json!({
        "type": "run",
        "payload": {
            "selected_chat_id": request.selected_chat_id,
            "mentioned_chat_ids": request.mentioned_chat_ids,
            "selected_chat_context": &request.selected_chat_context,
            "mentioned_chat_contexts": &request.mentioned_chat_contexts,
            "model_provider": request.model_provider,
            "model_id": request.model_id,
            "user_message": request.user_message,
            "stream_id": request.stream_id,
            "conversation": request.conversation,
            "tooling": {
                "tools": [
                    "search_messages",
                    "search_all_chats",
                    "search_contacts",
                    "find_chats_by_contact",
                    "search_messages_by_contact",
                    "get_recent_messages",
                    "get_message_context",
                    "search_timeline",
                    "timeline_overview",
                    "run_readonly_sql"
                ]
            }
        }
    });

    {
        let mut writer = stdin
            .lock()
            .map_err(|_| "Failed to lock assistant stdin".to_string())?;
        writeln!(writer, "{}", init).map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
    }

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut final_seen = false;
    let mut streamed_text = String::new();
    let mut tool_workers: Vec<std::thread::JoinHandle<()>> = Vec::new();
    let tool_gate = Arc::new((Mutex::new(0usize), Condvar::new()));

    loop {
        line.clear();
        let bytes = reader.read_line(&mut line).map_err(|e| e.to_string())?;
        if bytes == 0 {
            break;
        }

        let payload: Value = match serde_json::from_str(line.trim()) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let message_type = payload.get("type").and_then(Value::as_str).unwrap_or("");
        match message_type {
            "tool_call" => {
                let id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "tool_call missing id".to_string())?
                    .to_string();
                let tool_name = payload
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .ok_or_else(|| "tool_call missing tool_name".to_string())?;
                let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));
                let stdin_writer = Arc::clone(&stdin);
                let tool_name_owned = tool_name.to_string();
                let id_owned = id.clone();
                let state_snapshot = state.clone();
                let tool_gate_clone = Arc::clone(&tool_gate);
                let worker = std::thread::spawn(move || {
                    let (gate_lock, gate_cv) = &*tool_gate_clone;
                    {
                        let mut in_flight = match gate_lock.lock() {
                            Ok(value) => value,
                            Err(_) => return,
                        };
                        while *in_flight >= MAX_PARALLEL_TOOL_CALLS {
                            in_flight = match gate_cv.wait(in_flight) {
                                Ok(value) => value,
                                Err(_) => return,
                            };
                        }
                        *in_flight += 1;
                    }

                    let response =
                        match assistant_tools::execute_tool(&state_snapshot, &tool_name_owned, args)
                        {
                            Ok(result) => json!({
                                "type": "tool_result",
                                "id": id_owned,
                                "ok": true,
                                "result": result,
                            }),
                            Err(err) => json!({
                                "type": "tool_result",
                                "id": id_owned,
                                "ok": false,
                                "error": err,
                            }),
                        };
                    if let Ok(mut writer) = stdin_writer.lock() {
                        let _ = writeln!(writer, "{}", response);
                        let _ = writer.flush();
                    }
                    if let Ok(mut in_flight) = gate_lock.lock() {
                        *in_flight = in_flight.saturating_sub(1);
                        gate_cv.notify_one();
                    }
                });
                tool_workers.push(worker);
            }
            "stream_event" => {
                if final_seen {
                    if debug_enabled {
                        eprintln!(
                            "[assistant-debug] bridge dropped post-final stream_event stream_id={}",
                            request.stream_id
                        );
                    }
                    continue;
                }
                let event: AssistantStreamEvent = serde_json::from_value(
                    payload
                        .get("event")
                        .cloned()
                        .ok_or_else(|| "stream_event missing event payload".to_string())?,
                )
                .map_err(|e| format!("Invalid stream event payload: {}", e))?;
                if debug_enabled {
                    eprintln!(
                        "[assistant-debug] bridge stream-event kind={} at_ms={}",
                        event.kind, event.at_ms
                    );
                }
                if event.kind == "text-delta" {
                    if let Some(delta) = &event.text {
                        streamed_text.push_str(delta);
                    }
                }

                emit_stream_event(app_handle, &request.stream_id, &event);
            }
            "final" => {
                if final_seen {
                    if debug_enabled {
                        eprintln!(
                            "[assistant-debug] bridge dropped duplicate final stream_id={}",
                            request.stream_id
                        );
                    }
                    continue;
                }
                final_seen = true;
                if debug_enabled && final_seen {
                    eprintln!(
                        "[assistant-debug] bridge marked final_seen stream_id={}",
                        request.stream_id
                    );
                }
                let text = payload
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();

                if debug_enabled {
                    eprintln!("[assistant-debug] bridge final text_len={}", text.len());
                }

                let tool_traces: Vec<AssistantToolTrace> = serde_json::from_value(
                    payload
                        .get("tool_traces")
                        .cloned()
                        .unwrap_or_else(|| json!([])),
                )
                .map_err(|e| format!("Invalid tool traces from assistant: {}", e))?;

                let duration_ms = payload.get("duration_ms").and_then(Value::as_u64);

                for worker in tool_workers.drain(..) {
                    let _ = worker.join();
                }
                let _ = child.wait();
                let _ = stderr_handle.join();

                return Ok(AssistantTurnResponse {
                    text,
                    duration_ms,
                    tool_traces,
                });
            }
            "error" => {
                let err = payload
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Assistant error")
                    .to_string();
                emit_stream_event(
                    app_handle,
                    &request.stream_id,
                    &AssistantStreamEvent {
                        kind: "run-error".to_string(),
                        at_ms: 0,
                        run_id: None,
                        pass_index: None,
                        pass_kind: None,
                        stream_text_enabled: None,
                        text: Some(err.clone()),
                        step_index: None,
                        tool_call_id: None,
                        tool_name: None,
                        input_preview: None,
                        output_preview: None,
                        success: None,
                        duration_ms: None,
                        finish_reason: None,
                    },
                );
                for worker in tool_workers.drain(..) {
                    let _ = worker.join();
                }
                let _ = child.wait();
                let _ = stderr_handle.join();
                return Err(err);
            }
            _ => {}
        }
    }

    for worker in tool_workers.drain(..) {
        let _ = worker.join();
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = stderr_handle.join();
    let stderr_tail = stderr_lines
        .lock()
        .ok()
        .map(|lines| {
            lines
                .iter()
                .filter(|line| !is_benign_agent_warning(line))
                .cloned()
                .collect::<Vec<String>>()
                .join(" | ")
        })
        .unwrap_or_default();

    if !status.success() {
        if stderr_tail.is_empty() {
            return Err(format!("Assistant agent exited with status {}", status));
        }
        return Err(format!(
            "Assistant agent exited with status {}. Details: {}",
            status, stderr_tail
        ));
    }

    if !streamed_text.trim().is_empty() {
        return Ok(AssistantTurnResponse {
            text: streamed_text.trim().to_string(),
            duration_ms: None,
            tool_traces: Vec::new(),
        });
    }

    if stderr_tail.is_empty() {
        Err(format!(
            "Assistant agent exited before returning a final response (status: {})",
            status
        ))
    } else {
        Err(format!(
            "Assistant agent exited before returning a final response (status: {}). Details: {}",
            status, stderr_tail
        ))
    }
}

fn assistant_debug_enabled() -> bool {
    std::env::var("ASSISTANT_DEBUG")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(false)
}

fn is_benign_agent_warning(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("ai sdk warning")
        && (lower.contains("specificationversion") || lower.contains("compatibility mode"))
}

fn emit_stream_event(app_handle: &tauri::AppHandle, stream_id: &str, event: &AssistantStreamEvent) {
    let topic = format!("assistant-stream:{}", stream_id);
    let _ = app_handle.emit(&topic, event);
}

fn spawn_agent_process() -> Result<std::process::Child, String> {
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    let script_path = resolve_script_path(&cwd)?;

    let mut cmd = Command::new("node");
    cmd.arg(script_path)
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    cmd.spawn().map_err(|e| {
        format!(
            "Failed to start assistant sidecar. Ensure Node.js is installed: {}",
            e
        )
    })
}

fn resolve_script_path(cwd: &std::path::Path) -> Result<PathBuf, String> {
    let candidates = [
        cwd.join("assistant-agent").join("run-turn.mjs"),
        cwd.join("assistant-agent")
            .join("dist")
            .join("run-turn.mjs"),
        cwd.join("..").join("assistant-agent").join("run-turn.mjs"),
        cwd.join("..")
            .join("assistant-agent")
            .join("dist")
            .join("run-turn.mjs"),
    ];

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(format!(
        "Could not find assistant sidecar script. Checked paths relative to cwd {}",
        cwd.display()
    ))
}
