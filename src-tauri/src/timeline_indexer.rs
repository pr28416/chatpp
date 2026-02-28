use crate::db;
use crate::timeline_ai;
use crate::timeline_ai::{
    AiL0WindowContext, AiL2TopicInputMoment, AiL2TopicsContext, AiParticipant, AiWindowImageMeta,
    AiWindowMessage,
};
use crate::timeline_db;
use crate::timeline_types::{
    TimelineBatchRecord, TimelineEvidenceInsert, TimelineJobState, TimelineMediaInsightInsert,
    TimelineMemoryInsert, TimelineMetaRecord, TimelineNodeInsert, TimelineNodeLinkInsert,
    TimelineNodeMembershipInsert, TimelineNodeMemoryLinkInsert, TimelineNodeOccurrenceInsert,
    TIMELINE_PROMPT_VERSION, TIMELINE_SCHEMA_VERSION,
};
use chrono::DateTime;
use imessage_database::util::platform::Platform;
use rusqlite::Connection;
use std::cmp::{max, min};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const MAX_AI_ATTEMPTS: i32 = 4;
const RETRY_BACKOFF_MS: [u64; 3] = [1500, 4000, 10000];
const RETRY_JITTER_PCT: u64 = 20;

const DEFAULT_WINDOW_MAX_MESSAGES: usize = 120;
const DEFAULT_WINDOW_TARGET_CHARS: usize = 18_000;
const DEFAULT_WINDOW_OVERLAP_MESSAGES: usize = 24;
const DEFAULT_L0_CONTEXT_ITEMS: usize = 16;
const DEFAULT_PREVIOUS_TEXTS_COUNT: usize = 6;
const DEFAULT_IMAGE_WORKERS: usize = 6;
const DEFAULT_IMAGE_RETRIES: usize = 3;
const DEFAULT_SUBTOPIC_MAX_MOMENTS: usize = 6;
const DEFAULT_SUBTOPIC_MIN_MOMENTS: usize = 2;
const DEFAULT_SUBTOPIC_SPLIT_GAP_HOURS: i64 = 18;

#[derive(Clone, Debug)]
struct AttachmentFeature {
    attachment_rowid: i32,
    mime_type: String,
    is_image: bool,
    location: Option<String>,
}

#[derive(Clone, Debug)]
struct MessageFeature {
    rowid: i32,
    text: String,
    sender_name: Option<String>,
    iso_ts: String,
    attachments: Vec<AttachmentFeature>,
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
struct ImageTask {
    attachment_rowid: i32,
    mime_type: String,
    path: String,
}

#[derive(Clone, Debug)]
struct ImageCaptionResult {
    caption: String,
    model: String,
}

#[derive(Clone, Debug)]
struct ChatInputs {
    participants: Vec<AiParticipant>,
    messages: Vec<MessageFeature>,
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
            "[timeline-v3] job failed for chat {}: {}",
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
            "[timeline-v3] run completed chat={} full_rebuild={} resume_failed_only={} elapsed_ms={}",
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

    let run_id = Uuid::new_v4().to_string();
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
    job.phase = "loading".to_string();
    job.progress = 0.01;
    job.started_at = Some(timeline_db::now_iso());
    job.updated_at = Some(timeline_db::now_iso());
    job.run_id = Some(run_id.clone());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to initialize timeline job state: {}", e))?;

    let chat_inputs = load_chat_inputs(&source_conn, config.chat_id, contact_names)
        .map_err(|e| format!("Failed to load chat inputs: {}", e))?;
    let messages = chat_inputs.messages;
    let participants = chat_inputs.participants;

    if is_canceled(cancel_jobs, config.chat_id) {
        mark_canceled(&timeline_conn, &run_id, &mut job)?;
        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
        return Ok(());
    }

    job.total_messages = messages.len() as i32;
    job.processed_messages = 0;
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to set totals: {}", e))?;

    let image_workers = timeline_image_workers();
    let image_retries = timeline_image_retries();
    let mut media_insights = Vec::<TimelineMediaInsightInsert>::new();
    let mut caption_by_attachment = HashMap::<i32, ImageCaptionResult>::new();

    job.phase = "image-enrichment".to_string();
    job.progress = 0.10;
    job.updated_at = Some(timeline_db::now_iso());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to set image phase: {}", e))?;

    if timeline_ai::is_openai_enabled() {
        caption_by_attachment = enrich_images_concurrent(
            &source_conn,
            source_db_path,
            &messages,
            image_workers,
            image_retries,
            cancel_jobs,
            config.chat_id,
        );
    }

    if is_canceled(cancel_jobs, config.chat_id) {
        mark_canceled(&timeline_conn, &run_id, &mut job)?;
        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
        return Ok(());
    }

    let mut windows = build_sliding_windows(
        &messages,
        timeline_window_max_messages(),
        timeline_window_target_chars(),
        timeline_window_overlap_messages(),
    );

    if config.resume_failed_only {
        let failed = failed_windows_from_db(&timeline_conn, &windows, config.chat_id)
            .map_err(|e| format!("Failed to load failed windows: {}", e))?;
        if !failed.is_empty() {
            windows = failed;
        }
    }

    let mut temp_id_seed = 1_i64;
    let mut l0_nodes = if config.resume_failed_only {
        load_existing_level_nodes_for_resume(&timeline_conn, config.chat_id, 0, &mut temp_id_seed)
            .unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut failed_batches = 0_i32;
    let mut completed_batches = 0_i32;
    let mut openai_used = false;
    let mut degraded = false;

    job.phase = "l0-generation".to_string();
    job.progress = 0.18;
    job.updated_at = Some(timeline_db::now_iso());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to set l0 phase: {}", e))?;

    let mut seen_ranges = HashSet::<(i32, i32)>::new();
    for node in &l0_nodes {
        seen_ranges.insert((node.start_rowid, node.end_rowid));
    }

    for (window_idx, window) in windows.iter().enumerate() {
        if is_canceled(cancel_jobs, config.chat_id) {
            mark_canceled(&timeline_conn, &run_id, &mut job)?;
            let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
            return Ok(());
        }

        let batch_id = format!("{}-{}", &run_id, window.seq);
        let mut batch_record = TimelineBatchRecord {
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
            .map_err(|e| format!("Failed to persist running batch: {}", e))?;

        let recent_moments = l0_nodes
            .iter()
            .rev()
            .take(timeline_l0_context_items())
            .map(|n| {
                format!(
                    "{} [{}-{}]: {}",
                    n.title, n.start_rowid, n.end_rowid, n.summary
                )
            })
            .collect::<Vec<_>>();

        let ai_result = run_l0_window_with_retries(
            &run_id,
            config.chat_id,
            &batch_id,
            window,
            &messages,
            &participants,
            &caption_by_attachment,
            recent_moments,
            &mut batch_record,
            cancel_jobs,
        );

        match ai_result {
            Ok(items) => {
                openai_used = true;
                completed_batches += 1;
                remove_overlapping_l0(&mut l0_nodes, window.start_rowid, window.end_rowid);

                let mut produced = 0usize;
                for item in items {
                    let start_rowid = item.start_rowid.clamp(window.start_rowid, window.end_rowid);
                    let end_rowid = item.end_rowid.clamp(start_rowid, window.end_rowid);
                    let range_key = (start_rowid, end_rowid);
                    if seen_ranges.contains(&range_key) {
                        continue;
                    }
                    seen_ranges.insert(range_key);
                    produced += 1;

                    let rep = item.representative_rowid.clamp(start_rowid, end_rowid);
                    let (start_ts, end_ts) = range_timestamps(&messages, start_rowid, end_rowid);
                    let (message_count, media_count, reaction_count, reply_count) =
                        aggregate_counts(&messages, start_rowid, end_rowid);
                    let (title, summary, is_draft) =
                        if low_signal_timeline_text(&item.title, &item.summary) {
                            let (t, s) = fallback_l0_text(start_rowid, end_rowid, &messages);
                            (t, s, true)
                        } else {
                            (item.title, item.summary, false)
                        };

                    let temp_id = temp_id_seed;
                    temp_id_seed += 1;

                    l0_nodes.push(TimelineNodeInsert {
                        temp_id,
                        chat_id: config.chat_id,
                        level: 0,
                        parent_temp_id: None,
                        ordinal: 0,
                        start_rowid,
                        end_rowid,
                        representative_rowid: rep,
                        start_ts,
                        end_ts,
                        title,
                        summary,
                        keywords: item.keywords,
                        message_count,
                        media_count,
                        reaction_count,
                        reply_count,
                        confidence: item.confidence,
                        ai_rationale: item.rationale,
                        source_batch_id: Some(batch_id.clone()),
                        is_draft,
                    });
                }

                if produced == 0 {
                    let fallback = fallback_timeline_item(window, &messages);
                    if !seen_ranges.contains(&(fallback.start_rowid, fallback.end_rowid)) {
                        seen_ranges.insert((fallback.start_rowid, fallback.end_rowid));
                        let temp_id = temp_id_seed;
                        temp_id_seed += 1;
                        l0_nodes.push(TimelineNodeInsert {
                            temp_id,
                            chat_id: config.chat_id,
                            level: 0,
                            parent_temp_id: None,
                            ordinal: 0,
                            start_rowid: fallback.start_rowid,
                            end_rowid: fallback.end_rowid,
                            representative_rowid: fallback.representative_rowid,
                            start_ts: fallback.start_ts,
                            end_ts: fallback.end_ts,
                            title: fallback.title,
                            summary: fallback.summary,
                            keywords: fallback.keywords,
                            message_count: fallback.message_count,
                            media_count: fallback.media_count,
                            reaction_count: fallback.reaction_count,
                            reply_count: fallback.reply_count,
                            confidence: 0.35,
                            ai_rationale: Some("fallback window coverage".to_string()),
                            source_batch_id: Some(batch_id.clone()),
                            is_draft: true,
                        });
                    }
                }

                batch_record.status = "completed".to_string();
                batch_record.error = None;
                batch_record.completed_at = Some(timeline_db::now_iso());
            }
            Err(err) => {
                if err == "Canceled by user" {
                    mark_canceled(&timeline_conn, &run_id, &mut job)?;
                    let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
                    return Ok(());
                }
                failed_batches += 1;
                degraded = true;
                batch_record.status = "failed".to_string();
                batch_record.error = Some(err);
            }
        }

        timeline_db::upsert_batch(&timeline_conn, &batch_record)
            .map_err(|e| format!("Failed to update batch state: {}", e))?;

        job.processed_messages = ((window_idx + 1) as i32).min(job.total_messages);
        job.failed_batches = failed_batches;
        job.completed_batches = completed_batches;
        job.progress = 0.18 + ((window_idx as f32 + 1.0) / (windows.len().max(1) as f32)) * 0.42;
        job.updated_at = Some(timeline_db::now_iso());
        timeline_db::set_job_state(&timeline_conn, &job, &run_id)
            .map_err(|e| format!("Failed to persist l0 progress: {}", e))?;
    }

    l0_nodes.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.representative_rowid));
    for (i, node) in l0_nodes.iter_mut().enumerate() {
        node.ordinal = i as i32;
    }

    if l0_nodes.is_empty() {
        return Err("L0 generation produced no nodes".to_string());
    }

    let mut all_nodes = l0_nodes;
    let mut all_occurrences = Vec::<TimelineNodeOccurrenceInsert>::new();
    let mut all_memberships = Vec::<TimelineNodeMembershipInsert>::new();

    for node in &all_nodes {
        all_occurrences.push(TimelineNodeOccurrenceInsert {
            node_temp_id: node.temp_id,
            ordinal: 0,
            start_rowid: node.start_rowid,
            end_rowid: node.end_rowid,
            representative_rowid: node.representative_rowid,
            start_ts: node.start_ts.clone(),
            end_ts: node.end_ts.clone(),
            message_count: node.message_count,
            media_count: node.media_count,
            reaction_count: node.reaction_count,
            reply_count: node.reply_count,
        });
    }

    if is_canceled(cancel_jobs, config.chat_id) {
        mark_canceled(&timeline_conn, &run_id, &mut job)?;
        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
        return Ok(());
    }

    job.phase = "l2-topics".to_string();
    job.progress = 0.66;
    job.updated_at = Some(timeline_db::now_iso());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to persist l2 phase: {}", e))?;

    let l0_nodes_snapshot = all_nodes.clone();
    let mut topic_result = match generate_l2_topics_from_l0(
        config.chat_id,
        &participants,
        &l0_nodes_snapshot,
        &messages,
        &mut temp_id_seed,
        cancel_jobs,
    ) {
        Ok(result) => {
            openai_used = true;
            result
        }
        Err(err) => {
            if err == "Canceled by user" {
                mark_canceled(&timeline_conn, &run_id, &mut job)?;
                let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
                return Ok(());
            }
            degraded = true;
            job.error = Some(match job.error.take() {
                Some(existing) => format!("{} | {}", existing, err),
                None => err,
            });
            build_fallback_topic_generation(
                config.chat_id,
                &l0_nodes_snapshot,
                &messages,
                &mut temp_id_seed,
            )
        }
    };

    if is_canceled(cancel_jobs, config.chat_id) {
        mark_canceled(&timeline_conn, &run_id, &mut job)?;
        let _ = timeline_db::finish_run(&timeline_conn, &run_id, "canceled");
        return Ok(());
    }

    job.phase = "l1-subtopics".to_string();
    job.progress = 0.82;
    job.updated_at = Some(timeline_db::now_iso());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to persist l1 phase: {}", e))?;

    let subtopic_result = build_l1_contiguous_subtopics(
        config.chat_id,
        &all_nodes,
        &topic_result.moment_to_topic,
        &topic_result.topics,
        &messages,
        &mut temp_id_seed,
    );

    for node in &mut all_nodes {
        if let Some(parent_temp_id) = subtopic_result.moment_to_subtopic.get(&node.temp_id) {
            node.parent_temp_id = Some(*parent_temp_id);
        }
    }

    for topic in &mut topic_result.topics {
        topic.parent_temp_id = None;
    }

    all_occurrences.extend(subtopic_result.occurrences.clone());
    all_occurrences.extend(topic_result.occurrences.clone());
    all_memberships.extend(subtopic_result.memberships.clone());

    all_nodes.extend(subtopic_result.subtopics);
    all_nodes.extend(topic_result.topics);

    assign_level_ordinals(&mut all_nodes);

    job.phase = "persist".to_string();
    job.progress = 0.93;
    job.updated_at = Some(timeline_db::now_iso());
    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to persist persist phase: {}", e))?;

    let mut evidence = Vec::<TimelineEvidenceInsert>::new();
    for node in &all_nodes {
        evidence.push(TimelineEvidenceInsert {
            node_temp_id: node.temp_id,
            rowid: node.representative_rowid,
            reason: "anchor".to_string(),
            weight: node.confidence.max(0.1),
        });
    }

    let mut links = Vec::<TimelineNodeLinkInsert>::new();
    append_prev_moment_links(&all_nodes, &mut links);

    for msg in &messages {
        for att in &msg.attachments {
            if let Some(caption) = caption_by_attachment.get(&att.attachment_rowid) {
                media_insights.push(TimelineMediaInsightInsert {
                    chat_id: config.chat_id,
                    message_rowid: msg.rowid,
                    attachment_rowid: att.attachment_rowid,
                    mime_type: att.mime_type.clone(),
                    caption: caption.caption.clone(),
                    model: caption.model.clone(),
                    created_at: timeline_db::now_iso(),
                });
            }
        }
    }

    timeline_db::replace_chat_timeline(
        &mut timeline_conn,
        config.chat_id,
        &all_nodes,
        &all_occurrences,
        &all_memberships,
        &evidence,
        &links,
        &media_insights,
        &Vec::<TimelineMemoryInsert>::new(),
        &Vec::<TimelineNodeMemoryLinkInsert>::new(),
    )
    .map_err(|e| format!("Failed to persist final timeline: {}", e))?;

    let has_failed = failed_batches > 0;
    let has_levels_12 = (1_u8..=2_u8).all(|lvl| all_nodes.iter().any(|n| n.level == lvl));
    let coverage = compute_message_coverage_by_level(&messages, &all_nodes);
    let l0_coverage_ratio = if coverage.total_messages > 0 {
        coverage.covered[0] as f32 / coverage.total_messages as f32
    } else {
        0.0
    };
    let l0_min_for_complete = timeline_l0_min_complete_coverage();
    if !has_levels_12 {
        degraded = true;
    }
    if l0_coverage_ratio < l0_min_for_complete {
        degraded = true;
        let msg = format!(
            "L0 coverage below complete threshold ({:.1}% < {:.1}%)",
            l0_coverage_ratio * 100.0,
            l0_min_for_complete * 100.0
        );
        job.error = Some(match job.error.take() {
            Some(existing) => format!("{} | {}", existing, msg),
            None => msg,
        });
    }

    let index_health = if has_failed || degraded {
        "partial"
    } else {
        "complete"
    }
    .to_string();

    timeline_db::upsert_meta(
        &timeline_conn,
        &TimelineMetaRecord {
            chat_id: config.chat_id,
            schema_version: TIMELINE_SCHEMA_VERSION,
            source_max_rowid,
            indexed_max_rowid: if !all_nodes.is_empty() {
                source_max_rowid
            } else {
                0
            },
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
    job.status = "completed".to_string();
    job.failed_batches = failed_batches;
    job.completed_batches = completed_batches;
    job.degraded = degraded || has_failed;
    job.openai_used = openai_used;
    job.updated_at = Some(timeline_db::now_iso());
    job.finished_at = Some(timeline_db::now_iso());

    timeline_db::set_job_state(&timeline_conn, &job, &run_id)
        .map_err(|e| format!("Failed to finalize timeline job state: {}", e))?;

    let run_status = if index_health == "complete" {
        "completed"
    } else {
        "partial"
    };
    let _ = timeline_db::finish_run(&timeline_conn, &run_id, run_status);

    eprintln!(
        "[timeline-v3] finalize run_id={} chat={} health={} l0_coverage={}/{} ({:.1}%) nodes={} media={} completed_batches={} failed_batches={} elapsed_ms={}",
        run_id,
        config.chat_id,
        index_health,
        coverage.covered[0],
        coverage.total_messages,
        l0_coverage_ratio * 100.0,
        all_nodes.len(),
        media_insights.len(),
        completed_batches,
        failed_batches,
        run_started.elapsed().as_millis()
    );

    Ok(())
}

#[derive(Clone, Debug, Default)]
struct MessageCoverageStats {
    total_messages: usize,
    covered: [usize; 3],
}

fn compute_message_coverage_by_level(
    messages: &[MessageFeature],
    nodes: &[TimelineNodeInsert],
) -> MessageCoverageStats {
    let mut stats = MessageCoverageStats {
        total_messages: messages.len(),
        covered: [0; 3],
    };
    if messages.is_empty() {
        return stats;
    }
    for level in 0_u8..=2 {
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

fn load_chat_inputs(
    conn: &Connection,
    chat_id: i32,
    contact_names: &HashMap<String, String>,
) -> Result<ChatInputs, Box<dyn std::error::Error + Send + Sync>> {
    let _chat_title: String = conn
        .query_row(
            "SELECT COALESCE(NULLIF(display_name, ''), chat_identifier) FROM chat WHERE ROWID = ?1",
            [chat_id],
            |row| row.get(0),
        )
        .unwrap_or_else(|_| format!("chat-{}", chat_id));

    let participants = resolve_participants_for_chat(conn, chat_id, contact_names)?;
    let attachments = load_message_attachments(conn, chat_id)?;
    let handle_lookup = load_handle_lookup(conn)?;

    let mut stmt = conn.prepare(
        "SELECT m.ROWID, m.text, m.is_from_me, m.date, m.handle_id
         FROM message m
         JOIN chat_message_join c ON c.message_id = m.ROWID
         WHERE c.chat_id = ?1
           AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
         ORDER BY m.ROWID ASC",
    )?;

    let rows = stmt.query_map([chat_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, Option<String>>(1)?,
            row.get::<_, bool>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<i32>>(4)?,
        ))
    })?;

    let mut messages = Vec::new();
    for row in rows {
        let (rowid, text, is_from_me, apple_ts, handle_id) = row?;
        let sender_name = if is_from_me {
            Some("Me".to_string())
        } else {
            handle_id
                .and_then(|id| handle_lookup.get(&id).cloned())
                .map(|raw| resolve_sender_display_name(&raw, contact_names))
        };

        messages.push(MessageFeature {
            rowid,
            text: normalize_text(text.as_deref().unwrap_or("")),
            sender_name,
            iso_ts: db::apple_timestamp_to_iso(apple_ts).unwrap_or_else(|| timeline_db::now_iso()),
            attachments: attachments.get(&rowid).cloned().unwrap_or_default(),
        });
    }

    Ok(ChatInputs {
        participants,
        messages,
    })
}

fn resolve_participants_for_chat(
    conn: &Connection,
    chat_id: i32,
    contact_names: &HashMap<String, String>,
) -> Result<Vec<AiParticipant>, Box<dyn std::error::Error + Send + Sync>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT h.id
         FROM chat_handle_join chj
         JOIN handle h ON h.ROWID = chj.handle_id
         WHERE chj.chat_id = ?1",
    )?;

    let rows = stmt.query_map([chat_id], |row| row.get::<_, String>(0))?;
    let mut participants = Vec::new();
    for raw in rows.flatten() {
        let display = resolve_sender_display_name(&raw, contact_names);
        let short_name = short_name(&display);
        participants.push(AiParticipant {
            full_name_or_handle: display,
            short_name,
            is_me: false,
        });
    }

    participants.sort_by(|a, b| a.full_name_or_handle.cmp(&b.full_name_or_handle));
    participants.dedup_by(|a, b| a.full_name_or_handle == b.full_name_or_handle);

    participants.push(AiParticipant {
        full_name_or_handle: "Me".to_string(),
        short_name: "Me".to_string(),
        is_me: true,
    });

    Ok(participants)
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
    let (has_lat, has_lon) = attachment_location_columns(conn)?;

    let sql = if has_lat && has_lon {
        "SELECT maj.message_id, a.ROWID, COALESCE(a.mime_type, ''), a.latitude, a.longitude
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         JOIN chat_message_join c ON c.message_id = maj.message_id
         WHERE c.chat_id = ?1"
    } else {
        "SELECT maj.message_id, a.ROWID, COALESCE(a.mime_type, ''), NULL, NULL
         FROM message_attachment_join maj
         JOIN attachment a ON a.ROWID = maj.attachment_id
         JOIN chat_message_join c ON c.message_id = maj.message_id
         WHERE c.chat_id = ?1"
    };

    let mut stmt = conn.prepare(sql)?;
    let rows = stmt.query_map([chat_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, Option<f64>>(3)?,
            row.get::<_, Option<f64>>(4)?,
        ))
    })?;

    let mut map: HashMap<i32, Vec<AttachmentFeature>> = HashMap::new();
    for row in rows {
        let (message_rowid, attachment_rowid, mime_type, lat, lon) = row?;
        let location = match (lat, lon) {
            (Some(a), Some(b)) => Some(format!("{:.5},{:.5}", a, b)),
            _ => None,
        };
        map.entry(message_rowid)
            .or_default()
            .push(AttachmentFeature {
                attachment_rowid,
                is_image: mime_type.to_lowercase().starts_with("image/"),
                mime_type,
                location,
            });
    }

    Ok(map)
}

fn attachment_location_columns(conn: &Connection) -> Result<(bool, bool), rusqlite::Error> {
    let mut stmt = conn.prepare("PRAGMA table_info(attachment)")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
    let mut has_lat = false;
    let mut has_lon = false;

    for name in rows.flatten() {
        let lower = name.to_lowercase();
        if lower == "latitude" {
            has_lat = true;
        }
        if lower == "longitude" {
            has_lon = true;
        }
    }

    Ok((has_lat, has_lon))
}

fn enrich_images_concurrent(
    source_conn: &Connection,
    source_db_path: &Path,
    messages: &[MessageFeature],
    workers: usize,
    retries: usize,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
    chat_id: i32,
) -> HashMap<i32, ImageCaptionResult> {
    let mut tasks = VecDeque::<ImageTask>::new();
    let mut seen = HashSet::<i32>::new();

    for message in messages {
        for att in message.attachments.iter().filter(|a| a.is_image) {
            if !seen.insert(att.attachment_rowid) {
                continue;
            }
            if let Some(path) =
                resolve_attachment_path(source_conn, source_db_path, att.attachment_rowid)
            {
                tasks.push_back(ImageTask {
                    attachment_rowid: att.attachment_rowid,
                    mime_type: att.mime_type.clone(),
                    path,
                });
            }
        }
    }

    if tasks.is_empty() {
        return HashMap::new();
    }

    let queue = Arc::new(Mutex::new(tasks));
    let out = Arc::new(Mutex::new(HashMap::<i32, ImageCaptionResult>::new()));

    let worker_count = workers.max(1).min(12);
    let mut handles = Vec::new();

    for _ in 0..worker_count {
        let queue = queue.clone();
        let out = out.clone();
        let cancel_jobs = cancel_jobs.clone();
        handles.push(thread::spawn(move || loop {
            if is_canceled(&cancel_jobs, chat_id) {
                break;
            }
            let task = {
                let mut locked = match queue.lock() {
                    Ok(v) => v,
                    Err(_) => return,
                };
                locked.pop_front()
            };

            let Some(task) = task else {
                break;
            };

            if let Some(result) = caption_with_retries(&task.path, &task.mime_type, retries) {
                if let Ok(mut locked) = out.lock() {
                    locked.insert(task.attachment_rowid, result);
                }
            }
        }));
    }

    for handle in handles {
        let _ = handle.join();
    }

    out.lock().map(|v| v.clone()).unwrap_or_default()
}

fn caption_with_retries(path: &str, mime_type: &str, retries: usize) -> Option<ImageCaptionResult> {
    let total = retries.max(1);
    for attempt in 1..=total {
        match timeline_ai::caption_image_file(path, mime_type) {
            Ok((caption, model)) => {
                return Some(ImageCaptionResult { caption, model });
            }
            Err(err) => {
                if attempt < total {
                    let backoff = backoff_with_jitter_ms(attempt as i32);
                    eprintln!(
                        "[timeline-v3] image caption retry path={} attempt={}/{} backoff_ms={} err={}",
                        path, attempt, total, backoff, err
                    );
                    thread::sleep(Duration::from_millis(backoff));
                }
            }
        }
    }
    None
}

fn build_sliding_windows(
    messages: &[MessageFeature],
    max_messages: usize,
    target_chars: usize,
    overlap: usize,
) -> Vec<BatchWindow> {
    if messages.is_empty() {
        return Vec::new();
    }

    let mut windows = Vec::new();
    let mut start_idx = 0usize;
    let mut seq = 0_i32;

    while start_idx < messages.len() {
        let mut end_idx = start_idx;
        let mut total_chars = 0usize;

        while end_idx < messages.len() && (end_idx - start_idx) < max_messages {
            let next_chars = messages[end_idx].text.chars().count().max(1) + 24;
            let would_exceed = total_chars + next_chars > target_chars;
            if would_exceed && end_idx > start_idx && (end_idx - start_idx) >= (max_messages / 3) {
                break;
            }
            total_chars += next_chars;
            end_idx += 1;
        }

        if end_idx == start_idx {
            end_idx = min(start_idx + 1, messages.len());
        }

        let end_pos = end_idx - 1;
        windows.push(BatchWindow {
            seq,
            start_idx,
            end_idx: end_pos,
            start_rowid: messages[start_idx].rowid,
            end_rowid: messages[end_pos].rowid,
        });
        seq += 1;

        if end_idx >= messages.len() {
            break;
        }

        let overlap = overlap.min(end_pos + 1);
        let next_start = end_pos + 1 - overlap;
        start_idx = max(start_idx + 1, next_start);
    }

    let mut seen = HashSet::<(i32, i32)>::new();
    windows
        .into_iter()
        .filter(|w| seen.insert((w.start_rowid, w.end_rowid)))
        .collect()
}

fn failed_windows_from_db(
    conn: &Connection,
    all_windows: &[BatchWindow],
    chat_id: i32,
) -> Result<Vec<BatchWindow>, Box<dyn std::error::Error + Send + Sync>> {
    let failed = timeline_db::latest_failed_batches(conn, chat_id)?;
    if failed.is_empty() {
        return Ok(Vec::new());
    }

    let mut out = Vec::new();
    for (_seq, start_rowid, end_rowid) in failed {
        if let Some(existing) = all_windows
            .iter()
            .find(|w| w.start_rowid == start_rowid && w.end_rowid == end_rowid)
        {
            out.push(existing.clone());
        }
    }

    Ok(out)
}

fn run_l0_window_with_retries(
    run_id: &str,
    chat_id: i32,
    window_id: &str,
    window: &BatchWindow,
    messages: &[MessageFeature],
    participants: &[AiParticipant],
    caption_by_attachment: &HashMap<i32, ImageCaptionResult>,
    current_moments_context: Vec<String>,
    batch_record: &mut TimelineBatchRecord,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
) -> Result<Vec<timeline_ai::AiTimelineItemOutput>, String> {
    let previous_texts =
        collect_previous_texts(messages, window.start_idx, DEFAULT_PREVIOUS_TEXTS_COUNT);
    let new_texts = build_window_messages(
        &messages[window.start_idx..=window.end_idx],
        caption_by_attachment,
    );

    let context = AiL0WindowContext {
        chat_id,
        window_id: window_id.to_string(),
        participants: participants.to_vec(),
        current_moments_context,
        previous_texts,
        new_texts,
        prompt_version: TIMELINE_PROMPT_VERSION,
    };

    let mut last_err: Option<String> = None;
    for attempt in 1..=MAX_AI_ATTEMPTS {
        if is_canceled(cancel_jobs, chat_id) {
            return Err("Canceled by user".to_string());
        }

        batch_record.retry_count = attempt - 1;
        match timeline_ai::generate_l0_moments(&context) {
            Ok(out) => return Ok(out.items),
            Err(err) => {
                let retryable = timeline_ai::is_retryable_ai_error(&err);
                last_err = Some(err.clone());
                eprintln!(
                    "[timeline-v3] l0 retry run_id={} chat={} window={} attempt={}/{} retryable={} err={}",
                    run_id,
                    chat_id,
                    window_id,
                    attempt,
                    MAX_AI_ATTEMPTS,
                    retryable,
                    err
                );
                if attempt < MAX_AI_ATTEMPTS && retryable {
                    let backoff = backoff_with_jitter_ms(attempt);
                    thread::sleep(Duration::from_millis(backoff));
                } else {
                    break;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "Unknown L0 generation failure".to_string()))
}

fn build_window_messages(
    messages: &[MessageFeature],
    caption_by_attachment: &HashMap<i32, ImageCaptionResult>,
) -> Vec<AiWindowMessage> {
    messages
        .iter()
        .map(|m| {
            let mut images = Vec::<AiWindowImageMeta>::new();
            for att in m.attachments.iter().filter(|a| a.is_image) {
                let caption = caption_by_attachment
                    .get(&att.attachment_rowid)
                    .map(|v| v.caption.clone());
                if caption.is_none() && att.location.is_none() {
                    continue;
                }
                images.push(AiWindowImageMeta {
                    attachment_rowid: att.attachment_rowid,
                    caption,
                    location: att.location.clone(),
                });
            }

            AiWindowMessage {
                rowid: m.rowid,
                timestamp: m.iso_ts.clone(),
                sender_name: m.sender_name.clone(),
                text: m.text.clone(),
                urls: extract_urls(&m.text),
                images,
            }
        })
        .collect()
}

fn collect_previous_texts(
    messages: &[MessageFeature],
    start_idx: usize,
    count: usize,
) -> Vec<AiWindowMessage> {
    if start_idx == 0 {
        return Vec::new();
    }

    let begin = start_idx.saturating_sub(count);
    build_window_messages(&messages[begin..start_idx], &HashMap::new())
}

fn extract_urls(text: &str) -> Vec<String> {
    text.split_whitespace()
        .filter(|token| token.starts_with("http://") || token.starts_with("https://"))
        .map(|token| {
            token
                .trim_end_matches(|c: char| ",.;)".contains(c))
                .to_string()
        })
        .collect()
}

#[derive(Clone, Debug)]
struct TopicCandidate {
    node: TimelineNodeInsert,
    moment_ids: Vec<i64>,
}

#[derive(Clone, Debug, Default)]
struct TopicGenerationResult {
    topics: Vec<TimelineNodeInsert>,
    occurrences: Vec<TimelineNodeOccurrenceInsert>,
    moment_to_topic: HashMap<i64, i64>,
}

#[derive(Clone, Debug, Default)]
struct ContiguousSubtopicResult {
    subtopics: Vec<TimelineNodeInsert>,
    occurrences: Vec<TimelineNodeOccurrenceInsert>,
    memberships: Vec<TimelineNodeMembershipInsert>,
    moment_to_subtopic: HashMap<i64, i64>,
}

fn generate_l2_topics_from_l0(
    chat_id: i32,
    participants: &[AiParticipant],
    l0_nodes: &[TimelineNodeInsert],
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
    cancel_jobs: &Arc<Mutex<HashSet<i32>>>,
) -> Result<TopicGenerationResult, String> {
    if l0_nodes.is_empty() {
        return Ok(TopicGenerationResult::default());
    }

    let context = AiL2TopicsContext {
        chat_id,
        participants: participants.to_vec(),
        moments: l0_nodes
            .iter()
            .map(|n| AiL2TopicInputMoment {
                moment_id: n.temp_id,
                start_rowid: n.start_rowid,
                end_rowid: n.end_rowid,
                representative_rowid: n.representative_rowid,
                title: n.title.clone(),
                summary: n.summary.clone(),
                keywords: n.keywords.clone(),
            })
            .collect(),
        prompt_version: TIMELINE_PROMPT_VERSION,
    };

    let mut last_err: Option<String> = None;
    for attempt in 1..=MAX_AI_ATTEMPTS {
        if is_canceled(cancel_jobs, chat_id) {
            return Err("Canceled by user".to_string());
        }

        match timeline_ai::generate_l2_topics(&context) {
            Ok(out) => {
                return Ok(build_topics_from_ai_output(
                    chat_id,
                    out.items,
                    l0_nodes,
                    messages,
                    temp_id_seed,
                ));
            }
            Err(err) => {
                let retryable = timeline_ai::is_retryable_ai_error(&err);
                last_err = Some(err.clone());
                if attempt < MAX_AI_ATTEMPTS && retryable {
                    thread::sleep(Duration::from_millis(backoff_with_jitter_ms(attempt)));
                } else {
                    break;
                }
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "L2 topic generation failed".to_string()))
}

fn build_topics_from_ai_output(
    chat_id: i32,
    ai_topics: Vec<timeline_ai::AiL2TopicOutput>,
    l0_nodes: &[TimelineNodeInsert],
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
) -> TopicGenerationResult {
    let moment_by_id: HashMap<i64, &TimelineNodeInsert> = l0_nodes.iter().map(|n| (n.temp_id, n)).collect();
    let mut candidates = Vec::<TopicCandidate>::new();

    for (idx, item) in ai_topics.into_iter().enumerate() {
        let mut moment_ids = item
            .moment_ids
            .into_iter()
            .filter(|id| moment_by_id.contains_key(id))
            .collect::<Vec<_>>();
        if moment_ids.is_empty() {
            continue;
        }
        sort_moment_ids_by_rowid(&mut moment_ids, &moment_by_id);
        moment_ids.dedup();

        let (start_rowid, end_rowid, rep_rowid) = topic_bounds_from_moments(&moment_ids, &moment_by_id);
        let (start_ts, end_ts) = range_timestamps(messages, start_rowid, end_rowid);
        let (message_count, media_count, reaction_count, reply_count) =
            aggregate_counts(messages, start_rowid, end_rowid);
        let segment_nodes = lookup_nodes(&moment_ids, &moment_by_id);
        let (title, summary) = if low_signal_timeline_text(&item.title, &item.summary) {
            fallback_aggregate_text(start_rowid, end_rowid, &segment_nodes)
        } else {
            (item.title, item.summary)
        };

        let temp_id = *temp_id_seed;
        *temp_id_seed += 1;
        candidates.push(TopicCandidate {
            node: TimelineNodeInsert {
                temp_id,
                chat_id,
                level: 2,
                parent_temp_id: None,
                ordinal: idx as i32,
                start_rowid,
                end_rowid,
                representative_rowid: rep_rowid,
                start_ts,
                end_ts,
                title,
                summary,
                keywords: item.keywords,
                message_count,
                media_count,
                reaction_count,
                reply_count,
                confidence: item.confidence.clamp(0.05, 1.0),
                ai_rationale: item.rationale,
                source_batch_id: Some("l2-topic-ai".to_string()),
                is_draft: false,
            },
            moment_ids,
        });
    }

    if candidates.is_empty() {
        return build_fallback_topic_generation(chat_id, l0_nodes, messages, temp_id_seed);
    }

    collapse_topic_candidates(&mut candidates);
    assign_moments_to_single_topic(chat_id, l0_nodes, candidates, messages, temp_id_seed)
}

fn build_fallback_topic_generation(
    chat_id: i32,
    l0_nodes: &[TimelineNodeInsert],
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
) -> TopicGenerationResult {
    if l0_nodes.is_empty() {
        return TopicGenerationResult::default();
    }

    let all_ids = l0_nodes.iter().map(|n| n.temp_id).collect::<Vec<_>>();
    let start_rowid = l0_nodes.iter().map(|n| n.start_rowid).min().unwrap_or(0);
    let end_rowid = l0_nodes.iter().map(|n| n.end_rowid).max().unwrap_or(start_rowid);
    let rep_rowid = l0_nodes
        .iter()
        .min_by_key(|n| n.start_rowid)
        .map(|n| n.representative_rowid)
        .unwrap_or(start_rowid);
    let (title, summary) = fallback_aggregate_text(start_rowid, end_rowid, l0_nodes);
    let (start_ts, end_ts) = range_timestamps(messages, start_rowid, end_rowid);
    let (message_count, media_count, reaction_count, reply_count) =
        aggregate_counts(messages, start_rowid, end_rowid);

    let topic_temp_id = *temp_id_seed;
    *temp_id_seed += 1;
    let topic = TimelineNodeInsert {
        temp_id: topic_temp_id,
        chat_id,
        level: 2,
        parent_temp_id: None,
        ordinal: 0,
        start_rowid,
        end_rowid,
        representative_rowid: rep_rowid,
        start_ts,
        end_ts,
        title,
        summary,
        keywords: vec!["topic".to_string()],
        message_count,
        media_count,
        reaction_count,
        reply_count,
        confidence: 0.35,
        ai_rationale: Some("fallback topic generation".to_string()),
        source_batch_id: Some("l2-topic-fallback".to_string()),
        is_draft: true,
    };

    let moment_by_id: HashMap<i64, &TimelineNodeInsert> = l0_nodes.iter().map(|n| (n.temp_id, n)).collect();
    let occurrences = derive_topic_occurrences(topic_temp_id, &all_ids, &moment_by_id, messages);
    let moment_to_topic = all_ids
        .iter()
        .copied()
        .map(|id| (id, topic_temp_id))
        .collect::<HashMap<_, _>>();

    TopicGenerationResult {
        topics: vec![topic],
        occurrences,
        moment_to_topic,
    }
}

fn collapse_topic_candidates(candidates: &mut Vec<TopicCandidate>) {
    if candidates.len() <= 1 {
        return;
    }

    let mut merged_any = true;
    while merged_any {
        merged_any = false;
        'outer: for i in 0..candidates.len() {
            for j in (i + 1)..candidates.len() {
                if should_merge_topic_candidates(&candidates[i], &candidates[j]) {
                    merge_topic_candidates(candidates, i, j);
                    merged_any = true;
                    break 'outer;
                }
            }
        }
    }
}

fn should_merge_topic_candidates(a: &TopicCandidate, b: &TopicCandidate) -> bool {
    let title_sim = token_jaccard(&a.node.title, &b.node.title);
    let keyword_sim = keyword_jaccard(&a.node.keywords, &b.node.keywords);
    let overlap = topic_moment_overlap(&a.moment_ids, &b.moment_ids);
    title_sim >= 0.56 || keyword_sim >= 0.58 || overlap >= 0.5
}

fn merge_topic_candidates(candidates: &mut Vec<TopicCandidate>, i: usize, j: usize) {
    if i >= candidates.len() || j >= candidates.len() || i == j {
        return;
    }
    let (keep_idx, drop_idx) = if candidates[i].node.confidence >= candidates[j].node.confidence {
        (i, j)
    } else {
        (j, i)
    };

    let drop = candidates.remove(drop_idx);
    let keep = &mut candidates[if drop_idx < keep_idx { keep_idx - 1 } else { keep_idx }];

    for id in drop.moment_ids {
        if !keep.moment_ids.contains(&id) {
            keep.moment_ids.push(id);
        }
    }
    keep.moment_ids.sort_unstable();
    keep.moment_ids.dedup();

    for kw in drop.node.keywords {
        if !keep.node.keywords.contains(&kw) {
            keep.node.keywords.push(kw);
        }
    }
    keep.node.keywords.truncate(12);
    keep.node.confidence = keep.node.confidence.max(drop.node.confidence);
    keep.node.ai_rationale = Some(match (&keep.node.ai_rationale, drop.node.ai_rationale) {
        (Some(a), Some(b)) => format!("{} | merged similar topic: {}", a, b),
        (None, Some(b)) => format!("merged similar topic: {}", b),
        (Some(a), None) => format!("{} | merged similar topic", a),
        (None, None) => "merged similar topic".to_string(),
    });
}

fn assign_moments_to_single_topic(
    chat_id: i32,
    l0_nodes: &[TimelineNodeInsert],
    candidates: Vec<TopicCandidate>,
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
) -> TopicGenerationResult {
    if candidates.is_empty() {
        return build_fallback_topic_generation(chat_id, l0_nodes, messages, temp_id_seed);
    }

    let mut topics = candidates;
    let mut claims = HashMap::<i64, Vec<usize>>::new();
    for (idx, candidate) in topics.iter().enumerate() {
        for moment_id in &candidate.moment_ids {
            claims.entry(*moment_id).or_default().push(idx);
        }
    }

    let mut assigned = HashMap::<i64, usize>::new();
    let mut unassigned = Vec::<i64>::new();
    let mut chron = l0_nodes.iter().map(|n| n.temp_id).collect::<Vec<_>>();
    let l0_by_id: HashMap<i64, &TimelineNodeInsert> = l0_nodes.iter().map(|n| (n.temp_id, n)).collect();
    sort_moment_ids_by_rowid(&mut chron, &l0_by_id);

    for moment_id in &chron {
        let Some(indices) = claims.get(moment_id) else {
            unassigned.push(*moment_id);
            continue;
        };
        let mut sorted_indices = indices.clone();
        sorted_indices.sort_by(|a, b| {
            let ta = &topics[*a];
            let tb = &topics[*b];
            tb.node
                .confidence
                .partial_cmp(&ta.node.confidence)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then(tb.moment_ids.len().cmp(&ta.moment_ids.len()))
                .then(ta.node.start_rowid.cmp(&tb.node.start_rowid))
                .then(ta.node.temp_id.cmp(&tb.node.temp_id))
        });
        if let Some(best) = sorted_indices.first() {
            assigned.insert(*moment_id, *best);
        }
    }

    for moment_id in unassigned {
        let Some(moment_node) = l0_by_id.get(&moment_id) else {
            continue;
        };
        let mut best_idx = 0usize;
        let mut best_tuple = (
            i32::MAX,
            f32::MIN,
            0usize,
            i64::MAX,
        );
        for (idx, topic) in topics.iter().enumerate() {
            let distance = rowid_distance(moment_node.representative_rowid, topic.node.start_rowid, topic.node.end_rowid);
            let score = (
                distance,
                topic.node.confidence,
                topic.moment_ids.len(),
                topic.node.temp_id,
            );
            if score.0 < best_tuple.0
                || (score.0 == best_tuple.0 && score.1 > best_tuple.1)
                || (score.0 == best_tuple.0
                    && (score.1 - best_tuple.1).abs() < f32::EPSILON
                    && score.2 > best_tuple.2)
                || (score.0 == best_tuple.0
                    && (score.1 - best_tuple.1).abs() < f32::EPSILON
                    && score.2 == best_tuple.2
                    && score.3 < best_tuple.3)
            {
                best_idx = idx;
                best_tuple = score;
            }
        }
        assigned.insert(moment_id, best_idx);
    }

    let mut topic_to_moments = HashMap::<usize, Vec<i64>>::new();
    for (moment_id, topic_idx) in assigned {
        topic_to_moments.entry(topic_idx).or_default().push(moment_id);
    }

    let mut result = TopicGenerationResult::default();
    for (topic_idx, mut moment_ids) in topic_to_moments {
        if moment_ids.is_empty() {
            continue;
        }
        sort_moment_ids_by_rowid(&mut moment_ids, &l0_by_id);
        moment_ids.dedup();

        let topic = &mut topics[topic_idx];
        let occurrences = derive_topic_occurrences(topic.node.temp_id, &moment_ids, &l0_by_id, messages);
        if occurrences.is_empty() {
            continue;
        }

        apply_occurrence_bounds(&mut topic.node, &occurrences);
        for moment_id in &moment_ids {
            result
                .moment_to_topic
                .insert(*moment_id, topic.node.temp_id);
        }
        result.occurrences.extend(occurrences);
        result.topics.push(topic.node.clone());
    }

    if result.topics.is_empty() {
        return build_fallback_topic_generation(chat_id, l0_nodes, messages, temp_id_seed);
    }

    result.topics.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.temp_id));
    for (idx, topic) in result.topics.iter_mut().enumerate() {
        topic.ordinal = idx as i32;
    }
    result
}

fn build_l1_contiguous_subtopics(
    chat_id: i32,
    l0_nodes: &[TimelineNodeInsert],
    moment_to_topic: &HashMap<i64, i64>,
    topic_nodes: &[TimelineNodeInsert],
    messages: &[MessageFeature],
    temp_id_seed: &mut i64,
) -> ContiguousSubtopicResult {
    let mut out = ContiguousSubtopicResult::default();
    if l0_nodes.is_empty() || topic_nodes.is_empty() {
        return out;
    }

    let l0_by_id: HashMap<i64, &TimelineNodeInsert> = l0_nodes.iter().map(|n| (n.temp_id, n)).collect();
    let mut moments_by_topic = HashMap::<i64, Vec<i64>>::new();
    for node in l0_nodes {
        if let Some(topic_temp_id) = moment_to_topic.get(&node.temp_id) {
            moments_by_topic
                .entry(*topic_temp_id)
                .or_default()
                .push(node.temp_id);
        }
    }

    let mut ordered_topics = topic_nodes.to_vec();
    ordered_topics.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.temp_id));

    for topic in ordered_topics {
        let mut moment_ids = moments_by_topic.remove(&topic.temp_id).unwrap_or_default();
        if moment_ids.is_empty() {
            continue;
        }
        sort_moment_ids_by_rowid(&mut moment_ids, &l0_by_id);
        let segments = split_into_contiguous_subtopics(&moment_ids, &l0_by_id);
        for segment in segments {
            if segment.is_empty() {
                continue;
            }

            let first = l0_by_id.get(&segment[0]).copied();
            let last_id = segment.last().copied().unwrap_or(segment[0]);
            let last = l0_by_id.get(&last_id).copied();
            let (Some(first), Some(last)) = (first, last) else {
                continue;
            };
            let start_rowid = first.start_rowid;
            let end_rowid = last.end_rowid;
            let rep_rowid = first.representative_rowid.clamp(start_rowid, end_rowid);
            let (start_ts, end_ts) = range_timestamps(messages, start_rowid, end_rowid);
            let (message_count, media_count, reaction_count, reply_count) =
                aggregate_counts(messages, start_rowid, end_rowid);
            let segment_nodes = lookup_nodes(&segment, &l0_by_id);
            let (title, summary) = contiguous_subtopic_text(&topic.title, &segment_nodes);
            let confidence = segment_nodes
                .iter()
                .map(|n| n.confidence)
                .sum::<f32>()
                / (segment_nodes.len().max(1) as f32);

            let subtopic_temp_id = *temp_id_seed;
            *temp_id_seed += 1;
            out.subtopics.push(TimelineNodeInsert {
                temp_id: subtopic_temp_id,
                chat_id,
                level: 1,
                parent_temp_id: Some(topic.temp_id),
                ordinal: 0,
                start_rowid,
                end_rowid,
                representative_rowid: rep_rowid,
                start_ts: start_ts.clone(),
                end_ts: end_ts.clone(),
                title,
                summary,
                keywords: merge_keywords(&segment_nodes),
                message_count,
                media_count,
                reaction_count,
                reply_count,
                confidence: confidence.clamp(0.05, 1.0),
                ai_rationale: Some(
                    "contiguous grouping by topic assignment and time/size boundaries".to_string(),
                ),
                source_batch_id: Some("l1-contiguous".to_string()),
                is_draft: false,
            });
            out.occurrences.push(TimelineNodeOccurrenceInsert {
                node_temp_id: subtopic_temp_id,
                ordinal: 0,
                start_rowid,
                end_rowid,
                representative_rowid: rep_rowid,
                start_ts,
                end_ts,
                message_count,
                media_count,
                reaction_count,
                reply_count,
            });
            out.memberships.push(TimelineNodeMembershipInsert {
                parent_temp_id: topic.temp_id,
                child_temp_id: subtopic_temp_id,
                weight: 1.0,
                reason: Some("single-parent contiguous grouping".to_string()),
            });

            for moment_id in segment {
                out.moment_to_subtopic.insert(moment_id, subtopic_temp_id);
                out.memberships.push(TimelineNodeMembershipInsert {
                    parent_temp_id: subtopic_temp_id,
                    child_temp_id: moment_id,
                    weight: 1.0,
                    reason: Some("single-parent contiguous grouping".to_string()),
                });
            }
        }
    }

    out.subtopics
        .sort_by_key(|n| (n.start_rowid, n.end_rowid, n.temp_id));
    for (idx, node) in out.subtopics.iter_mut().enumerate() {
        node.ordinal = idx as i32;
    }
    out
}

fn split_into_contiguous_subtopics(
    moment_ids: &[i64],
    l0_by_id: &HashMap<i64, &TimelineNodeInsert>,
) -> Vec<Vec<i64>> {
    let max_moments = timeline_subtopic_max_moments();
    let min_moments = timeline_subtopic_min_moments();
    let split_gap_hours = timeline_subtopic_split_gap_hours();

    let mut segments = Vec::<Vec<i64>>::new();
    let mut current = Vec::<i64>::new();

    for moment_id in moment_ids {
        let Some(next_node) = l0_by_id.get(moment_id).copied() else {
            continue;
        };
        let should_split = if let Some(prev_id) = current.last().copied() {
            let prev_node = l0_by_id.get(&prev_id).copied();
            let gap_hours = prev_node
                .map(|p| hours_between_iso(&p.end_ts, &next_node.start_ts))
                .unwrap_or(0);
            current.len() >= max_moments || gap_hours > split_gap_hours
        } else {
            false
        };

        if should_split {
            segments.push(current);
            current = vec![*moment_id];
        } else {
            current.push(*moment_id);
        }
    }
    if !current.is_empty() {
        segments.push(current);
    }

    if segments.len() <= 1 {
        return segments;
    }

    let mut idx = 0usize;
    while idx < segments.len() {
        if segments[idx].len() >= min_moments || segments.len() == 1 {
            idx += 1;
            continue;
        }
        if idx == 0 {
            let tiny = segments.remove(0);
            segments[0].splice(0..0, tiny);
            continue;
        }
        if idx >= segments.len() - 1 {
            if let Some(tiny) = segments.pop() {
                if let Some(prev) = segments.last_mut() {
                    prev.extend(tiny);
                }
            }
            break;
        }

        let prev_last = segments[idx - 1].last().copied();
        let tiny_first = segments[idx].first().copied();
        let tiny_last = segments[idx].last().copied();
        let next_first = segments[idx + 1].first().copied();
        let gap_prev = match (prev_last, tiny_first) {
            (Some(a), Some(b)) => rowid_gap(l0_by_id.get(&a).copied(), l0_by_id.get(&b).copied()),
            _ => i32::MAX,
        };
        let gap_next = match (tiny_last, next_first) {
            (Some(a), Some(b)) => rowid_gap(l0_by_id.get(&a).copied(), l0_by_id.get(&b).copied()),
            _ => i32::MAX,
        };
        let tiny = segments.remove(idx);
        if gap_prev <= gap_next {
            segments[idx - 1].extend(tiny);
        } else {
            segments[idx].splice(0..0, tiny);
        }
    }

    segments
}

fn contiguous_subtopic_text(topic_title: &str, moments: &[TimelineNodeInsert]) -> (String, String) {
    if moments.is_empty() {
        return (
            "You continued this thread".to_string(),
            format!("Within {}, you continued this thread in a contiguous stretch.", topic_title),
        );
    }

    let start_title = truncate_plain(&moments[0].title, 56);
    let end_title = truncate_plain(&moments[moments.len() - 1].title, 56);
    let title = if moments.len() == 1 {
        start_title
    } else {
        format!("{} -> {}", start_title, end_title)
    };
    let snippets = moments
        .iter()
        .take(3)
        .map(|m| truncate_plain(&m.title, 42))
        .collect::<Vec<_>>();
    let summary = format!(
        "Within {}, you moved through {} chronological moments: {}.",
        topic_title,
        moments.len(),
        snippets.join(" | ")
    );
    (title, summary)
}

fn lookup_nodes(
    ids: &[i64],
    moment_by_id: &HashMap<i64, &TimelineNodeInsert>,
) -> Vec<TimelineNodeInsert> {
    ids.iter()
        .filter_map(|id| moment_by_id.get(id).copied().cloned())
        .collect()
}

fn merge_keywords(nodes: &[TimelineNodeInsert]) -> Vec<String> {
    let mut out = Vec::<String>::new();
    for node in nodes {
        for kw in &node.keywords {
            if !out.contains(kw) {
                out.push(kw.clone());
            }
            if out.len() >= 12 {
                return out;
            }
        }
    }
    out
}

fn topic_bounds_from_moments(
    moment_ids: &[i64],
    moment_by_id: &HashMap<i64, &TimelineNodeInsert>,
) -> (i32, i32, i32) {
    let mut start = i32::MAX;
    let mut end = i32::MIN;
    let mut rep = 0_i32;
    for (idx, moment_id) in moment_ids.iter().enumerate() {
        let Some(node) = moment_by_id.get(moment_id).copied() else {
            continue;
        };
        start = start.min(node.start_rowid);
        end = end.max(node.end_rowid);
        if idx == 0 {
            rep = node.representative_rowid;
        }
    }
    if start == i32::MAX || end == i32::MIN {
        (0, 0, 0)
    } else {
        (start, end, rep.clamp(start, end))
    }
}

fn apply_occurrence_bounds(node: &mut TimelineNodeInsert, occurrences: &[TimelineNodeOccurrenceInsert]) {
    if occurrences.is_empty() {
        return;
    }
    node.start_rowid = occurrences.iter().map(|o| o.start_rowid).min().unwrap_or(node.start_rowid);
    node.end_rowid = occurrences.iter().map(|o| o.end_rowid).max().unwrap_or(node.end_rowid);
    node.representative_rowid = occurrences[0]
        .representative_rowid
        .clamp(node.start_rowid, node.end_rowid);
    node.start_ts = occurrences[0].start_ts.clone();
    node.end_ts = occurrences
        .last()
        .map(|o| o.end_ts.clone())
        .unwrap_or_else(|| node.end_ts.clone());
    node.message_count = occurrences.iter().map(|o| o.message_count).sum();
    node.media_count = occurrences.iter().map(|o| o.media_count).sum();
    node.reaction_count = occurrences.iter().map(|o| o.reaction_count).sum();
    node.reply_count = occurrences.iter().map(|o| o.reply_count).sum();
}

fn derive_topic_occurrences(
    topic_temp_id: i64,
    moment_ids: &[i64],
    moment_by_id: &HashMap<i64, &TimelineNodeInsert>,
    messages: &[MessageFeature],
) -> Vec<TimelineNodeOccurrenceInsert> {
    let mut ordered = moment_ids.to_vec();
    sort_moment_ids_by_rowid(&mut ordered, moment_by_id);
    if ordered.is_empty() {
        return Vec::new();
    }

    let mut groups = Vec::<Vec<i64>>::new();
    let mut current = Vec::<i64>::new();
    let mut current_end = i32::MIN;

    for moment_id in ordered {
        let Some(node) = moment_by_id.get(&moment_id).copied() else {
            continue;
        };
        if current.is_empty() {
            current.push(moment_id);
            current_end = node.end_rowid;
            continue;
        }
        if node.start_rowid <= current_end + 1 {
            current.push(moment_id);
            current_end = current_end.max(node.end_rowid);
        } else {
            groups.push(current);
            current = vec![moment_id];
            current_end = node.end_rowid;
        }
    }
    if !current.is_empty() {
        groups.push(current);
    }

    let mut out = Vec::<TimelineNodeOccurrenceInsert>::new();
    for (ordinal, group) in groups.into_iter().enumerate() {
        let Some(first) = group.first().and_then(|id| moment_by_id.get(id).copied()) else {
            continue;
        };
        let Some(last) = group.last().and_then(|id| moment_by_id.get(id).copied()) else {
            continue;
        };
        let start_rowid = first.start_rowid;
        let end_rowid = last.end_rowid.max(start_rowid);
        let rep_rowid = first.representative_rowid.clamp(start_rowid, end_rowid);
        let (start_ts, end_ts) = range_timestamps(messages, start_rowid, end_rowid);
        let (message_count, media_count, reaction_count, reply_count) =
            aggregate_counts(messages, start_rowid, end_rowid);
        out.push(TimelineNodeOccurrenceInsert {
            node_temp_id: topic_temp_id,
            ordinal: ordinal as i32,
            start_rowid,
            end_rowid,
            representative_rowid: rep_rowid,
            start_ts,
            end_ts,
            message_count,
            media_count,
            reaction_count,
            reply_count,
        });
    }
    out
}

fn assign_level_ordinals(nodes: &mut [TimelineNodeInsert]) {
    for level in 0_u8..=2_u8 {
        let mut indices = nodes
            .iter()
            .enumerate()
            .filter_map(|(idx, n)| (n.level == level).then_some(idx))
            .collect::<Vec<_>>();
        indices.sort_by_key(|idx| {
            let n = &nodes[*idx];
            (n.start_rowid, n.end_rowid, n.representative_rowid, n.temp_id)
        });
        for (ordinal, idx) in indices.into_iter().enumerate() {
            nodes[idx].ordinal = ordinal as i32;
        }
    }
}

fn sort_moment_ids_by_rowid(ids: &mut [i64], moment_by_id: &HashMap<i64, &TimelineNodeInsert>) {
    ids.sort_by_key(|id| {
        moment_by_id
            .get(id)
            .map(|n| (n.start_rowid, n.end_rowid, n.temp_id))
            .unwrap_or((i32::MAX, i32::MAX, i64::MAX))
    });
}

fn topic_moment_overlap(a: &[i64], b: &[i64]) -> f32 {
    let sa: HashSet<i64> = a.iter().copied().collect();
    let sb: HashSet<i64> = b.iter().copied().collect();
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count() as f32;
    let denom = sa.len().min(sb.len()) as f32;
    if denom <= 0.0 {
        0.0
    } else {
        inter / denom
    }
}

fn rowid_distance(rowid: i32, start: i32, end: i32) -> i32 {
    if rowid < start {
        start - rowid
    } else if rowid > end {
        rowid - end
    } else {
        0
    }
}

fn rowid_gap(a: Option<&TimelineNodeInsert>, b: Option<&TimelineNodeInsert>) -> i32 {
    match (a, b) {
        (Some(left), Some(right)) => (right.start_rowid - left.end_rowid).abs(),
        _ => i32::MAX,
    }
}

fn hours_between_iso(a: &str, b: &str) -> i64 {
    let Ok(start) = DateTime::parse_from_rfc3339(a) else {
        return 0;
    };
    let Ok(end) = DateTime::parse_from_rfc3339(b) else {
        return 0;
    };
    (end.timestamp() - start.timestamp()).max(0) / 3600
}

fn token_jaccard(a: &str, b: &str) -> f32 {
    let ta = normalize_topic_tokens(a);
    let tb = normalize_topic_tokens(b);
    if ta.is_empty() || tb.is_empty() {
        return 0.0;
    }
    let inter = ta.intersection(&tb).count() as f32;
    let union = ta.union(&tb).count() as f32;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn keyword_jaccard(a: &[String], b: &[String]) -> f32 {
    let sa: HashSet<String> = a.iter().map(|s| s.to_lowercase()).collect();
    let sb: HashSet<String> = b.iter().map(|s| s.to_lowercase()).collect();
    if sa.is_empty() || sb.is_empty() {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count() as f32;
    let union = sa.union(&sb).count() as f32;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn normalize_topic_tokens(text: &str) -> HashSet<String> {
    const STOP: &[&str] = &[
        "you", "the", "and", "for", "with", "that", "this", "from", "your", "about", "into",
        "were", "was", "are", "after", "before", "over", "under", "have", "had",
    ];
    text.split(|c: char| !c.is_alphanumeric())
        .map(|s| s.trim().to_lowercase())
        .filter(|s| s.len() > 2 && !STOP.contains(&s.as_str()))
        .collect()
}

fn fallback_timeline_item(window: &BatchWindow, messages: &[MessageFeature]) -> TimelineNodeInsert {
    let start_rowid = window.start_rowid;
    let end_rowid = window.end_rowid;
    let rep = start_rowid + ((end_rowid - start_rowid) / 2);
    let (start_ts, end_ts) = range_timestamps(messages, start_rowid, end_rowid);
    let (message_count, media_count, reaction_count, reply_count) =
        aggregate_counts(messages, start_rowid, end_rowid);

    let (title, summary) = fallback_l0_text(start_rowid, end_rowid, messages);

    TimelineNodeInsert {
        temp_id: 0,
        chat_id: 0,
        level: 0,
        parent_temp_id: None,
        ordinal: 0,
        start_rowid,
        end_rowid,
        representative_rowid: rep,
        start_ts,
        end_ts,
        title,
        summary,
        keywords: vec!["conversation".to_string()],
        message_count,
        media_count,
        reaction_count,
        reply_count,
        confidence: 0.35,
        ai_rationale: Some("fallback generation".to_string()),
        source_batch_id: None,
        is_draft: true,
    }
}

fn fallback_l0_text(
    start_rowid: i32,
    end_rowid: i32,
    messages: &[MessageFeature],
) -> (String, String) {
    let in_range: Vec<&MessageFeature> = messages
        .iter()
        .filter(|m| m.rowid >= start_rowid && m.rowid <= end_rowid)
        .collect();
    if in_range.is_empty() {
        return (
            "You exchanged messages".to_string(),
            "You sent and received messages in this span.".to_string(),
        );
    }

    let mut snippets = Vec::<String>::new();
    for m in in_range
        .iter()
        .filter(|m| !m.text.trim().is_empty())
        .take(2)
    {
        let who = m
            .sender_name
            .clone()
            .unwrap_or_else(|| "Someone".to_string());
        let snippet = truncate_plain(&m.text, 72);
        snippets.push(format!("{}: \"{}\"", who, snippet));
    }

    let title = if let Some(first) = in_range
        .iter()
        .find_map(|m| (!m.text.trim().is_empty()).then(|| truncate_plain(&m.text, 48)))
    {
        format!("You discussed \"{}\"", first)
    } else {
        "You exchanged messages".to_string()
    };

    let summary = if snippets.is_empty() {
        format!("You exchanged {} messages in this span.", in_range.len())
    } else {
        format!(
            "You discussed concrete details in this span: {}.",
            snippets.join(" | ")
        )
    };

    (title, summary)
}

fn fallback_aggregate_text(
    start_rowid: i32,
    end_rowid: i32,
    child_nodes: &[TimelineNodeInsert],
) -> (String, String) {
    let mut child_titles = child_nodes
        .iter()
        .filter(|n| ranges_overlap(start_rowid, end_rowid, n.start_rowid, n.end_rowid))
        .map(|n| truncate_plain(&n.title, 64))
        .collect::<Vec<_>>();
    child_titles.sort();
    child_titles.dedup();
    child_titles.truncate(3);

    if child_titles.is_empty() {
        return (
            "You covered this period".to_string(),
            "You progressed through this part of the conversation.".to_string(),
        );
    }

    let title = format!("You moved through {}", child_titles[0]);
    let summary = format!(
        "This span combines related moments: {}.",
        child_titles.join(" | ")
    );
    (title, summary)
}

fn low_signal_timeline_text(title: &str, summary: &str) -> bool {
    let t = title.to_lowercase();
    let s = summary.to_lowercase();
    let vague_markers = [
        "next steps",
        "work items",
        "updates",
        "clarified ownership",
        "upcoming",
        "discussion",
        "conversation",
    ];

    if t.trim().len() < 10 || s.trim().len() < 20 {
        return true;
    }

    vague_markers.iter().any(|m| t.contains(m) || s.contains(m))
}

fn truncate_plain(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out = String::new();
    for c in text.chars().take(max) {
        out.push(c);
    }
    out.push_str("...");
    out
}

fn ranges_overlap(a_start: i32, a_end: i32, b_start: i32, b_end: i32) -> bool {
    max(a_start, b_start) <= min(a_end, b_end)
}

fn remove_overlapping_l0(nodes: &mut Vec<TimelineNodeInsert>, start_rowid: i32, end_rowid: i32) {
    nodes.retain(|n| n.level != 0 || n.end_rowid < start_rowid || n.start_rowid > end_rowid);
}

fn append_prev_moment_links(nodes: &[TimelineNodeInsert], links: &mut Vec<TimelineNodeLinkInsert>) {
    let mut l0: Vec<&TimelineNodeInsert> = nodes.iter().filter(|n| n.level == 0).collect();
    l0.sort_by_key(|n| (n.start_rowid, n.end_rowid, n.ordinal));

    for pair in l0.windows(2) {
        if let [a, b] = pair {
            links.push(TimelineNodeLinkInsert {
                source_temp_id: b.temp_id,
                target_temp_id: a.temp_id,
                link_type: "prev_moment".to_string(),
                weight: 0.85,
                rationale: "chronological adjacency".to_string(),
            });
        }
    }
}

fn load_existing_level_nodes_for_resume(
    conn: &Connection,
    chat_id: i32,
    level: u8,
    temp_id_seed: &mut i64,
) -> Result<Vec<TimelineNodeInsert>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT ordinal, start_rowid, end_rowid, representative_rowid,
                    start_ts, end_ts, title, summary, keywords_json,
                    message_count, media_count, reaction_count, reply_count,
                    confidence, ai_rationale, source_batch_id, is_draft
             FROM timeline_nodes
             WHERE chat_id = ?1 AND level = ?2
             ORDER BY start_rowid ASC, ordinal ASC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(rusqlite::params![chat_id, level as i32], |row| {
            Ok((
                row.get::<_, i32>(0)?,
                row.get::<_, i32>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
                row.get::<_, String>(8)?,
                row.get::<_, i32>(9)?,
                row.get::<_, i32>(10)?,
                row.get::<_, i32>(11)?,
                row.get::<_, i32>(12)?,
                row.get::<_, f64>(13)?,
                row.get::<_, Option<String>>(14)?,
                row.get::<_, Option<String>>(15)?,
                row.get::<_, i32>(16)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row in rows.flatten() {
        let temp_id = *temp_id_seed;
        *temp_id_seed += 1;
        out.push(TimelineNodeInsert {
            temp_id,
            chat_id,
            level,
            parent_temp_id: None,
            ordinal: row.0,
            start_rowid: row.1,
            end_rowid: row.2,
            representative_rowid: row.3,
            start_ts: row.4,
            end_ts: row.5,
            title: row.6,
            summary: row.7,
            keywords: serde_json::from_str::<Vec<String>>(&row.8).unwrap_or_default(),
            message_count: row.9,
            media_count: row.10,
            reaction_count: row.11,
            reply_count: row.12,
            confidence: row.13 as f32,
            ai_rationale: row.14,
            source_batch_id: row.15,
            is_draft: row.16 != 0,
        });
    }

    Ok(out)
}

fn range_timestamps(
    messages: &[MessageFeature],
    start_rowid: i32,
    end_rowid: i32,
) -> (String, String) {
    let start = messages
        .iter()
        .find(|m| m.rowid >= start_rowid)
        .map(|m| m.iso_ts.clone())
        .unwrap_or_else(timeline_db::now_iso);
    let end = messages
        .iter()
        .rev()
        .find(|m| m.rowid <= end_rowid)
        .map(|m| m.iso_ts.clone())
        .unwrap_or_else(timeline_db::now_iso);
    (start, end)
}

fn aggregate_counts(
    messages: &[MessageFeature],
    start_rowid: i32,
    end_rowid: i32,
) -> (i32, i32, i32, i32) {
    let mut message_count = 0_i32;
    let mut media_count = 0_i32;

    for msg in messages
        .iter()
        .filter(|m| m.rowid >= start_rowid && m.rowid <= end_rowid)
    {
        message_count += 1;
        media_count += msg.attachments.len() as i32;
    }

    (message_count, media_count, 0, 0)
}

fn resolve_attachment_path(
    source_conn: &Connection,
    source_db_path: &Path,
    attachment_rowid: i32,
) -> Option<String> {
    let attachment = db::get_attachment_by_id(source_conn, attachment_rowid).ok()??;
    let source_db_path_buf = source_db_path.to_path_buf();

    let path = attachment.resolved_attachment_path(&Platform::macOS, &source_db_path_buf, None)?;

    let mime = attachment
        .mime_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    if is_heic(&mime, &path) {
        convert_heic_to_jpeg(&path, attachment_rowid).ok()
    } else {
        Some(path)
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

fn normalize_text(raw: &str) -> String {
    raw.replace('\u{FFFC}', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn resolve_sender_display_name(raw: &str, contact_names: &HashMap<String, String>) -> String {
    if let Some(name) = contact_names.get(raw) {
        return name.clone();
    }

    let normalized_phone = normalize_phone(raw);
    if let Some(name) = contact_names.get(&normalized_phone) {
        return name.clone();
    }

    if raw.contains('@') {
        raw.to_lowercase()
    } else {
        raw.to_string()
    }
}

fn short_name(name: &str) -> String {
    let first = name
        .split_whitespace()
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(name);
    first.chars().take(24).collect()
}

fn normalize_phone(raw: &str) -> String {
    let digits: String = raw.chars().filter(|c| c.is_ascii_digit()).collect();
    match digits.len() {
        10 => format!("+1{}", digits),
        11 if digits.starts_with('1') => format!("+{}", digits),
        _ if !digits.is_empty() => format!("+{}", digits),
        _ => raw.to_string(),
    }
}

fn timeline_window_max_messages() -> usize {
    std::env::var("TIMELINE_WINDOW_MAX_MESSAGES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 20 && *v <= 200)
        .unwrap_or(DEFAULT_WINDOW_MAX_MESSAGES)
}

fn timeline_window_target_chars() -> usize {
    std::env::var("TIMELINE_WINDOW_TARGET_CHARS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 3000 && *v <= 60_000)
        .unwrap_or(DEFAULT_WINDOW_TARGET_CHARS)
}

fn timeline_window_overlap_messages() -> usize {
    std::env::var("TIMELINE_WINDOW_OVERLAP_MESSAGES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1 && *v <= 60)
        .unwrap_or(DEFAULT_WINDOW_OVERLAP_MESSAGES)
}

fn timeline_l0_context_items() -> usize {
    std::env::var("TIMELINE_L0_CONTEXT_ITEMS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 4 && *v <= 64)
        .unwrap_or(DEFAULT_L0_CONTEXT_ITEMS)
}

fn timeline_image_workers() -> usize {
    std::env::var("TIMELINE_IMAGE_WORKERS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1 && *v <= 12)
        .unwrap_or(DEFAULT_IMAGE_WORKERS)
}

fn timeline_image_retries() -> usize {
    std::env::var("TIMELINE_IMAGE_RETRIES")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1 && *v <= 6)
        .unwrap_or(DEFAULT_IMAGE_RETRIES)
}

fn timeline_subtopic_max_moments() -> usize {
    std::env::var("TIMELINE_SUBTOPIC_MAX_MOMENTS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 2 && *v <= 20)
        .unwrap_or(DEFAULT_SUBTOPIC_MAX_MOMENTS)
}

fn timeline_subtopic_min_moments() -> usize {
    std::env::var("TIMELINE_SUBTOPIC_MIN_MOMENTS")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|v| *v >= 1 && *v <= 10)
        .unwrap_or(DEFAULT_SUBTOPIC_MIN_MOMENTS)
        .min(timeline_subtopic_max_moments())
}

fn timeline_subtopic_split_gap_hours() -> i64 {
    std::env::var("TIMELINE_SUBTOPIC_SPLIT_GAP_HOURS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 1 && *v <= 168)
        .unwrap_or(DEFAULT_SUBTOPIC_SPLIT_GAP_HOURS)
}

fn timeline_l0_min_complete_coverage() -> f32 {
    std::env::var("TIMELINE_L0_MIN_COMPLETE_COVERAGE")
        .ok()
        .and_then(|v| v.parse::<f32>().ok())
        .filter(|v| *v >= 0.05 && *v <= 1.0)
        .unwrap_or(0.60)
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    fn make_msg(rowid: i32, chars: usize) -> MessageFeature {
        MessageFeature {
            rowid,
            text: "x".repeat(chars),
            sender_name: Some("Me".to_string()),
            iso_ts: "2026-01-01T00:00:00Z".to_string(),
            attachments: Vec::new(),
        }
    }

    fn make_l0_node(temp_id: i64, start_rowid: i32, end_rowid: i32, start_ts: &str, end_ts: &str) -> TimelineNodeInsert {
        TimelineNodeInsert {
            temp_id,
            chat_id: 1,
            level: 0,
            parent_temp_id: None,
            ordinal: 0,
            start_rowid,
            end_rowid,
            representative_rowid: start_rowid,
            start_ts: start_ts.to_string(),
            end_ts: end_ts.to_string(),
            title: format!("moment-{}", temp_id),
            summary: format!("summary-{}", temp_id),
            keywords: vec!["moment".to_string()],
            message_count: (end_rowid - start_rowid + 1).max(1),
            media_count: 0,
            reaction_count: 0,
            reply_count: 0,
            confidence: 0.8,
            ai_rationale: None,
            source_batch_id: None,
            is_draft: false,
        }
    }

    #[test]
    fn sliding_windows_honor_overlap_and_caps() {
        let messages: Vec<MessageFeature> = (1..=300).map(|i| make_msg(i, 50)).collect();
        let windows = build_sliding_windows(&messages, 120, 4_000, 24);
        assert!(!windows.is_empty());
        for w in &windows {
            assert!(w.end_idx >= w.start_idx);
            assert!(w.end_idx - w.start_idx < 120);
        }
        for pair in windows.windows(2) {
            let a = &pair[0];
            let b = &pair[1];
            assert!(b.start_idx > a.start_idx);
            assert!(b.start_idx <= a.end_idx + 1);
        }
    }

    #[test]
    fn split_subtopics_merges_tiny_edges() {
        let l0 = vec![
            make_l0_node(1, 10, 11, "2026-01-01T09:00:00Z", "2026-01-01T09:05:00Z"),
            make_l0_node(2, 20, 21, "2026-01-02T12:00:00Z", "2026-01-02T12:05:00Z"),
            make_l0_node(3, 22, 23, "2026-01-02T12:10:00Z", "2026-01-02T12:15:00Z"),
        ];
        let by_id: HashMap<i64, &TimelineNodeInsert> = l0.iter().map(|n| (n.temp_id, n)).collect();
        let ids = vec![1_i64, 2_i64, 3_i64];
        let segments = split_into_contiguous_subtopics(&ids, &by_id);
        assert_eq!(segments.len(), 1);
        assert_eq!(segments[0], vec![1_i64, 2_i64, 3_i64]);
    }

    #[test]
    fn assignment_enforces_single_topic_per_moment() {
        let l0 = vec![
            make_l0_node(1, 100, 101, "2026-01-01T09:00:00Z", "2026-01-01T09:02:00Z"),
            make_l0_node(2, 102, 103, "2026-01-01T09:05:00Z", "2026-01-01T09:06:00Z"),
            make_l0_node(3, 110, 111, "2026-01-01T10:00:00Z", "2026-01-01T10:02:00Z"),
        ];
        let messages: Vec<MessageFeature> = (100..=111).map(|r| make_msg(r, 20)).collect();
        let candidates = vec![
            TopicCandidate {
                node: TimelineNodeInsert {
                    temp_id: 1001,
                    chat_id: 1,
                    level: 2,
                    parent_temp_id: None,
                    ordinal: 0,
                    start_rowid: 100,
                    end_rowid: 111,
                    representative_rowid: 100,
                    start_ts: "2026-01-01T09:00:00Z".to_string(),
                    end_ts: "2026-01-01T10:02:00Z".to_string(),
                    title: "topic-a".to_string(),
                    summary: "a".to_string(),
                    keywords: vec!["a".to_string()],
                    message_count: 12,
                    media_count: 0,
                    reaction_count: 0,
                    reply_count: 0,
                    confidence: 0.9,
                    ai_rationale: None,
                    source_batch_id: None,
                    is_draft: false,
                },
                moment_ids: vec![1, 2],
            },
            TopicCandidate {
                node: TimelineNodeInsert {
                    temp_id: 1002,
                    chat_id: 1,
                    level: 2,
                    parent_temp_id: None,
                    ordinal: 1,
                    start_rowid: 100,
                    end_rowid: 111,
                    representative_rowid: 111,
                    start_ts: "2026-01-01T09:00:00Z".to_string(),
                    end_ts: "2026-01-01T10:02:00Z".to_string(),
                    title: "topic-b".to_string(),
                    summary: "b".to_string(),
                    keywords: vec!["b".to_string()],
                    message_count: 12,
                    media_count: 0,
                    reaction_count: 0,
                    reply_count: 0,
                    confidence: 0.7,
                    ai_rationale: None,
                    source_batch_id: None,
                    is_draft: false,
                },
                moment_ids: vec![2, 3],
            },
        ];
        let mut temp_seed = 2000_i64;
        let result = assign_moments_to_single_topic(1, &l0, candidates, &messages, &mut temp_seed);
        assert_eq!(result.moment_to_topic.len(), l0.len());
        let unique: HashSet<i64> = result.moment_to_topic.keys().copied().collect();
        assert_eq!(unique.len(), l0.len());
    }

    #[test]
    fn contiguous_subtopic_memberships_are_single_parent() {
        let l0 = vec![
            make_l0_node(1, 1, 1, "2026-01-01T09:00:00Z", "2026-01-01T09:00:30Z"),
            make_l0_node(2, 2, 2, "2026-01-01T09:01:00Z", "2026-01-01T09:01:30Z"),
            make_l0_node(3, 50, 50, "2026-01-03T11:00:00Z", "2026-01-03T11:00:30Z"),
        ];
        let topic = TimelineNodeInsert {
            temp_id: 100,
            chat_id: 1,
            level: 2,
            parent_temp_id: None,
            ordinal: 0,
            start_rowid: 1,
            end_rowid: 50,
            representative_rowid: 1,
            start_ts: "2026-01-01T09:00:00Z".to_string(),
            end_ts: "2026-01-03T11:00:30Z".to_string(),
            title: "topic".to_string(),
            summary: "summary".to_string(),
            keywords: vec!["topic".to_string()],
            message_count: 3,
            media_count: 0,
            reaction_count: 0,
            reply_count: 0,
            confidence: 0.8,
            ai_rationale: None,
            source_batch_id: None,
            is_draft: false,
        };
        let messages: Vec<MessageFeature> = (1..=50).map(|r| make_msg(r, 5)).collect();
        let mapping = HashMap::from([(1_i64, 100_i64), (2_i64, 100_i64), (3_i64, 100_i64)]);
        let mut temp_seed = 200_i64;
        let out = build_l1_contiguous_subtopics(1, &l0, &mapping, &[topic], &messages, &mut temp_seed);
        let mut moment_parent_count = HashMap::<i64, usize>::new();
        for m in out.memberships {
            if m.child_temp_id <= 3 {
                *moment_parent_count.entry(m.child_temp_id).or_insert(0) += 1;
            }
        }
        assert_eq!(moment_parent_count.get(&1), Some(&1));
        assert_eq!(moment_parent_count.get(&2), Some(&1));
        assert_eq!(moment_parent_count.get(&3), Some(&1));
    }
}
