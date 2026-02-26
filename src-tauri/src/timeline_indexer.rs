use crate::db;
use crate::timeline_ai;
use crate::timeline_ai::{
    AiBatchContext, AiMemoryInput, AiMergeContext, AiMergeInputNode, AiMessageInput,
    AiParticipant, AiSpan,
};
use crate::timeline_db;
use crate::timeline_types::{
    TimelineBatchRecord, TimelineEvidenceInsert, TimelineJobState, TimelineMediaInsightInsert,
    TimelineMemoryInsert, TimelineMetaRecord, TimelineNodeInsert, TimelineNodeLinkInsert,
    TimelineNodeMemoryLinkInsert, TIMELINE_PROMPT_VERSION, TIMELINE_SCHEMA_VERSION,
};
use imessage_database::util::platform::Platform;
use rusqlite::Connection;
use std::cmp::{max, min};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const BATCH_MESSAGE_COUNT: usize = 55;
const MAX_MSG_TEXT_CHARS: usize = 420;
const MAX_BATCH_PAYLOAD_CHARS: usize = 22_000;
const MAX_AI_ATTEMPTS: i32 = 4;
const RETRY_BACKOFF_MS: [u64; 3] = [1500, 4000, 10000];
const RETRY_JITTER_PCT: u64 = 20;
const MAX_IMAGE_CAPTIONS: usize = 12;
const MAX_CONTEXT_IMAGE_DESCRIPTIONS_PER_RUN: usize = 18;
const MAX_CONTEXT_IMAGE_DESCRIPTIONS_PER_MESSAGE: usize = 2;
const DEFAULT_L3_PARALLELISM: usize = 3;
const MIN_PARENT_COVERAGE_LEVEL_GT0: f32 = 0.98;

#[derive(Clone, Debug)]
struct AttachmentFeature {
    attachment_rowid: i32,
    mime_type: String,
    is_image: bool,
}

#[derive(Clone, Debug)]
struct MessageFeature {
    rowid: i32,
    text: String,
    is_from_me: bool,
    sender_name: Option<String>,
    iso_ts: String,
    reaction_count: i32,
    reply_root_guid: Option<String>,
    attachments: Vec<AttachmentFeature>,
}

#[derive(Clone, Debug)]
struct ChatContext {
    chat_title: String,
    participants: Vec<AiParticipant>,
    conversation_span: AiSpan,
}

#[derive(Clone, Debug)]
struct BatchWindow {
    seq: i32,
    start_idx: usize,
    end_idx: usize,
    start_rowid: i32,
    end_rowid: i32,
}

#[derive(Clone, Debug)]
struct BatchExecutionResult {
    window: BatchWindow,
    batch_record: TimelineBatchRecord,
    output: Result<timeline_ai::AiBatchOutput, String>,
    elapsed_ms: u128,
}

#[derive(Clone, Debug)]
pub struct TimelineRunConfig {
    pub chat_id: i32,
    pub full_rebuild: bool,
    pub resume_failed_only: bool,
}

pub fn run_timeline_index_job(
    source_db_path: PathBuf,
    timeline_db_path: PathBuf,
    contact_names: HashMap<String, String>,
    running_jobs: Arc<Mutex<HashSet<i32>>>,
    cancel_jobs: Arc<Mutex<HashSet<i32>>>,
    config: TimelineRunConfig,
) {
    let started = Instant::now();
    let result = run_timeline_index_job_inner(
        &source_db_path,
        &timeline_db_path,
        &contact_names,
        &running_jobs,
        &cancel_jobs,
        &config,
    );

    if let Err(err) = result {
        eprintln!(
            "[timeline-v2] job failed for chat {}: {}",
            config.chat_id, err
        );
        if let Ok(conn) = timeline_db::open_rw(&timeline_db_path) {
            let mut failed = TimelineJobState::idle(config.chat_id);
            failed.status = "failed".to_string();
            failed.phase = "finalizing".to_string();
            failed.progress = 1.0;
            failed.updated_at = Some(timeline_db::now_iso());
            failed.finished_at = Some(timeline_db::now_iso());
            failed.error = Some(err.clone());
            failed.degraded = true;
            failed.run_id = Some(format!("failed-{}", Uuid::new_v4()));
            let _ = timeline_db::set_job_state(
                &conn,
                &failed,
                failed.run_id.as_deref().unwrap_or("failed"),
            );

            if let Ok(existing_meta) = timeline_db::get_meta(&conn, config.chat_id) {
                let _ = timeline_db::upsert_meta(
                    &conn,
                    &TimelineMetaRecord {
                        chat_id: config.chat_id,
                        schema_version: TIMELINE_SCHEMA_VERSION,
                        source_max_rowid: existing_meta
                            .as_ref()
                            .map(|m| m.source_max_rowid)
                            .unwrap_or(0),
                        indexed_max_rowid: existing_meta
                            .as_ref()
                            .map(|m| m.indexed_max_rowid)
                            .unwrap_or(0),
                        indexed_at: existing_meta.as_ref().and_then(|m| m.indexed_at.clone()),
                        openai_used: existing_meta
                            .as_ref()
                            .map(|m| m.openai_used)
                            .unwrap_or(false),
                        last_error: Some(err),
                        prompt_version: TIMELINE_PROMPT_VERSION,
                        index_health: "failed".to_string(),
                        last_successful_run_at: existing_meta
                            .as_ref()
                            .and_then(|m| m.last_successful_run_at.clone()),
                    },
                );
            }
        }
    } else {
        eprintln!(
            "[timeline-v2] run completed chat={} full_rebuild={} resume_failed_only={} elapsed_ms={}",
            config.chat_id,
            config.full_rebuild,
            config.resume_failed_only,
            started.elapsed().as_millis()
        );
    }

    if let Ok(mut running) = running_jobs.lock() {
        running.remove(&config.chat_id);
    }
    if let Ok(mut canceled) = cancel_jobs.lock() {
        canceled.remove(&config.chat_id);
    }
}

fn run_timeline_index_job_inner(
    source_db_path: &Path,
    timeline_db_path: &Path,
    contact_names: &HashMap<String, String>,
    _running_jobs: &Arc<Mutex<HashSet<i32>>>,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
    config: &TimelineRunConfig,
) -> Result<(), String> {
    let run_started = Instant::now();
    let mut timeline_conn = timeline_db::open_rw(timeline_db_path)
        .map_err(|e| format!("Failed to open timeline DB: {}", e))?;

    let source_conn =
        Connection::open_with_flags(source_db_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("Failed to open source chat DB: {}", e))?;

    let source_max_rowid = query_source_max_rowid(&source_conn, config.chat_id)
        .map_err(|e| format!("Failed to query source max rowid: {}", e))?;

    let existing_meta = timeline_db::get_meta(&timeline_conn, config.chat_id)
        .map_err(|e| format!("Failed to read timeline metadata: {}", e))?;

    let needs_rebuild_for_prompt = existing_meta
        .as_ref()
        .map(|m| m.prompt_version != TIMELINE_PROMPT_VERSION)
        .unwrap_or(true);
    let full_rebuild = config.full_rebuild || needs_rebuild_for_prompt;
    let l3_parallelism = timeline_l3_parallelism();

    let run_id = Uuid::new_v4().to_string();
    eprintln!(
        "[timeline-v2] start chat={} run_id={} full_rebuild={} resume_failed_only={} source_max_rowid={} l3_parallelism={}",
        config.chat_id,
        run_id,
        full_rebuild,
        config.resume_failed_only,
        source_max_rowid,
        l3_parallelism
    );
    timeline_db::create_run(
        &timeline_conn,
        &run_id,
        config.chat_id,
        TIMELINE_PROMPT_VERSION,
        TIMELINE_SCHEMA_VERSION,
        &timeline_ai::openai_model_text(),
        &timeline_ai::openai_model_media(),
    )
    .map_err(|e| format!("Failed to create timeline run: {}", e))?;

    let mut job = TimelineJobState::idle(config.chat_id);
    job.status = "running".to_string();
    job.phase = "scanning".to_string();
    job.progress = 0.01;
    job.started_at = Some(timeline_db::now_iso());
    job.updated_at = Some(timeline_db::now_iso());
    job.run_id = Some(run_id.clone());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to initialize timeline job state: {}", e))?;

    let messages = load_message_features(&source_conn, config.chat_id, contact_names)
        .map_err(|e| format!("Failed to load messages for timeline indexing: {}", e))?;
    let chat_context = load_chat_context(&source_conn, config.chat_id, contact_names)
        .map_err(|e| format!("Failed to load chat context for timeline indexing: {}", e))?;
    let mut media_context_cache = load_cached_media_descriptions(&timeline_conn, config.chat_id)
        .map_err(|e| format!("Failed to load cached media descriptions: {}", e))?;
    let mut context_media_generated = 0usize;
    let mut context_media_insights: Vec<TimelineMediaInsightInsert> = Vec::new();

    if is_canceled(cancel_jobs, config.chat_id) {
        mark_canceled(&timeline_conn, &run_id, &mut job)?;
        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
        return Ok(());
    }

    job.total_messages = messages.len() as i32;
    job.processed_messages = 0;
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to update timeline job totals: {}", e))?;

    let mut windows = if config.resume_failed_only {
        failed_windows_from_db(&timeline_conn, &messages, config.chat_id)
            .map_err(|e| format!("Failed to load failed batches: {}", e))?
    } else {
        build_windows(&messages)
    };

    if windows.is_empty() {
        windows = build_windows(&messages);
    }
    eprintln!(
        "[timeline-v2] run_id={} chat={} messages={} windows={} mode={}",
        run_id,
        config.chat_id,
        messages.len(),
        windows.len(),
        if config.resume_failed_only {
            "resume_failed_only"
        } else if full_rebuild {
            "full_rebuild"
        } else {
            "incremental_or_refresh"
        }
    );

    let mut temp_id_seed = 1_i64;
    let mut accumulated_nodes = if config.resume_failed_only {
        load_existing_nodes_for_resume(&timeline_conn, config.chat_id, &mut temp_id_seed)?
    } else {
        Vec::new()
    };
    accumulated_nodes.retain(|n| n.level == 3);

    let mut accumulated_evidence: Vec<TimelineEvidenceInsert> = Vec::new();
    let mut accumulated_links: Vec<TimelineNodeLinkInsert> = Vec::new();
    let mut accumulated_memories =
        load_existing_memories_for_resume(&timeline_conn, config.chat_id)?;
    let mut accumulated_memory_links: Vec<TimelineNodeMemoryLinkInsert> = Vec::new();

    let mut failed_batches = 0_i32;
    let mut completed_batches = 0_i32;
    let mut had_any_success = !accumulated_nodes.is_empty();
    let mut openai_used = false;
    let mut processed_windows = 0usize;

    for chunk in windows.chunks(l3_parallelism) {
        if is_canceled(cancel_jobs, config.chat_id) {
            mark_canceled(&timeline_conn, &run_id, &mut job)?;
            let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
            return Ok(());
        }

        job.phase = "batch-index".to_string();
        job.progress = 0.05 + ((processed_windows as f32) / (windows.len().max(1) as f32)) * 0.45;
        job.updated_at = Some(timeline_db::now_iso());
        timeline_db::set_job_state(&timeline_conn, &job, &run_id)
            .map_err(|e| format!("Failed to persist batch progress: {}", e))?;

        let mut pending: Vec<(BatchWindow, AiBatchContext, TimelineBatchRecord)> = Vec::new();
        for window in chunk {
            let batch_id = format!("{}-{}", &run_id, window.seq);
            let batch_record = TimelineBatchRecord {
                batch_id: batch_id.clone(),
                run_id: run_id.clone(),
                seq: window.seq,
                start_rowid: window.start_rowid,
                end_rowid: window.end_rowid,
                status: "running".to_string(),
                retry_count: 0,
                error: None,
                completed_at: None,
            };
            timeline_db::upsert_batch(&timeline_conn, &batch_record)
                .map_err(|e| format!("Failed to persist running batch state: {}", e))?;

            let recent_context = collect_recent_context(&accumulated_nodes);
            let long_term_memories = collect_long_term_memory_inputs(&accumulated_memories);
            let window_media_descriptions = collect_window_media_descriptions(
                &source_conn,
                source_db_path,
                config.chat_id,
                &messages[window.start_idx..=window.end_idx],
                &mut media_context_cache,
                &mut context_media_generated,
                &mut context_media_insights,
            );
            let ai_context = build_batch_context(
                config.chat_id,
                &batch_id,
                window,
                &messages,
                &chat_context,
                &window_media_descriptions,
                recent_context,
                long_term_memories,
            );
            pending.push((window.clone(), ai_context, batch_record));
        }

        let mut handles = Vec::new();
        for (window, ai_context, mut batch_record) in pending {
            let cancel_jobs = cancel_jobs.clone();
            let chat_id = config.chat_id;
            let run_id_for_batch = run_id.clone();
            handles.push(thread::spawn(move || {
                let started = Instant::now();
                let output = run_batch_with_retries(
                    &run_id_for_batch,
                    &ai_context,
                    &mut batch_record,
                    &cancel_jobs,
                    chat_id,
                );
                BatchExecutionResult {
                    window,
                    batch_record,
                    output,
                    elapsed_ms: started.elapsed().as_millis(),
                }
            }));
        }

        let mut chunk_results = Vec::new();
        for handle in handles {
            match handle.join() {
                Ok(result) => chunk_results.push(result),
                Err(_) => return Err("A timeline batch worker panicked".to_string()),
            }
        }
        chunk_results.sort_by_key(|r| r.window.seq);

        for mut result in chunk_results {
            match result.output {
                Ok(out) => {
                    openai_used = true;
                    had_any_success = true;
                    completed_batches += 1;

                    append_batch_output(
                        config.chat_id,
                        &result.batch_record.batch_id,
                        &out,
                        &messages,
                        &chat_context,
                        &mut temp_id_seed,
                        &mut accumulated_nodes,
                        &mut accumulated_evidence,
                        &mut accumulated_links,
                        &mut accumulated_memories,
                        &mut accumulated_memory_links,
                    );

                    result.batch_record.status = "completed".to_string();
                    result.batch_record.completed_at = Some(timeline_db::now_iso());
                    result.batch_record.error = None;
                    eprintln!(
                        "[timeline-v2] l3 batch ok run_id={} batch={} seq={} rows=[{}..={}] nodes={} related={} memories={} retries={} elapsed_ms={}",
                        run_id,
                        result.batch_record.batch_id,
                        result.window.seq,
                        result.window.start_rowid,
                        result.window.end_rowid,
                        out.nodes.len(),
                        out.related.len(),
                        out.memories.len(),
                        result.batch_record.retry_count,
                        result.elapsed_ms
                    );
                }
                Err(err) => {
                    if err == "Canceled by user" || is_canceled(cancel_jobs, config.chat_id) {
                        mark_canceled(&timeline_conn, &run_id, &mut job)?;
                        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
                        return Ok(());
                    }
                    failed_batches += 1;
                    job.degraded = true;
                    result.batch_record.status = "failed".to_string();
                    result.batch_record.error = Some(err);
                    eprintln!(
                        "[timeline-v2] l3 batch failed run_id={} batch={} seq={} rows=[{}..={}] retries={} elapsed_ms={} err={}",
                        run_id,
                        result.batch_record.batch_id,
                        result.window.seq,
                        result.window.start_rowid,
                        result.window.end_rowid,
                        result.batch_record.retry_count,
                        result.elapsed_ms,
                        result.batch_record.error.clone().unwrap_or_default()
                    );
                }
            }

            timeline_db::upsert_batch(&timeline_conn, &result.batch_record)
                .map_err(|e| format!("Failed to persist batch state: {}", e))?;

            processed_windows += 1;
            job.failed_batches = failed_batches;
            job.completed_batches = completed_batches;
            job.processed_messages += (result.window.end_idx - result.window.start_idx + 1) as i32;
            job.progress =
                0.05 + ((processed_windows as f32) / (windows.len().max(1) as f32)) * 0.45;
            job.updated_at = Some(timeline_db::now_iso());
            timeline_db::set_job_state(&timeline_conn, &job, &run_id)
                .map_err(|e| format!("Failed to persist batch counters: {}", e))?;
        }
    }

    if had_any_success {
        append_prev_moment_links(&accumulated_nodes, &mut accumulated_links);
    }

    if had_any_success {
        let hierarchy_started = Instant::now();
        job.phase = "hierarchy".to_string();
        job.progress = 0.6;
        job.updated_at = Some(timeline_db::now_iso());
        timeline_db::set_job_state(&timeline_conn, &job, &run_id)
            .map_err(|e| format!("Failed to persist hierarchy phase: {}", e))?;

        let hierarchy_input = build_merge_context(config.chat_id, &accumulated_nodes);
        if !hierarchy_input.nodes.is_empty() {
            match run_merge_with_retries(&run_id, &hierarchy_input, cancel_jobs, config.chat_id) {
                Ok(merge_output) => {
                    openai_used = true;
                    append_merge_output(
                        config.chat_id,
                        &merge_output,
                        &messages,
                        &chat_context,
                        &mut temp_id_seed,
                        &mut accumulated_nodes,
                        &mut accumulated_links,
                    );
                    eprintln!(
                        "[timeline-v2] hierarchy ok run_id={} nodes={} related={} elapsed_ms={}",
                        run_id,
                        merge_output.nodes.len(),
                        merge_output.related.len(),
                        hierarchy_started.elapsed().as_millis()
                    );
                }
                Err(err) => {
                    if err == "Canceled by user" || is_canceled(cancel_jobs, config.chat_id) {
                        mark_canceled(&timeline_conn, &run_id, &mut job)?;
                        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
                        return Ok(());
                    }
                    job.degraded = true;
                    job.error = Some(format!("Hierarchy synthesis degraded: {}", err));
                    eprintln!(
                        "[timeline-v2] hierarchy degraded run_id={} elapsed_ms={} err={}",
                        run_id,
                        hierarchy_started.elapsed().as_millis(),
                        err
                    );
                }
            }
        }
    }

    enforce_hierarchy_backbone(
        config.chat_id,
        &messages,
        &chat_context,
        &mut temp_id_seed,
        &mut accumulated_nodes,
    );
    if !accumulated_nodes.is_empty() {
        had_any_success = true;
    }
    normalize_node_ordinals(&mut accumulated_nodes);
    let mut invariants = validate_hierarchy_invariants(&messages, &accumulated_nodes);
    if let Err(err) = &invariants {
        eprintln!(
            "[timeline-v2] invariant repair retry run_id={} chat={} err={}",
            run_id, config.chat_id, err
        );
        enforce_hierarchy_backbone(
            config.chat_id,
            &messages,
            &chat_context,
            &mut temp_id_seed,
            &mut accumulated_nodes,
        );
        normalize_node_ordinals(&mut accumulated_nodes);
        invariants = validate_hierarchy_invariants(&messages, &accumulated_nodes);
    }
    if let Err(err) = &invariants {
        job.degraded = true;
        job.error = Some(match job.error.take() {
            Some(existing) => format!("{} | invariant failure: {}", existing, err),
            None => format!("invariant failure: {}", err),
        });
    }
    accumulated_links.retain(|link| link.link_type != "prev_moment");
    append_prev_moment_links(&accumulated_nodes, &mut accumulated_links);
    let valid_node_ids: HashSet<i64> = accumulated_nodes.iter().map(|n| n.temp_id).collect();
    accumulated_evidence.retain(|ev| valid_node_ids.contains(&ev.node_temp_id));
    let mut has_evidence: HashSet<i64> = accumulated_evidence
        .iter()
        .map(|ev| ev.node_temp_id)
        .collect();
    for node in &accumulated_nodes {
        if has_evidence.insert(node.temp_id) {
            accumulated_evidence.push(TimelineEvidenceInsert {
                node_temp_id: node.temp_id,
                rowid: node.representative_rowid,
                reason: "anchor".to_string(),
                weight: node.confidence.max(0.1),
            });
        }
    }

    let parent_stats = compute_parent_stats(&accumulated_nodes);
    if parent_stats.total_level_gt0 > 0
        && parent_stats.coverage_level_gt0 < MIN_PARENT_COVERAGE_LEVEL_GT0
    {
        job.degraded = true;
        let msg = format!(
            "Parent coverage low ({:.1}% linked at L>0)",
            parent_stats.coverage_level_gt0 * 100.0
        );
        job.error = Some(match job.error.take() {
            Some(existing) => format!("{} | {}", existing, msg),
            None => msg,
        });
    }
    eprintln!(
        "[timeline-v2] parent-stats run_id={} chat={} level0={}/{} level1={}/{} level2={}/{} level3={}/{} linked_l_gt0={}/{} coverage_l_gt0={:.1}%",
        run_id,
        config.chat_id,
        parent_stats.level_linked[0],
        parent_stats.level_total[0],
        parent_stats.level_linked[1],
        parent_stats.level_total[1],
        parent_stats.level_linked[2],
        parent_stats.level_total[2],
        parent_stats.level_linked[3],
        parent_stats.level_total[3],
        parent_stats.linked_level_gt0,
        parent_stats.total_level_gt0,
        parent_stats.coverage_level_gt0 * 100.0
    );

    let mut media_insights = Vec::new();
    if had_any_success {
        let media_started = Instant::now();
        job.phase = "media-pass".to_string();
        job.progress = 0.8;
        job.updated_at = Some(timeline_db::now_iso());
        timeline_db::set_job_state(&timeline_conn, &job, &run_id)
            .map_err(|e| format!("Failed to persist media phase: {}", e))?;

        media_insights = run_media_refinement(
            &source_conn,
            source_db_path,
            config.chat_id,
            &messages,
            &mut accumulated_nodes,
            cancel_jobs,
        );
        media_insights.extend(context_media_insights);
        if !media_insights.is_empty() {
            openai_used = true;
        }
        eprintln!(
            "[timeline-v2] media pass run_id={} insights={} elapsed_ms={}",
            run_id,
            media_insights.len(),
            media_started.elapsed().as_millis()
        );
    }

    let has_failed = failed_batches > 0;
    let high_level_drafts = accumulated_nodes
        .iter()
        .any(|n| n.level <= 2 && n.is_draft);
    let index_health = if had_any_success {
        if has_failed || job.degraded || high_level_drafts {
            "partial"
        } else {
            "complete"
        }
    } else {
        "failed"
    }
    .to_string();

    timeline_db::replace_chat_timeline(
        &mut timeline_conn,
        config.chat_id,
        &accumulated_nodes,
        &accumulated_evidence,
        &accumulated_links,
        &media_insights,
        &accumulated_memories,
        &accumulated_memory_links,
    )
    .map_err(|e| format!("Failed to persist final timeline: {}", e))?;

    timeline_db::upsert_meta(
        &timeline_conn,
        &TimelineMetaRecord {
            chat_id: config.chat_id,
            schema_version: TIMELINE_SCHEMA_VERSION,
            source_max_rowid,
            indexed_max_rowid: if had_any_success { source_max_rowid } else { 0 },
            indexed_at: Some(timeline_db::now_iso()),
            openai_used,
            last_error: job.error.clone(),
            prompt_version: TIMELINE_PROMPT_VERSION,
            index_health: index_health.clone(),
            last_successful_run_at: if index_health == "complete" {
                Some(timeline_db::now_iso())
            } else {
                existing_meta.and_then(|m| m.last_successful_run_at)
            },
        },
    )
    .map_err(|e| format!("Failed to update timeline metadata: {}", e))?;

    job.phase = "finalizing".to_string();
    job.progress = 1.0;
    job.status = if index_health == "failed" {
        "failed".to_string()
    } else {
        "completed".to_string()
    };
    job.failed_batches = failed_batches;
    job.completed_batches = completed_batches;
    job.degraded = index_health != "complete";
    job.openai_used = openai_used;
    job.updated_at = Some(timeline_db::now_iso());
    job.finished_at = Some(timeline_db::now_iso());

    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to finalize timeline job state: {}", e))?;

    let run_status = if job.status == "completed" && !job.degraded {
        "completed"
    } else if job.status == "failed" {
        "failed"
    } else {
        "partial"
    };
    let _ = timeline_db::finish_run(&timeline_conn, &run_id, run_status);

    let link_type_counts = count_link_types(&accumulated_links);
    let coverage = compute_message_coverage_by_level(&messages, &accumulated_nodes);
    let duplicate_ordinals = duplicate_ordinal_counts(&accumulated_nodes);
    let low_value = low_value_summary_counts(&accumulated_nodes);
    let sentence_avg = average_sentence_counts(&accumulated_nodes);
    eprintln!(
        "[timeline-v2] finalize run_id={} chat={} status={} health={} completed_batches={} failed_batches={} nodes={} media_insights={} links={} coverage_l3={}/{} coverage_l2={}/{} coverage_l1={}/{} coverage_l0={}/{} dup_ord_l0={} dup_ord_l1={} dup_ord_l2={} dup_ord_l3={} low_value_l0={} low_value_l1={} low_value_l2={} low_value_l3={} avg_sent_l0={:.2} avg_sent_l1={:.2} avg_sent_l2={:.2} avg_sent_l3={:.2} elapsed_ms={}",
        run_id,
        config.chat_id,
        job.status,
        index_health,
        completed_batches,
        failed_batches,
        accumulated_nodes.len(),
        media_insights.len(),
        link_type_counts,
        coverage.covered[3],
        coverage.total_messages,
        coverage.covered[2],
        coverage.total_messages,
        coverage.covered[1],
        coverage.total_messages,
        coverage.covered[0],
        coverage.total_messages,
        duplicate_ordinals[0],
        duplicate_ordinals[1],
        duplicate_ordinals[2],
        duplicate_ordinals[3],
        low_value[0],
        low_value[1],
        low_value[2],
        low_value[3],
        sentence_avg[0],
        sentence_avg[1],
        sentence_avg[2],
        sentence_avg[3],
        run_started.elapsed().as_millis()
    );

    Ok(())
}

fn run_batch_with_retries(
    run_id: &str,
    context: &AiBatchContext,
    batch_record: &mut TimelineBatchRecord,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
    chat_id: i32,
) -> Result<timeline_ai::AiBatchOutput, String> {
    let mut retry_context = context.clone();
    let mut last_err: Option<String> = None;
    for attempt in 1..=MAX_AI_ATTEMPTS {
        if is_canceled(cancel_jobs, chat_id) {
            return Err("Canceled by user".to_string());
        }
        batch_record.retry_count = attempt - 1;
        match timeline_ai::generate_l3_moments(&retry_context) {
            Ok(v) => return Ok(v),
            Err(e) => {
                if is_canceled(cancel_jobs, chat_id) {
                    return Err("Canceled by user".to_string());
                }
                let retryable = timeline_ai::is_retryable_ai_error(&e);
                if e.contains("max_output_tokens")
                    && attempt < MAX_AI_ATTEMPTS
                    && retry_context.tier1_local_messages.len() > 10
                {
                    let prev = retry_context.tier1_local_messages.len();
                    let keep = (prev / 2).max(10);
                    retry_context.tier1_local_messages.truncate(keep);
                    retry_context.tier2_recent_context.truncate(3);
                    retry_context.tier3_long_term_memories.truncate(8);
                    eprintln!(
                        "[timeline-v2] batch retry shrink batch_id={} attempt={} reason=max_output_tokens messages={} -> {}",
                        context.batch_id,
                        attempt,
                        prev,
                        keep
                    );
                }
                eprintln!(
                    "[timeline-v2] ai retry run_id={} chat={} stage=l3-batch batch_id={} attempt={}/{} retryable={} err={}",
                    run_id,
                    chat_id,
                    context.batch_id,
                    attempt,
                    MAX_AI_ATTEMPTS,
                    retryable,
                    e
                );
                last_err = Some(e);
                if attempt < MAX_AI_ATTEMPTS && retryable {
                    let backoff_ms = backoff_with_jitter_ms(attempt);
                    eprintln!(
                        "[timeline-v2] ai retry sleep run_id={} chat={} stage=l3-batch batch_id={} attempt={} backoff_ms={}",
                        run_id, chat_id, context.batch_id, attempt, backoff_ms
                    );
                    thread::sleep(Duration::from_millis(backoff_ms));
                } else if !retryable {
                    break;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Unknown AI batch failure".to_string()))
}

fn run_merge_with_retries(
    run_id: &str,
    context: &AiMergeContext,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
    chat_id: i32,
) -> Result<timeline_ai::AiMergeOutput, String> {
    let mut last_err: Option<String> = None;
    for attempt in 1..=MAX_AI_ATTEMPTS {
        if is_canceled(cancel_jobs, chat_id) {
            return Err("Canceled by user".to_string());
        }
        match timeline_ai::generate_hierarchy(context) {
            Ok(v) => return Ok(v),
            Err(e) => {
                if is_canceled(cancel_jobs, chat_id) {
                    return Err("Canceled by user".to_string());
                }
                let retryable = timeline_ai::is_retryable_ai_error(&e);
                eprintln!(
                    "[timeline-v2] ai retry run_id={} chat={} stage=hierarchy attempt={}/{} retryable={} err={}",
                    run_id, chat_id, attempt, MAX_AI_ATTEMPTS, retryable, e
                );
                last_err = Some(e);
                if attempt < MAX_AI_ATTEMPTS && retryable {
                    let backoff_ms = backoff_with_jitter_ms(attempt);
                    eprintln!(
                        "[timeline-v2] ai retry sleep run_id={} chat={} stage=hierarchy attempt={} backoff_ms={}",
                        run_id, chat_id, attempt, backoff_ms
                    );
                    thread::sleep(Duration::from_millis(backoff_ms));
                } else if !retryable {
                    break;
                }
            }
        }
    }
    Err(last_err.unwrap_or_else(|| "Unknown AI merge failure".to_string()))
}

fn load_message_features(
    conn: &Connection,
    chat_id: i32,
    contact_names: &HashMap<String, String>,
) -> Result<Vec<MessageFeature>, Box<dyn std::error::Error + Send + Sync>> {
    let attachments_map = load_message_attachments(conn, chat_id)?;
    let reaction_counts = load_reaction_counts(conn, chat_id)?;
    let handle_lookup = load_handle_lookup(conn)?;

    let mut stmt = conn.prepare(
        "SELECT m.ROWID, m.guid, m.text, m.is_from_me, m.date, m.thread_originator_guid, m.handle_id
         FROM message m
         JOIN chat_message_join c ON c.message_id = m.ROWID
         WHERE c.chat_id = ?1
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
         ORDER BY m.ROWID ASC",
    )?;

    let rows = stmt.query_map([chat_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, Option<String>>(2)?,
            row.get::<_, bool>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, Option<String>>(5)?,
            row.get::<_, Option<i32>>(6)?,
        ))
    })?;

    let mut messages = Vec::new();
    for row in rows {
        let (rowid, guid, text, is_from_me, apple_ts, reply_guid, handle_id) = row?;
        let normalized = normalize_text(text.as_deref().unwrap_or(""));
        let sender_name = if is_from_me {
            Some("Me".to_string())
        } else {
            handle_id
                .and_then(|hid| handle_lookup.get(&hid).cloned())
                .map(|raw| resolve_sender_display_name(&raw, contact_names))
        };

        messages.push(MessageFeature {
            rowid,
            text: normalized,
            is_from_me,
            sender_name,
            iso_ts: db::apple_timestamp_to_iso(apple_ts).unwrap_or_else(|| timeline_db::now_iso()),
            reaction_count: reaction_counts.get(&guid).copied().unwrap_or(0),
            reply_root_guid: reply_guid,
            attachments: attachments_map.get(&rowid).cloned().unwrap_or_default(),
        });
    }

    Ok(messages)
}

fn load_handle_lookup(
    conn: &Connection,
) -> Result<HashMap<i32, String>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare("SELECT ROWID, id FROM handle")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut map = HashMap::new();
    for row in rows {
        let (id, value) = row?;
        map.insert(id, value);
    }
    Ok(map)
}

fn load_message_attachments(
    conn: &Connection,
    chat_id: i32,
) -> Result<HashMap<i32, Vec<AttachmentFeature>>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare(
        "SELECT maj.message_id, a.ROWID, COALESCE(a.mime_type, '')
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         JOIN chat_message_join c ON c.message_id = maj.message_id
         WHERE c.chat_id = ?1",
    )?;

    let rows = stmt.query_map([chat_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, String>(2)?,
        ))
    })?;

    let mut map: HashMap<i32, Vec<AttachmentFeature>> = HashMap::new();
    for row in rows {
        let (message_rowid, attachment_rowid, mime_type) = row?;
        map.entry(message_rowid)
            .or_default()
            .push(AttachmentFeature {
                attachment_rowid,
                is_image: mime_type.to_lowercase().starts_with("image/"),
                mime_type,
            });
    }

    Ok(map)
}

fn load_reaction_counts(
    conn: &Connection,
    chat_id: i32,
) -> Result<HashMap<String, i32>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare(
        "SELECT m.associated_message_guid
         FROM message m
         JOIN chat_message_join c ON c.message_id = m.ROWID
         WHERE c.chat_id = ?1
           AND m.associated_message_type >= 2000
           AND m.associated_message_type < 3000
           AND m.associated_message_guid IS NOT NULL",
    )?;

    let rows = stmt.query_map([chat_id], |row| row.get::<_, String>(0))?;

    let mut counts: HashMap<String, i32> = HashMap::new();
    for raw in rows.flatten() {
        let guid = extract_target_guid(&raw);
        *counts.entry(guid).or_insert(0) += 1;
    }

    Ok(counts)
}

fn extract_target_guid(assoc_guid: &str) -> String {
    if let Some(pos) = assoc_guid.find('/') {
        assoc_guid[pos + 1..].to_string()
    } else if let Some(stripped) = assoc_guid.strip_prefix("bp:") {
        stripped.to_string()
    } else {
        assoc_guid.to_string()
    }
}

fn normalize_text(raw: &str) -> String {
    raw.replace('\u{FFFC}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn build_windows(messages: &[MessageFeature]) -> Vec<BatchWindow> {
    if messages.is_empty() {
        return Vec::new();
    }

    let mut windows = Vec::new();
    let mut start = 0usize;
    let mut seq = 0;

    while start < messages.len() {
        let end = min(start + BATCH_MESSAGE_COUNT - 1, messages.len() - 1);
        windows.push(BatchWindow {
            seq,
            start_idx: start,
            end_idx: end,
            start_rowid: messages[start].rowid,
            end_rowid: messages[end].rowid,
        });
        start = end + 1;
        seq += 1;
    }

    windows
}

fn failed_windows_from_db(
    conn: &Connection,
    messages: &[MessageFeature],
    chat_id: i32,
) -> Result<Vec<BatchWindow>, Box<dyn std::error::Error + Send + Sync>> {
    let failed = timeline_db::latest_failed_batches(conn, chat_id)?;
    if failed.is_empty() {
        return Ok(Vec::new());
    }

    let mut result = Vec::new();
    for (seq, start_rowid, end_rowid) in failed {
        if let Some((start_idx, end_idx)) = locate_rowid_bounds(messages, start_rowid, end_rowid) {
            result.push(BatchWindow {
                seq,
                start_idx,
                end_idx,
                start_rowid,
                end_rowid,
            });
        }
    }

    Ok(result)
}

fn locate_rowid_bounds(
    messages: &[MessageFeature],
    start_rowid: i32,
    end_rowid: i32,
) -> Option<(usize, usize)> {
    let mut start_idx = None;
    let mut end_idx = None;

    for (i, msg) in messages.iter().enumerate() {
        if start_idx.is_none() && msg.rowid >= start_rowid {
            start_idx = Some(i);
        }
        if msg.rowid <= end_rowid {
            end_idx = Some(i);
        }
    }

    match (start_idx, end_idx) {
        (Some(s), Some(e)) if s <= e => Some((s, e)),
        _ => None,
    }
}

fn build_batch_context(
    chat_id: i32,
    batch_id: &str,
    window: &BatchWindow,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    window_media_descriptions: &HashMap<i32, Vec<String>>,
    recent_context: Vec<String>,
    memories: Vec<AiMemoryInput>,
) -> AiBatchContext {
    let mut total_chars = 0usize;
    let mut tier1_local_messages = Vec::new();

    for m in &messages[window.start_idx..=window.end_idx] {
        let text = truncate_chars(&m.text, MAX_MSG_TEXT_CHARS);
        let projected = total_chars + text.len();
        if projected > MAX_BATCH_PAYLOAD_CHARS && !tier1_local_messages.is_empty() {
            break;
        }
        total_chars = projected;

        tier1_local_messages.push(AiMessageInput {
            rowid: m.rowid,
            timestamp: m.iso_ts.clone(),
            sender_role: if m.is_from_me {
                "me".to_string()
            } else {
                "other".to_string()
            },
            sender_name: m.sender_name.clone(),
            text,
            reaction_count: m.reaction_count,
            reply_to_guid: m.reply_root_guid.clone(),
            media_markers: m
                .attachments
                .iter()
                .map(|a| {
                    if a.is_image {
                        "image".to_string()
                    } else {
                        "attachment".to_string()
                    }
                })
                .collect(),
            media_descriptions: window_media_descriptions
                .get(&m.rowid)
                .cloned()
                .unwrap_or_default(),
        });
    }

    eprintln!(
        "[timeline-v2] build_batch_context chat={} batch_id={} msg_count={} approx_chars={}",
        chat_id,
        batch_id,
        tier1_local_messages.len(),
        total_chars
    );

    AiBatchContext {
        chat_id,
        batch_id: batch_id.to_string(),
        chat_title: chat_context.chat_title.clone(),
        participants: chat_context.participants.clone(),
        conversation_span: chat_context.conversation_span.clone(),
        window_span: AiSpan {
            start_ts: tier1_local_messages
                .first()
                .map(|m| m.timestamp.clone())
                .unwrap_or_else(|| chat_context.conversation_span.start_ts.clone()),
            end_ts: tier1_local_messages
                .last()
                .map(|m| m.timestamp.clone())
                .unwrap_or_else(|| chat_context.conversation_span.end_ts.clone()),
        },
        tier1_local_messages,
        tier2_recent_context: recent_context,
        tier3_long_term_memories: memories,
        prompt_version: TIMELINE_PROMPT_VERSION,
    }
}

fn truncate_chars(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }
    let mut out = String::with_capacity(max_chars + 3);
    for c in input.chars().take(max_chars) {
        out.push(c);
    }
    out.push_str("...");
    out
}

fn collect_recent_context(nodes: &[TimelineNodeInsert]) -> Vec<String> {
    nodes
        .iter()
        .rev()
        .take(6)
        .map(|n| {
            format!(
                "L{} {} [{}-{}]",
                n.level, n.summary, n.start_rowid, n.end_rowid
            )
        })
        .collect()
}

fn collect_long_term_memory_inputs(memories: &[TimelineMemoryInsert]) -> Vec<AiMemoryInput> {
    memories
        .iter()
        .rev()
        .take(24)
        .map(|m| AiMemoryInput {
            memory_id: m.memory_id.clone(),
            memory_type: m.memory_type.clone(),
            summary: m.summary.clone(),
            confidence: m.confidence,
        })
        .collect()
}

fn load_chat_context(
    conn: &Connection,
    chat_id: i32,
    contact_names: &HashMap<String, String>,
) -> Result<ChatContext, Box<dyn std::error::Error + Send + Sync>> {
    let (chat_title, conversation_start, conversation_end) = conn.query_row(
        "SELECT COALESCE(NULLIF(c.display_name, ''), c.chat_identifier),
                MIN(m.date),
                MAX(m.date)
         FROM chat c
         LEFT JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
         LEFT JOIN message m ON m.ROWID = cmj.message_id
         WHERE c.ROWID = ?1",
        [chat_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        },
    )?;

    let mut participants = resolve_participants_for_chat(conn, chat_id, contact_names)?;
    let resolved_named = participants
        .iter()
        .filter(|p| {
            !p.full_name_or_handle.starts_with("phone-")
                && !p.full_name_or_handle.starts_with("participant-")
                && !p.full_name_or_handle.contains('@')
        })
        .count();
    eprintln!(
        "[timeline-v2] chat_context chat={} participants={} named_resolved={}",
        chat_id,
        participants.len(),
        resolved_named
    );
    participants.push(AiParticipant {
        full_name_or_handle: "Me".to_string(),
        short_name: "Me".to_string(),
        is_me: true,
    });

    let start_ts = conversation_start
        .and_then(db::apple_timestamp_to_iso)
        .unwrap_or_else(|| timeline_db::now_iso());
    let end_ts = conversation_end
        .and_then(db::apple_timestamp_to_iso)
        .unwrap_or_else(|| start_ts.clone());
    Ok(ChatContext {
        chat_title,
        participants,
        conversation_span: AiSpan { start_ts, end_ts },
    })
}

fn resolve_participants_for_chat(
    conn: &Connection,
    chat_id: i32,
    contact_names: &HashMap<String, String>,
) -> Result<Vec<AiParticipant>, Box<dyn std::error::Error + Send + Sync>> {
    let mut participants = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT COALESCE(h.id, ''), chj.handle_id
         FROM chat_handle_join chj
         LEFT JOIN handle h ON h.ROWID = chj.handle_id
         WHERE chj.chat_id = ?1",
    )?;
    let rows = stmt.query_map([chat_id], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i32>(1)?))
    })?;
    let mut seen = HashSet::new();
    for row in rows {
        let (raw, hid) = row?;
        if !seen.insert(hid) {
            continue;
        }
        let full_display_name = if raw.trim().is_empty() {
            format!("participant-{}", hid)
        } else {
            resolve_sender_display_name(&raw, contact_names)
        };
        let short_display_name = shorten_contact_name(&full_display_name);
        participants.push(AiParticipant {
            short_name: short_display_name,
            full_name_or_handle: full_display_name,
            is_me: false,
        });
    }
    Ok(participants)
}

fn shorten_contact_name(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return "participant".to_string();
    }
    if trimmed.contains('@') {
        return trimmed.split('@').next().unwrap_or(trimmed).to_string();
    }
    let first = trimmed.split_whitespace().next().unwrap_or(trimmed);
    if first
        .chars()
        .all(|c| c.is_ascii_digit() || c == '+' || c == '-')
    {
        return compact_phone_label(first);
    }
    first.to_string()
}

fn resolve_sender_display_name(
    raw_handle: &str,
    contact_names: &HashMap<String, String>,
) -> String {
    if let Some(name) = db::resolve_handle_name(raw_handle, contact_names) {
        let trimmed = name.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    normalized_handle_fallback(raw_handle)
}

fn normalized_handle_fallback(raw_handle: &str) -> String {
    let normalized = db::normalize_handle_identifier(raw_handle);
    if normalized.is_empty() {
        let trimmed = raw_handle.trim();
        if trimmed.is_empty() {
            "unknown participant".to_string()
        } else {
            trimmed.to_string()
        }
    } else if normalized.contains('@') {
        normalized
    } else {
        compact_phone_label(&normalized)
    }
}

fn compact_phone_label(phone: &str) -> String {
    let digits: String = phone.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return phone.to_string();
    }
    let last4 = if digits.len() >= 4 {
        &digits[digits.len() - 4..]
    } else {
        digits.as_str()
    };
    format!("phone-{}", last4)
}

fn summary_needs_fallback(summary: &str) -> bool {
    summary.trim().is_empty()
}

fn is_bad_title_for_range(
    title: &str,
    start_rowid: i32,
    end_rowid: i32,
    messages: &[MessageFeature],
) -> bool {
    let trimmed = title.trim();
    if trimmed.is_empty() {
        return true;
    }
    let normalized_title = normalized_compare_text(trimmed);
    if normalized_title.is_empty() {
        return true;
    }
    messages
        .iter()
        .filter(|m| m.rowid >= start_rowid && m.rowid <= end_rowid)
        .filter(|m| !m.text.trim().is_empty())
        .any(|m| normalized_compare_text(&m.text) == normalized_title)
}

fn normalized_compare_text(input: &str) -> String {
    input
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c.is_whitespace() {
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

fn load_cached_media_descriptions(
    conn: &Connection,
    chat_id: i32,
) -> Result<HashMap<i32, String>, rusqlite::Error> {
    let mut map = HashMap::new();
    let mut stmt = conn.prepare(
        "SELECT attachment_rowid, caption
         FROM timeline_media_insights
         WHERE chat_id = ?1
           AND caption IS NOT NULL
           AND LENGTH(TRIM(caption)) > 0",
    )?;
    let rows = stmt.query_map([chat_id], |row| {
        Ok((row.get::<_, i32>(0)?, row.get::<_, String>(1)?))
    })?;
    for row in rows {
        let (attachment_id, caption) = row?;
        map.insert(attachment_id, caption);
    }
    Ok(map)
}

fn collect_window_media_descriptions(
    source_conn: &Connection,
    source_db_path: &Path,
    chat_id: i32,
    messages: &[MessageFeature],
    cache: &mut HashMap<i32, String>,
    generated_count: &mut usize,
    insights: &mut Vec<TimelineMediaInsightInsert>,
) -> HashMap<i32, Vec<String>> {
    let mut by_message = HashMap::<i32, Vec<String>>::new();
    for msg in messages {
        for att in msg.attachments.iter().filter(|a| a.is_image) {
            if by_message
                .get(&msg.rowid)
                .map(|v| v.len() >= MAX_CONTEXT_IMAGE_DESCRIPTIONS_PER_MESSAGE)
                .unwrap_or(false)
            {
                break;
            }

            if let Some(existing) = cache.get(&att.attachment_rowid) {
                by_message
                    .entry(msg.rowid)
                    .or_default()
                    .push(truncate(existing, 240));
                continue;
            }

            if *generated_count >= MAX_CONTEXT_IMAGE_DESCRIPTIONS_PER_RUN {
                continue;
            }
            if let Some(path) =
                resolve_attachment_path(source_conn, source_db_path, att.attachment_rowid)
            {
                if let Ok((description, model)) =
                    timeline_ai::describe_image_for_timeline(&path, &att.mime_type)
                {
                    *generated_count += 1;
                    cache.insert(att.attachment_rowid, description.clone());
                    by_message
                        .entry(msg.rowid)
                        .or_default()
                        .push(truncate(&description, 240));
                    insights.push(TimelineMediaInsightInsert {
                        chat_id,
                        message_rowid: msg.rowid,
                        attachment_rowid: att.attachment_rowid,
                        mime_type: att.mime_type.clone(),
                        caption: description,
                        model,
                        created_at: timeline_db::now_iso(),
                    });
                }
            }
        }
    }
    by_message
}

fn deterministic_node_fallback(
    start_rowid: i32,
    end_rowid: i32,
    level: u8,
    messages: &[MessageFeature],
    _chat_context: &ChatContext,
) -> (String, String) {
    let range_messages: Vec<&MessageFeature> = messages
        .iter()
        .filter(|m| m.rowid >= start_rowid && m.rowid <= end_rowid)
        .collect();
    let keywords = extract_fallback_keywords(&range_messages);
    let primary = keywords
        .first()
        .cloned()
        .unwrap_or_else(|| "coordination".to_string());
    let secondary = keywords.get(1).cloned();
    let secondary_label = secondary.clone().unwrap_or_else(|| "planning".to_string());
    let names: Vec<String> = range_messages
        .iter()
        .filter_map(|m| m.sender_name.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let actor = names
        .first()
        .cloned()
        .unwrap_or_else(|| "participants".to_string());
    let time_label = fallback_time_label(start_rowid, end_rowid, messages);

    let title = match level {
        0 => format!(
            "{}: {} and {}",
            time_label,
            title_case(&primary),
            title_case(&secondary_label)
        ),
        1 => format!(
            "{} and {} discussion",
            title_case(&primary),
            title_case(&secondary.clone().unwrap_or_else(|| "planning".to_string()))
        ),
        2 => format!(
            "{} and {}",
            title_case(&primary),
            secondary.clone().unwrap_or_else(|| "details".to_string())
        ),
        _ => format!(
            "{} {}",
            title_case(&primary),
            secondary.clone().unwrap_or_else(|| "update".to_string())
        ),
    };

    let summary = format!(
        "Conversation between {} about {} and {}.",
        actor,
        primary,
        secondary.clone().unwrap_or_else(|| "related topics".to_string())
    );
    (title.trim().to_string(), summary.trim().to_string())
}

fn deterministic_node_fallback_if_needed(
    title: &str,
    summary: &str,
    start_rowid: i32,
    end_rowid: i32,
    level: u8,
    messages: &[MessageFeature],
    chat_context: Option<&ChatContext>,
) -> (String, String) {
    if !title.trim().is_empty() && !summary.trim().is_empty() {
        return (title.trim().to_string(), summary.trim().to_string());
    }
    if let Some(ctx) = chat_context {
        return deterministic_node_fallback(start_rowid, end_rowid, level, messages, ctx);
    }
    (
        if title.trim().is_empty() {
            format!("Timeline {}", level)
        } else {
            title.trim().to_string()
        },
        if summary.trim().is_empty() {
            format!(
                "Conversation segment spanning rowids {} to {}.",
                start_rowid, end_rowid
            )
        } else {
            summary.trim().to_string()
        },
    )
}

fn extract_fallback_keywords(messages: &[&MessageFeature]) -> Vec<String> {
    let stop_words: HashSet<&str> = [
        "the", "and", "for", "that", "with", "this", "from", "have", "just", "about", "your",
        "you", "are", "was", "were", "will", "would", "they", "them", "their", "then", "into",
        "when", "what", "where", "why", "how", "but", "can", "could", "should", "our", "out",
        "not", "its", "it", "him", "her", "she", "he", "his", "hers", "there", "here", "okay",
        "yeah", "yep", "lol", "lmao", "me", "im", "i", "we", "us", "a", "an", "to", "in", "on",
    ]
    .into_iter()
    .collect();
    let mut freq: HashMap<String, usize> = HashMap::new();
    for msg in messages {
        for token in msg
            .text
            .to_lowercase()
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|t| t.len() >= 4)
            .filter(|t| !stop_words.contains(*t))
        {
            *freq.entry(token.to_string()).or_insert(0) += 1;
        }
    }
    let mut terms: Vec<(String, usize)> = freq.into_iter().collect();
    terms.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    terms.into_iter().take(4).map(|(t, _)| t).collect()
}

fn title_case(word: &str) -> String {
    let mut chars = word.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => word.to_string(),
    }
}

fn fallback_time_label(start_rowid: i32, end_rowid: i32, messages: &[MessageFeature]) -> String {
    let start = rowid_to_iso(messages, start_rowid);
    let end = rowid_to_iso(messages, end_rowid);
    let start_day = start.get(0..10).unwrap_or("timeline");
    let end_day = end.get(0..10).unwrap_or(start_day);
    if start_day == end_day {
        start_day.to_string()
    } else {
        format!("{} to {}", start_day, end_day)
    }
}

#[allow(clippy::too_many_arguments)]
fn append_batch_output(
    chat_id: i32,
    batch_id: &str,
    out: &timeline_ai::AiBatchOutput,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
    evidence: &mut Vec<TimelineEvidenceInsert>,
    links: &mut Vec<TimelineNodeLinkInsert>,
    memories: &mut Vec<TimelineMemoryInsert>,
    memory_links: &mut Vec<TimelineNodeMemoryLinkInsert>,
) {
    let mut range_to_temp: Vec<(i32, i32, i64)> = Vec::new();

    for (idx, n) in out.nodes.iter().enumerate() {
        if n.level != 3 {
            continue;
        }

        let start_rowid = n.start_rowid;
        let end_rowid = max(n.start_rowid, n.end_rowid);
        let rep = clamp_rowid(n.representative_rowid, start_rowid, end_rowid);

        let start_ts = rowid_to_iso(messages, start_rowid);
        let end_ts = rowid_to_iso(messages, end_rowid);
        let (message_count, media_count, reaction_count, reply_count) =
            aggregate_counts(messages, start_rowid, end_rowid);

        let temp_id = *temp_id_seed;
        *temp_id_seed += 1;

        let (title, summary) = deterministic_node_fallback_if_needed(
            &n.title,
            &n.summary,
            start_rowid,
            end_rowid,
            n.level,
            messages,
            Some(chat_context),
        );
        let title = if is_bad_title_for_range(&title, start_rowid, end_rowid, messages) {
            deterministic_node_fallback(start_rowid, end_rowid, n.level, messages, chat_context).0
        } else {
            title
        };

        nodes.push(TimelineNodeInsert {
            temp_id,
            chat_id,
            level: n.level,
            parent_temp_id: None,
            ordinal: idx as i32,
            start_rowid,
            end_rowid,
            representative_rowid: rep,
            start_ts,
            end_ts,
            title,
            summary,
            keywords: n.keywords.clone(),
            message_count,
            media_count,
            reaction_count,
            reply_count,
            confidence: n.confidence,
            ai_rationale: compose_rationale(
                n.ai_rationale.clone(),
                n.grouping_mode.clone(),
                n.context_influence.clone(),
            ),
            source_batch_id: Some(batch_id.to_string()),
            is_draft: false,
        });

        evidence.push(TimelineEvidenceInsert {
            node_temp_id: temp_id,
            rowid: rep,
            reason: "anchor".to_string(),
            weight: n.confidence.max(0.1),
        });

        range_to_temp.push((start_rowid, end_rowid, temp_id));
    }

    for rel in &out.related {
        if let (Some(source_temp), Some(target_temp)) = (
            find_temp_by_range(&range_to_temp, rel.source_start_rowid, rel.source_end_rowid),
            find_temp_by_range(&range_to_temp, rel.target_start_rowid, rel.target_end_rowid),
        ) {
            if source_temp != target_temp {
                links.push(TimelineNodeLinkInsert {
                    source_temp_id: source_temp,
                    target_temp_id: target_temp,
                    link_type: rel.link_type.clone(),
                    weight: rel.weight.clamp(0.05, 1.0),
                    rationale: rel.rationale.clone(),
                });
            }
        }
    }

    for mem in &out.memories {
        let memory_id = format!("mem-{}", Uuid::new_v4());
        memories.push(TimelineMemoryInsert {
            memory_id: memory_id.clone(),
            chat_id,
            memory_type: mem.memory_type.clone(),
            summary: mem.summary.clone(),
            confidence: mem.confidence,
            first_seen_rowid: mem.first_seen_rowid,
            last_seen_rowid: mem.last_seen_rowid,
            support_rowids: mem.support_rowids.clone(),
            updated_at: timeline_db::now_iso(),
        });

        for (start_rowid, end_rowid, temp_id) in &range_to_temp {
            if ranges_overlap(
                *start_rowid,
                *end_rowid,
                mem.first_seen_rowid,
                mem.last_seen_rowid,
            ) {
                memory_links.push(TimelineNodeMemoryLinkInsert {
                    node_temp_id: *temp_id,
                    memory_id: memory_id.clone(),
                    weight: 0.55,
                });
            }
        }
    }
}

fn build_merge_context(chat_id: i32, nodes: &[TimelineNodeInsert]) -> AiMergeContext {
    let input_nodes = build_l3_inputs(nodes);

    AiMergeContext {
        chat_id,
        prompt_version: TIMELINE_PROMPT_VERSION,
        nodes: input_nodes,
    }
}

fn build_l3_inputs(nodes: &[TimelineNodeInsert]) -> Vec<AiMergeInputNode> {
    let mut moments: Vec<&TimelineNodeInsert> = nodes.iter().filter(|n| n.level == 3).collect();
    moments.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal));
    moments
        .into_iter()
        .map(|n| AiMergeInputNode {
            batch_id: n
                .source_batch_id
                .clone()
                .unwrap_or_else(|| "l3".to_string()),
            level: n.level,
            start_rowid: n.start_rowid,
            end_rowid: n.end_rowid,
            representative_rowid: n.representative_rowid,
            title: n.title.clone(),
            summary: n.summary.clone(),
            keywords: n.keywords.clone(),
        })
        .collect()
}

fn append_merge_output(
    chat_id: i32,
    merge: &timeline_ai::AiMergeOutput,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
    links: &mut Vec<TimelineNodeLinkInsert>,
) {
    let mut new_ranges: Vec<(i32, i32, i64)> = Vec::new();

    let base_ordinal = nodes.len() as i32;
    for (idx, n) in merge.nodes.iter().enumerate() {
        if n.level > 2 {
            continue;
        }

        let start_rowid = n.start_rowid;
        let end_rowid = max(n.start_rowid, n.end_rowid);
        let rep = clamp_rowid(n.representative_rowid, start_rowid, end_rowid);
        let start_ts = rowid_to_iso(messages, start_rowid);
        let end_ts = rowid_to_iso(messages, end_rowid);
        let (message_count, media_count, reaction_count, reply_count) =
            aggregate_counts(messages, start_rowid, end_rowid);

        let temp_id = *temp_id_seed;
        *temp_id_seed += 1;

        let (title, summary) = deterministic_node_fallback_if_needed(
            &n.title,
            &n.summary,
            start_rowid,
            end_rowid,
            n.level,
            messages,
            Some(chat_context),
        );
        let title_is_bad = is_bad_title_for_range(&title, start_rowid, end_rowid, messages);
        let summary_is_bad = summary_needs_fallback(&summary);
        let mut used_fallback = false;
        let title = if title_is_bad {
            used_fallback = true;
            deterministic_node_fallback(start_rowid, end_rowid, n.level, messages, chat_context).0
        } else {
            title
        };
        let summary = if summary_is_bad {
            used_fallback = true;
            deterministic_node_fallback(start_rowid, end_rowid, n.level, messages, chat_context).1
        } else {
            summary
        };

        nodes.push(TimelineNodeInsert {
            temp_id,
            chat_id,
            level: n.level,
            parent_temp_id: None,
            ordinal: base_ordinal + idx as i32,
            start_rowid,
            end_rowid,
            representative_rowid: rep,
            start_ts,
            end_ts,
            title,
            summary,
            keywords: n.keywords.clone(),
            message_count,
            media_count,
            reaction_count,
            reply_count,
            confidence: n.confidence,
            ai_rationale: compose_rationale(
                n.ai_rationale.clone(),
                n.grouping_mode.clone(),
                n.context_influence.clone(),
            ),
            source_batch_id: Some("merge".to_string()),
            is_draft: used_fallback,
        });

        new_ranges.push((start_rowid, end_rowid, temp_id));
    }

    let all_ranges: Vec<(i32, i32, i64)> = nodes
        .iter()
        .map(|n| (n.start_rowid, n.end_rowid, n.temp_id))
        .collect();

    for rel in &merge.related {
        if let (Some(source), Some(target)) = (
            find_temp_by_range(&all_ranges, rel.source_start_rowid, rel.source_end_rowid),
            find_temp_by_range(&all_ranges, rel.target_start_rowid, rel.target_end_rowid),
        ) {
            if source != target {
                links.push(TimelineNodeLinkInsert {
                    source_temp_id: source,
                    target_temp_id: target,
                    link_type: rel.link_type.clone(),
                    weight: rel.weight.clamp(0.05, 1.0),
                    rationale: rel.rationale.clone(),
                });
            }
        }
    }
}

fn enforce_hierarchy_backbone(
    chat_id: i32,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
) {
    if messages.is_empty() {
        nodes.clear();
        return;
    }
    normalize_l3_exact_coverage(chat_id, messages, chat_context, temp_id_seed, nodes);
    ensure_parent_level_coverage(chat_id, 2, 3, messages, chat_context, temp_id_seed, nodes);
    ensure_parent_level_coverage(chat_id, 1, 2, messages, chat_context, temp_id_seed, nodes);
    ensure_parent_level_coverage(chat_id, 0, 1, messages, chat_context, temp_id_seed, nodes);
    let l0_count = nodes.iter().filter(|n| n.level == 0).count();
    let l1_count = nodes.iter().filter(|n| n.level == 1).count();
    if l0_count < 2 && l1_count >= 4 {
        nodes.retain(|n| n.level != 0);
        ensure_parent_level_coverage(chat_id, 0, 1, messages, chat_context, temp_id_seed, nodes);
    }
}

#[cfg(test)]
fn ensure_hierarchy_backbone(
    chat_id: i32,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
) {
    enforce_hierarchy_backbone(chat_id, messages, chat_context, temp_id_seed, nodes);
}

fn normalize_l3_exact_coverage(
    chat_id: i32,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
) {
    let mut l3_existing: Vec<TimelineNodeInsert> =
        nodes.iter().filter(|n| n.level == 3).cloned().collect();
    l3_existing.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal, n.temp_id));

    let mut rebuilt = Vec::<TimelineNodeInsert>::new();
    if l3_existing.is_empty() {
        for (idx, chunk) in messages.chunks(12).enumerate() {
            let start_rowid = chunk.first().map(|m| m.rowid).unwrap_or_default();
            let end_rowid = chunk.last().map(|m| m.rowid).unwrap_or(start_rowid);
            let (title, summary) =
                deterministic_node_fallback(start_rowid, end_rowid, 3, messages, chat_context);
            rebuilt.push(make_fallback_node(
                chat_id,
                3,
                idx as i32,
                start_rowid,
                end_rowid,
                &title,
                &summary,
                messages,
                temp_id_seed,
            ));
        }
    } else {
        let assignments: Vec<Option<usize>> = messages
            .iter()
            .map(|msg| {
                l3_existing
                    .iter()
                    .enumerate()
                    .filter(|(_, node)| {
                        node.start_rowid <= msg.rowid && node.end_rowid >= msg.rowid
                    })
                    .min_by_key(|(_, node)| (node.end_rowid - node.start_rowid, node.start_rowid))
                    .map(|(idx, _)| idx)
            })
            .collect();

        let mut run_start = 0usize;
        while run_start < messages.len() {
            let assigned = assignments[run_start];
            let mut run_end = run_start;
            while run_end + 1 < messages.len() && assignments[run_end + 1] == assigned {
                run_end += 1;
            }

            let start_rowid = messages[run_start].rowid;
            let end_rowid = messages[run_end].rowid;
            let mut node = if let Some(source_idx) = assigned {
                let source = &l3_existing[source_idx];
                let mut cloned = source.clone();
                cloned.start_rowid = start_rowid;
                cloned.end_rowid = end_rowid;
                cloned
            } else {
                let (title, summary) =
                    deterministic_node_fallback(start_rowid, end_rowid, 3, messages, chat_context);
                make_fallback_node(
                    chat_id,
                    3,
                    0,
                    start_rowid,
                    end_rowid,
                    &title,
                    &summary,
                    messages,
                    temp_id_seed,
                )
            };
            node.temp_id = *temp_id_seed;
            *temp_id_seed += 1;
            node.parent_temp_id = None;
            node.start_rowid = start_rowid;
            node.end_rowid = end_rowid;
            node.representative_rowid =
                clamp_rowid(node.representative_rowid, node.start_rowid, node.end_rowid);
            node.ordinal = rebuilt.len() as i32;
            let (title, summary) = deterministic_node_fallback_if_needed(
                &node.title,
                &node.summary,
                node.start_rowid,
                node.end_rowid,
                3,
                messages,
                Some(chat_context),
            );
            node.title = title;
            node.summary = if summary_needs_fallback(&summary) {
                deterministic_node_fallback(
                    node.start_rowid,
                    node.end_rowid,
                    3,
                    messages,
                    chat_context,
                )
                .1
            } else {
                summary
            };
            refresh_node_aggregates(&mut node, messages);
            rebuilt.push(node);
            run_start = run_end + 1;
        }
    }

    nodes.retain(|n| n.level != 3);
    nodes.extend(rebuilt);
}

fn ensure_parent_level_coverage(
    chat_id: i32,
    parent_level: u8,
    child_level: u8,
    messages: &[MessageFeature],
    chat_context: &ChatContext,
    temp_id_seed: &mut i64,
    nodes: &mut Vec<TimelineNodeInsert>,
) {
    let mut children: Vec<TimelineNodeInsert> = nodes
        .iter()
        .filter(|n| n.level == child_level)
        .cloned()
        .collect();
    if children.is_empty() {
        return;
    }
    children.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal, n.temp_id));

    let mut existing_parents: Vec<TimelineNodeInsert> = nodes
        .iter()
        .filter(|n| n.level == parent_level)
        .cloned()
        .collect();
    existing_parents.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal, n.temp_id));
    let existing_parent_by_id: HashMap<i64, TimelineNodeInsert> = existing_parents
        .into_iter()
        .map(|node| (node.temp_id, node))
        .collect();

    let max_children_per_parent = fallback_children_chunk_size(parent_level).max(1);
    let mut used_existing = HashSet::<i64>::new();
    let mut child_parent = HashMap::<i64, i64>::new();
    let mut parent_ranges = HashMap::<i64, (i32, i32)>::new();
    let mut new_parents = Vec::<TimelineNodeInsert>::new();

    let mut idx = 0usize;
    while idx < children.len() {
        let child = &children[idx];
        let chosen_existing = existing_parent_by_id
            .values()
            .filter(|p| p.start_rowid <= child.start_rowid && p.end_rowid >= child.end_rowid)
            .min_by_key(|p| p.end_rowid - p.start_rowid)
            .map(|p| p.temp_id);

        if let Some(parent_id) = chosen_existing {
            child_parent.insert(child.temp_id, parent_id);
            used_existing.insert(parent_id);
            parent_ranges
                .entry(parent_id)
                .and_modify(|(s, e)| {
                    *s = min(*s, child.start_rowid);
                    *e = max(*e, child.end_rowid);
                })
                .or_insert((child.start_rowid, child.end_rowid));
            idx += 1;
            continue;
        }

        let uncovered_start = idx;
        idx += 1;
        while idx < children.len() {
            let probe = &children[idx];
            let has_cover = existing_parent_by_id
                .values()
                .any(|p| p.start_rowid <= probe.start_rowid && p.end_rowid >= probe.end_rowid);
            if has_cover {
                break;
            }
            idx += 1;
        }
        let uncovered_end = idx - 1;
        let mut cursor = uncovered_start;
        while cursor <= uncovered_end {
            let chunk_end = min(cursor + max_children_per_parent - 1, uncovered_end);
            let start_rowid = children[cursor].start_rowid;
            let end_rowid = children[chunk_end].end_rowid;
            let (title, summary) = deterministic_node_fallback(
                start_rowid,
                end_rowid,
                parent_level,
                messages,
                chat_context,
            );
            let mut parent = make_fallback_node(
                chat_id,
                parent_level,
                0,
                start_rowid,
                end_rowid,
                &title,
                &summary,
                messages,
                temp_id_seed,
            );
            parent.parent_temp_id = None;
            let parent_id = parent.temp_id;
            for c in &children[cursor..=chunk_end] {
                child_parent.insert(c.temp_id, parent_id);
                parent_ranges
                    .entry(parent_id)
                    .and_modify(|(s, e)| {
                        *s = min(*s, c.start_rowid);
                        *e = max(*e, c.end_rowid);
                    })
                    .or_insert((c.start_rowid, c.end_rowid));
            }
            new_parents.push(parent);
            cursor = chunk_end + 1;
        }
    }

    for child in &mut children {
        child.parent_temp_id = child_parent.get(&child.temp_id).copied();
    }

    let mut final_parents = Vec::<TimelineNodeInsert>::new();
    for parent_id in used_existing {
        if let Some(mut parent) = existing_parent_by_id.get(&parent_id).cloned() {
            if let Some((start_rowid, end_rowid)) = parent_ranges.get(&parent_id).copied() {
                parent.start_rowid = start_rowid;
                parent.end_rowid = end_rowid;
            }
            parent.parent_temp_id = None;
            parent.representative_rowid = clamp_rowid(
                parent.representative_rowid,
                parent.start_rowid,
                parent.end_rowid,
            );
            refresh_node_aggregates(&mut parent, messages);
            if parent.title.trim().is_empty()
                || parent.summary.trim().is_empty()
                || summary_needs_fallback(&parent.summary)
            {
                let (title, summary) = deterministic_node_fallback(
                    parent.start_rowid,
                    parent.end_rowid,
                    parent_level,
                    messages,
                    chat_context,
                );
                parent.title = title;
                parent.summary = summary;
                if parent.level <= 2 {
                    parent.is_draft = true;
                }
            }
            final_parents.push(parent);
        }
    }
    for mut parent in new_parents {
        if let Some((start_rowid, end_rowid)) = parent_ranges.get(&parent.temp_id).copied() {
            parent.start_rowid = start_rowid;
            parent.end_rowid = end_rowid;
        }
        parent.representative_rowid = clamp_rowid(
            parent.representative_rowid,
            parent.start_rowid,
            parent.end_rowid,
        );
        refresh_node_aggregates(&mut parent, messages);
        final_parents.push(parent);
    }

    nodes.retain(|n| n.level != child_level && n.level != parent_level);
    nodes.extend(children);
    nodes.extend(final_parents);
}

fn fallback_children_chunk_size(parent_level: u8) -> usize {
    match parent_level {
        2 => 4,
        1 => 5,
        0 => 4,
        _ => 4,
    }
}

fn refresh_node_aggregates(node: &mut TimelineNodeInsert, messages: &[MessageFeature]) {
    let start = min(node.start_rowid, node.end_rowid);
    let end = max(node.start_rowid, node.end_rowid);
    node.start_rowid = start;
    node.end_rowid = end;
    node.representative_rowid = clamp_rowid(node.representative_rowid, start, end);
    let (message_count, media_count, reaction_count, reply_count) =
        aggregate_counts(messages, start, end);
    node.message_count = message_count;
    node.media_count = media_count;
    node.reaction_count = reaction_count;
    node.reply_count = reply_count;
    node.start_ts = rowid_to_iso(messages, start);
    node.end_ts = rowid_to_iso(messages, end);
}

fn make_fallback_node(
    chat_id: i32,
    level: u8,
    ordinal: i32,
    start_rowid: i32,
    end_rowid: i32,
    title: &str,
    summary: &str,
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
) -> TimelineNodeInsert {
    let temp_id = *temp_id_seed;
    *temp_id_seed += 1;
    let (message_count, media_count, reaction_count, reply_count) =
        aggregate_counts(messages, start_rowid, end_rowid);
    TimelineNodeInsert {
        temp_id,
        chat_id,
        level,
        parent_temp_id: None,
        ordinal,
        start_rowid,
        end_rowid,
        representative_rowid: start_rowid + ((end_rowid - start_rowid) / 2),
        start_ts: rowid_to_iso(messages, start_rowid),
        end_ts: rowid_to_iso(messages, end_rowid),
        title: title.to_string(),
        summary: summary.to_string(),
        keywords: Vec::new(),
        message_count,
        media_count,
        reaction_count,
        reply_count,
        confidence: 0.4,
        ai_rationale: Some("Hierarchy fallback generated for missing level coverage".to_string()),
        source_batch_id: Some("hierarchy-fallback".to_string()),
        is_draft: level <= 2,
    }
}

fn append_prev_moment_links(nodes: &[TimelineNodeInsert], links: &mut Vec<TimelineNodeLinkInsert>) {
    let mut moments: Vec<&TimelineNodeInsert> = nodes.iter().filter(|n| n.level == 3).collect();
    moments.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal));
    for pair in moments.windows(2) {
        let prev = pair[0];
        let curr = pair[1];
        links.push(TimelineNodeLinkInsert {
            source_temp_id: prev.temp_id,
            target_temp_id: curr.temp_id,
            link_type: "prev_moment".to_string(),
            weight: 1.0,
            rationale: "chronological previous moment".to_string(),
        });
    }
}

fn assign_parents_by_containment(nodes: &mut [TimelineNodeInsert]) {
    let snapshot: Vec<(i64, u8, i32, i32)> = nodes
        .iter()
        .map(|n| (n.temp_id, n.level, n.start_rowid, n.end_rowid))
        .collect();

    for node in nodes.iter_mut() {
        if node.level == 0 {
            node.parent_temp_id = None;
            continue;
        }

        let parent_level = node.level - 1;
        let containing = snapshot
            .iter()
            .filter(|(_, lvl, s, e)| {
                *lvl == parent_level && *s <= node.start_rowid && *e >= node.end_rowid
            })
            .min_by_key(|(_, _, s, e)| e - s)
            .map(|(id, _, _, _)| *id);
        if containing.is_some() {
            node.parent_temp_id = containing;
            continue;
        }

        let mut best_overlap: Option<(i64, i32, i32)> = None;
        for (id, lvl, start, end) in &snapshot {
            if *lvl != parent_level {
                continue;
            }
            let overlap_start = max(*start, node.start_rowid);
            let overlap_end = min(*end, node.end_rowid);
            if overlap_end >= overlap_start {
                let overlap = overlap_end - overlap_start + 1;
                let span_delta = (*end - *start) - (node.end_rowid - node.start_rowid);
                match best_overlap {
                    Some((_, best_overlap_len, best_span_delta))
                        if best_overlap_len > overlap
                            || (best_overlap_len == overlap && best_span_delta <= span_delta) => {}
                    _ => best_overlap = Some((*id, overlap, span_delta)),
                }
            }
        }
        if let Some((id, _, _)) = best_overlap {
            node.parent_temp_id = Some(id);
            continue;
        }

        let node_mid = node.start_rowid + ((node.end_rowid - node.start_rowid) / 2);
        node.parent_temp_id = snapshot
            .iter()
            .filter(|(_, lvl, _, _)| *lvl == parent_level)
            .min_by_key(|(_, _, s, e)| {
                let mid = *s + ((*e - *s) / 2);
                (mid - node_mid).abs()
            })
            .map(|(id, _, _, _)| *id);
    }
}

fn normalize_node_ordinals(nodes: &mut [TimelineNodeInsert]) {
    for level in 0_u8..=3 {
        let mut indices: Vec<usize> = nodes
            .iter()
            .enumerate()
            .filter_map(|(idx, node)| (node.level == level).then_some(idx))
            .collect();
        indices.sort_by_key(|idx| {
            let node = &nodes[*idx];
            (node.start_rowid, node.end_rowid, node.temp_id)
        });
        for (ordinal, idx) in indices.into_iter().enumerate() {
            let node = &mut nodes[idx];
            node.ordinal = ordinal as i32;
            node.representative_rowid =
                clamp_rowid(node.representative_rowid, node.start_rowid, node.end_rowid);
        }
    }
}

fn validate_hierarchy_invariants(
    messages: &[MessageFeature],
    nodes: &[TimelineNodeInsert],
) -> Result<(), String> {
    if messages.is_empty() {
        return Ok(());
    }
    if nodes.iter().all(|n| n.level != 3) {
        return Err("No level-3 moments present".to_string());
    }
    for level in 0_u8..=3 {
        if nodes.iter().all(|n| n.level != level) {
            return Err(format!("Missing level {} nodes", level));
        }
    }

    let mut ord_seen: [HashSet<i32>; 4] = std::array::from_fn(|_| HashSet::new());
    for node in nodes {
        if node.representative_rowid < node.start_rowid
            || node.representative_rowid > node.end_rowid
        {
            return Err(format!(
                "Representative rowid out of range for temp_id={} level={}",
                node.temp_id, node.level
            ));
        }
        let bucket = (node.level as usize).min(3);
        if !ord_seen[bucket].insert(node.ordinal) {
            return Err(format!(
                "Duplicate ordinal at level {} (ordinal={})",
                node.level, node.ordinal
            ));
        }
    }

    let by_temp: HashMap<i64, &TimelineNodeInsert> = nodes.iter().map(|n| (n.temp_id, n)).collect();
    for node in nodes.iter().filter(|n| n.level > 0) {
        let parent_id = node.parent_temp_id.ok_or_else(|| {
            format!(
                "Missing parent for temp_id={} level={}",
                node.temp_id, node.level
            )
        })?;
        let parent = by_temp.get(&parent_id).ok_or_else(|| {
            format!(
                "Missing parent node for temp_id={} parent_temp_id={}",
                node.temp_id, parent_id
            )
        })?;
        if parent.level + 1 != node.level {
            return Err(format!(
                "Parent level mismatch child_temp_id={} parent_level={} child_level={}",
                node.temp_id, parent.level, node.level
            ));
        }
        if !(parent.start_rowid <= node.start_rowid && parent.end_rowid >= node.end_rowid) {
            return Err(format!(
                "Parent containment failed child_temp_id={} parent_temp_id={}",
                node.temp_id, parent_id
            ));
        }
    }

    for message in messages {
        let covered_by_l3 = nodes
            .iter()
            .filter(|n| {
                n.level == 3 && n.start_rowid <= message.rowid && n.end_rowid >= message.rowid
            })
            .count();
        if covered_by_l3 != 1 {
            return Err(format!(
                "L3 coverage mismatch at rowid={} count={}",
                message.rowid, covered_by_l3
            ));
        }
    }
    Ok(())
}

fn backoff_with_jitter_ms(attempt: i32) -> u64 {
    let idx = (attempt.saturating_sub(1) as usize).min(RETRY_BACKOFF_MS.len() - 1);
    let base = RETRY_BACKOFF_MS[idx];
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let bucket = now_ms % (RETRY_JITTER_PCT * 2 + 1);
    let jitter_pct = bucket as i64 - RETRY_JITTER_PCT as i64;
    let jittered = (base as i64) + ((base as i64 * jitter_pct) / 100);
    jittered.max(250) as u64
}

#[derive(Clone, Debug)]
struct ParentStats {
    level_total: [usize; 4],
    level_linked: [usize; 4],
    total_level_gt0: usize,
    linked_level_gt0: usize,
    coverage_level_gt0: f32,
}

fn compute_parent_stats(nodes: &[TimelineNodeInsert]) -> ParentStats {
    let mut level_total = [0_usize; 4];
    let mut level_linked = [0_usize; 4];

    for node in nodes {
        let idx = (node.level as usize).min(3);
        level_total[idx] += 1;
        if node.parent_temp_id.is_some() {
            level_linked[idx] += 1;
        }
    }

    let total_level_gt0 = level_total[1] + level_total[2] + level_total[3];
    let linked_level_gt0 = level_linked[1] + level_linked[2] + level_linked[3];
    let coverage_level_gt0 = if total_level_gt0 > 0 {
        linked_level_gt0 as f32 / total_level_gt0 as f32
    } else {
        1.0
    };

    ParentStats {
        level_total,
        level_linked,
        total_level_gt0,
        linked_level_gt0,
        coverage_level_gt0,
    }
}

#[derive(Clone, Debug, Default)]
struct MessageCoverageStats {
    total_messages: usize,
    covered: [usize; 4],
}

fn compute_message_coverage_by_level(
    messages: &[MessageFeature],
    nodes: &[TimelineNodeInsert],
) -> MessageCoverageStats {
    let mut stats = MessageCoverageStats {
        total_messages: messages.len(),
        covered: [0; 4],
    };
    if messages.is_empty() {
        return stats;
    }
    for level in 0_u8..=3 {
        let level_nodes: Vec<&TimelineNodeInsert> =
            nodes.iter().filter(|n| n.level == level).collect();
        let covered = messages
            .iter()
            .filter(|msg| {
                level_nodes
                    .iter()
                    .any(|node| node.start_rowid <= msg.rowid && node.end_rowid >= msg.rowid)
            })
            .count();
        stats.covered[level as usize] = covered;
    }
    stats
}

fn duplicate_ordinal_counts(nodes: &[TimelineNodeInsert]) -> [usize; 4] {
    let mut duplicates = [0usize; 4];
    for level in 0_u8..=3 {
        let mut counts: HashMap<i32, usize> = HashMap::new();
        for node in nodes.iter().filter(|n| n.level == level) {
            *counts.entry(node.ordinal).or_insert(0) += 1;
        }
        duplicates[level as usize] = counts.values().filter(|v| **v > 1).count();
    }
    duplicates
}

fn low_value_summary_counts(nodes: &[TimelineNodeInsert]) -> [usize; 4] {
    let mut counts = [0usize; 4];
    for level in 0_u8..=3 {
        counts[level as usize] = nodes
            .iter()
            .filter(|n| n.level == level && n.summary.trim().is_empty())
            .count();
    }
    counts
}

fn average_sentence_counts(nodes: &[TimelineNodeInsert]) -> [f32; 4] {
    let mut sums = [0usize; 4];
    let mut counts = [0usize; 4];
    for node in nodes {
        let idx = (node.level as usize).min(3);
        counts[idx] += 1;
        sums[idx] += sentence_count(&node.summary);
    }
    let mut avg = [0.0_f32; 4];
    for i in 0..4 {
        avg[i] = if counts[i] == 0 {
            0.0
        } else {
            sums[i] as f32 / counts[i] as f32
        };
    }
    avg
}

fn sentence_count(summary: &str) -> usize {
    let count = summary
        .split(['.', '!', '?'])
        .filter(|s| !s.trim().is_empty())
        .count();
    if count == 0 && !summary.trim().is_empty() {
        1
    } else {
        count
    }
}

fn count_link_types(links: &[TimelineNodeLinkInsert]) -> String {
    if links.is_empty() {
        return "none".to_string();
    }
    let mut counts: HashMap<&str, usize> = HashMap::new();
    for link in links {
        *counts.entry(link.link_type.as_str()).or_insert(0) += 1;
    }
    let mut entries: Vec<(&str, usize)> = counts.into_iter().collect();
    entries.sort_by(|a, b| a.0.cmp(b.0));
    entries
        .into_iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join(",")
}

fn timeline_l3_parallelism() -> usize {
    std::env::var("TIMELINE_AI_PARALLELISM")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1 && *v <= 6)
        .unwrap_or(DEFAULT_L3_PARALLELISM)
}

fn run_media_refinement(
    source_conn: &Connection,
    source_db_path: &Path,
    chat_id: i32,
    messages: &[MessageFeature],
    nodes: &mut [TimelineNodeInsert],
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
) -> Vec<TimelineMediaInsightInsert> {
    if !timeline_ai::is_openai_enabled() {
        return Vec::new();
    }

    let mut insights = Vec::new();
    let mut seen_attachments = HashSet::new();

    for node in nodes.iter_mut().filter(|n| n.level == 2).take(16) {
        if is_canceled(cancel_jobs, chat_id) {
            break;
        }
        for msg in messages
            .iter()
            .filter(|m| m.rowid >= node.start_rowid && m.rowid <= node.end_rowid)
        {
            if is_canceled(cancel_jobs, chat_id) {
                break;
            }
            for att in msg.attachments.iter().filter(|a| a.is_image) {
                if is_canceled(cancel_jobs, chat_id) {
                    break;
                }
                if insights.len() >= MAX_IMAGE_CAPTIONS {
                    return insights;
                }
                if !seen_attachments.insert(att.attachment_rowid) {
                    continue;
                }
                if let Some(path) =
                    resolve_attachment_path(source_conn, source_db_path, att.attachment_rowid)
                {
                    if let Ok((caption, model)) =
                        timeline_ai::caption_image_file(&path, &att.mime_type)
                    {
                        insights.push(TimelineMediaInsightInsert {
                            chat_id,
                            message_rowid: msg.rowid,
                            attachment_rowid: att.attachment_rowid,
                            mime_type: att.mime_type.clone(),
                            caption: caption.clone(),
                            model,
                            created_at: timeline_db::now_iso(),
                        });
                        if !node.summary.contains("Photo:") {
                            node.summary =
                                format!("{} Photo: {}", node.summary, truncate(&caption, 96));
                        }
                    }
                }
            }
        }
    }

    insights
}

fn truncate(s: &str, max_len: usize) -> String {
    if s.chars().count() <= max_len {
        s.to_string()
    } else {
        let v: String = s.chars().take(max_len).collect();
        format!("{}...", v)
    }
}

fn resolve_attachment_path(
    source_conn: &Connection,
    source_db_path: &Path,
    attachment_rowid: i32,
) -> Option<String> {
    let attachment = db::get_attachment_by_id(source_conn, attachment_rowid).ok()??;

    let source_db_path_buf = source_db_path.to_path_buf();
    let file_path =
        attachment.resolved_attachment_path(&Platform::macOS, &source_db_path_buf, None)?;

    let mime = attachment
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());

    if is_heic(&mime, &file_path) {
        convert_heic_to_jpeg(&file_path, attachment_rowid).ok()
    } else {
        Some(file_path)
    }
}

fn is_heic(mime: &str, file_path: &str) -> bool {
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

fn convert_heic_to_jpeg(source: &str, attachment_id: i32) -> Result<String, String> {
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

fn load_existing_nodes_for_resume(
    conn: &Connection,
    chat_id: i32,
    temp_id_seed: &mut i64,
) -> Result<Vec<TimelineNodeInsert>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT level, parent_id, ordinal, start_rowid, end_rowid, representative_rowid,
                    start_ts, end_ts, title, summary, keywords_json, message_count, media_count,
                    reaction_count, reply_count, confidence, ai_rationale, source_batch_id, is_draft
             FROM timeline_nodes
             WHERE chat_id = ?1 AND level = 3
             ORDER BY start_rowid ASC, ordinal ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([chat_id], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, Option<i64>>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, i32>(4)?,
                row.get::<_, i32>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, i32>(11)?,
                row.get::<_, i32>(12)?,
                row.get::<_, i32>(13)?,
                row.get::<_, i32>(14)?,
                row.get::<_, f64>(15)?,
                row.get::<_, Option<String>>(16)?,
                row.get::<_, Option<String>>(17)?,
                row.get::<_, i32>(18)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows.flatten() {
        let temp_id = *temp_id_seed;
        *temp_id_seed += 1;
        let keywords = serde_json::from_str::<Vec<String>>(&row.10).unwrap_or_default();

        out.push(TimelineNodeInsert {
            temp_id,
            chat_id,
            level: row.0 as u8,
            parent_temp_id: None,
            ordinal: row.2,
            start_rowid: row.3,
            end_rowid: row.4,
            representative_rowid: row.5,
            start_ts: row.6,
            end_ts: row.7,
            title: row.8,
            summary: row.9,
            keywords,
            message_count: row.11,
            media_count: row.12,
            reaction_count: row.13,
            reply_count: row.14,
            confidence: row.15 as f32,
            ai_rationale: row.16,
            source_batch_id: row.17,
            is_draft: row.18 != 0,
        });
    }

    assign_parents_by_containment(&mut out);
    Ok(out)
}

fn load_existing_memories_for_resume(
    conn: &Connection,
    chat_id: i32,
) -> Result<Vec<TimelineMemoryInsert>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT memory_id, memory_type, summary, confidence, first_seen_rowid, last_seen_rowid, support_rowids_json, updated_at
             FROM timeline_memories
             WHERE chat_id = ?1
             ORDER BY updated_at DESC
             LIMIT 128",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([chat_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, i32>(4)?,
                row.get::<_, i32>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut memories = Vec::new();
    for row in rows.flatten() {
        let support = serde_json::from_str::<Vec<i32>>(&row.6).unwrap_or_default();
        memories.push(TimelineMemoryInsert {
            memory_id: row.0,
            chat_id,
            memory_type: row.1,
            summary: row.2,
            confidence: row.3 as f32,
            first_seen_rowid: row.4,
            last_seen_rowid: row.5,
            support_rowids: support,
            updated_at: row.7,
        });
    }

    Ok(memories)
}

fn aggregate_counts(
    messages: &[MessageFeature],
    start_rowid: i32,
    end_rowid: i32,
) -> (i32, i32, i32, i32) {
    let mut message_count = 0;
    let mut media_count = 0;
    let mut reaction_count = 0;
    let mut reply_count = 0;

    for msg in messages
        .iter()
        .filter(|m| m.rowid >= start_rowid && m.rowid <= end_rowid)
    {
        message_count += 1;
        media_count += msg.attachments.iter().filter(|a| a.is_image).count() as i32;
        reaction_count += msg.reaction_count;
        if msg.reply_root_guid.is_some() {
            reply_count += 1;
        }
    }

    (message_count, media_count, reaction_count, reply_count)
}

fn rowid_to_iso(messages: &[MessageFeature], rowid: i32) -> String {
    messages
        .iter()
        .find(|m| m.rowid >= rowid)
        .or_else(|| messages.last())
        .map(|m| m.iso_ts.clone())
        .unwrap_or_else(timeline_db::now_iso)
}

fn find_temp_by_range(ranges: &[(i32, i32, i64)], start: i32, end: i32) -> Option<i64> {
    ranges
        .iter()
        .filter(|(s, e, _)| ranges_overlap(*s, *e, start, end))
        .min_by_key(|(s, e, _)| overlap_distance(*s, *e, start, end))
        .map(|(_, _, id)| *id)
}

fn overlap_distance(a_start: i32, a_end: i32, b_start: i32, b_end: i32) -> i32 {
    let start = max(a_start, b_start);
    let end = min(a_end, b_end);
    if end >= start {
        -(end - start)
    } else {
        (a_start - b_start).abs() + (a_end - b_end).abs()
    }
}

fn ranges_overlap(a_start: i32, a_end: i32, b_start: i32, b_end: i32) -> bool {
    max(a_start, b_start) <= min(a_end, b_end)
}

fn clamp_rowid(value: i32, start: i32, end: i32) -> i32 {
    value.clamp(min(start, end), max(start, end))
}

fn compose_rationale(
    base: Option<String>,
    grouping: Option<String>,
    context: Option<String>,
) -> Option<String> {
    let mut parts = Vec::new();
    if let Some(v) = base.filter(|s| !s.trim().is_empty()) {
        parts.push(v);
    }
    if let Some(v) = grouping.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("grouping={}", v));
    }
    if let Some(v) = context.filter(|s| !s.trim().is_empty()) {
        parts.push(format!("context_influence={}", v));
    }

    if parts.is_empty() {
        None
    } else {
        Some(parts.join("; "))
    }
}

fn query_source_max_rowid(conn: &Connection, chat_id: i32) -> Result<i32, rusqlite::Error> {
    conn.query_row(
        "SELECT COALESCE(MAX(m.ROWID), 0)
         FROM message m
         JOIN chat_message_join c ON c.message_id = m.ROWID
         WHERE c.chat_id = ?1",
        [chat_id],
        |row| row.get(0),
    )
}

fn is_canceled(cancel_jobs: &Arc<Mutex<HashSet<i32>>>, chat_id: i32) -> bool {
    cancel_jobs
        .lock()
        .ok()
        .map(|set| set.contains(&chat_id))
        .unwrap_or(false)
}

fn mark_canceled(
    timeline_conn: &Connection,
    job_id: &str,
    job: &mut TimelineJobState,
) -> Result<(), String> {
    job.status = "canceled".to_string();
    job.phase = "finalizing".to_string();
    job.updated_at = Some(timeline_db::now_iso());
    job.finished_at = Some(timeline_db::now_iso());
    job.error = Some("Canceled by user".to_string());
    timeline_db::set_job_state(timeline_conn, job, job_id).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msg(rowid: i32) -> MessageFeature {
        MessageFeature {
            rowid,
            text: format!("message {}", rowid),
            is_from_me: rowid % 2 == 0,
            sender_name: Some("Me".to_string()),
            iso_ts: "2026-01-01T00:00:00Z".to_string(),
            reaction_count: 0,
            reply_root_guid: None,
            attachments: Vec::new(),
        }
    }

    fn named_chat_context() -> ChatContext {
        ChatContext {
            chat_title: "Chat".to_string(),
            participants: vec![
                AiParticipant {
                    full_name_or_handle: "Alice Johnson".to_string(),
                    short_name: "Alice".to_string(),
                    is_me: false,
                },
                AiParticipant {
                    full_name_or_handle: "Me".to_string(),
                    short_name: "Me".to_string(),
                    is_me: true,
                },
            ],
            conversation_span: AiSpan {
                start_ts: "2026-01-01T00:00:00Z".to_string(),
                end_ts: "2026-01-01T00:00:00Z".to_string(),
            },
        }
    }

    #[test]
    fn assign_parents_falls_back_when_no_containment_exists() {
        let mut nodes = vec![
            TimelineNodeInsert {
                temp_id: 1,
                chat_id: 1,
                level: 2,
                parent_temp_id: None,
                ordinal: 0,
                start_rowid: 100,
                end_rowid: 120,
                representative_rowid: 110,
                start_ts: "2026-01-01T00:00:00Z".to_string(),
                end_ts: "2026-01-01T00:00:00Z".to_string(),
                title: "Subtopic".to_string(),
                summary: "Subtopic".to_string(),
                keywords: Vec::new(),
                message_count: 0,
                media_count: 0,
                reaction_count: 0,
                reply_count: 0,
                confidence: 0.5,
                ai_rationale: None,
                source_batch_id: None,
                is_draft: true,
            },
            TimelineNodeInsert {
                temp_id: 2,
                chat_id: 1,
                level: 3,
                parent_temp_id: None,
                ordinal: 1,
                start_rowid: 130,
                end_rowid: 140,
                representative_rowid: 135,
                start_ts: "2026-01-01T00:00:00Z".to_string(),
                end_ts: "2026-01-01T00:00:00Z".to_string(),
                title: "Moment".to_string(),
                summary: "Moment".to_string(),
                keywords: Vec::new(),
                message_count: 0,
                media_count: 0,
                reaction_count: 0,
                reply_count: 0,
                confidence: 0.5,
                ai_rationale: None,
                source_batch_id: None,
                is_draft: true,
            },
        ];

        assign_parents_by_containment(&mut nodes);
        assert_eq!(nodes[1].parent_temp_id, Some(1));
    }

    #[test]
    fn hierarchy_backbone_adds_missing_levels() {
        let messages = vec![msg(10), msg(11), msg(12), msg(13)];
        let chat_context = named_chat_context();
        let mut temp_id_seed = 100;
        let mut nodes = vec![
            TimelineNodeInsert {
                temp_id: 1,
                chat_id: 1,
                level: 3,
                parent_temp_id: None,
                ordinal: 0,
                start_rowid: 10,
                end_rowid: 11,
                representative_rowid: 10,
                start_ts: "2026-01-01T00:00:00Z".to_string(),
                end_ts: "2026-01-01T00:00:00Z".to_string(),
                title: "Moment 1".to_string(),
                summary: "Moment".to_string(),
                keywords: Vec::new(),
                message_count: 0,
                media_count: 0,
                reaction_count: 0,
                reply_count: 0,
                confidence: 0.5,
                ai_rationale: None,
                source_batch_id: None,
                is_draft: true,
            },
            TimelineNodeInsert {
                temp_id: 2,
                chat_id: 1,
                level: 3,
                parent_temp_id: None,
                ordinal: 1,
                start_rowid: 12,
                end_rowid: 13,
                representative_rowid: 12,
                start_ts: "2026-01-01T00:00:00Z".to_string(),
                end_ts: "2026-01-01T00:00:00Z".to_string(),
                title: "Moment 2".to_string(),
                summary: "Moment".to_string(),
                keywords: Vec::new(),
                message_count: 0,
                media_count: 0,
                reaction_count: 0,
                reply_count: 0,
                confidence: 0.5,
                ai_rationale: None,
                source_batch_id: None,
                is_draft: true,
            },
        ];

        ensure_hierarchy_backbone(1, &messages, &chat_context, &mut temp_id_seed, &mut nodes);

        assert!(nodes.iter().any(|n| n.level == 2));
        assert!(nodes.iter().any(|n| n.level == 1));
        assert!(nodes.iter().any(|n| n.level == 0));
    }

    #[test]
    fn empty_summary_needs_fallback() {
        assert!(summary_needs_fallback(""));
        assert!(summary_needs_fallback("   "));
        assert!(!summary_needs_fallback("A real summary with content."));
    }

    #[test]
    fn literal_message_title_is_rejected() {
        let messages = vec![msg(100)];
        assert!(is_bad_title_for_range("message 100", 100, 100, &messages));
    }
}
