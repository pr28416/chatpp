use crate::timeline_types::{
    TimelineBatchRecord, TimelineEvidenceInsert, TimelineJobState, TimelineLevelCounts,
    TimelineMediaInsightInsert, TimelineMemoryInsert, TimelineMetaRecord, TimelineNodeInsert,
    TimelineNodeLinkInsert, TimelineNodeList, TimelineNodeMemoryLinkInsert, TimelineNodeResponse,
    TimelineOverview,
};
use chrono::Utc;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::Path;

pub type TimelineResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

pub fn open_rw(path: &Path) -> TimelineResult<Connection> {
    let conn = Connection::open(path)?;
    ensure_schema(&conn)?;
    Ok(conn)
}

pub fn open_ro(path: &Path) -> TimelineResult<Connection> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    Ok(conn)
}

pub fn init_timeline_db(path: &Path) -> TimelineResult<()> {
    let conn = Connection::open(path)?;
    ensure_schema(&conn)?;
    Ok(())
}

pub fn ensure_schema(conn: &Connection) -> TimelineResult<()> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS timeline_meta (
          chat_id INTEGER PRIMARY KEY,
          schema_version INTEGER NOT NULL,
          source_max_rowid INTEGER NOT NULL DEFAULT 0,
          indexed_max_rowid INTEGER NOT NULL DEFAULT 0,
          indexed_at TEXT,
          openai_used INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          prompt_version INTEGER NOT NULL DEFAULT 1,
          index_health TEXT NOT NULL DEFAULT 'stale',
          last_successful_run_at TEXT
        );

        CREATE TABLE IF NOT EXISTS timeline_nodes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          level INTEGER NOT NULL,
          parent_id INTEGER,
          ordinal INTEGER NOT NULL,
          start_rowid INTEGER NOT NULL,
          end_rowid INTEGER NOT NULL,
          representative_rowid INTEGER NOT NULL,
          start_ts TEXT NOT NULL,
          end_ts TEXT NOT NULL,
          title TEXT NOT NULL,
          summary TEXT NOT NULL,
          keywords_json TEXT NOT NULL,
          message_count INTEGER NOT NULL,
          media_count INTEGER NOT NULL,
          reaction_count INTEGER NOT NULL,
          reply_count INTEGER NOT NULL,
          confidence REAL NOT NULL,
          ai_rationale TEXT,
          source_batch_id TEXT,
          is_draft INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_nodes_chat_level_parent
        ON timeline_nodes(chat_id, level, parent_id, ordinal);

        CREATE INDEX IF NOT EXISTS idx_nodes_chat_rowid
        ON timeline_nodes(chat_id, start_rowid, end_rowid);

        CREATE TABLE IF NOT EXISTS timeline_node_evidence (
          node_id INTEGER NOT NULL,
          rowid INTEGER NOT NULL,
          reason TEXT NOT NULL,
          weight REAL NOT NULL,
          PRIMARY KEY (node_id, rowid)
        );

        CREATE TABLE IF NOT EXISTS timeline_media_insights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          chat_id INTEGER NOT NULL,
          message_rowid INTEGER NOT NULL,
          attachment_rowid INTEGER NOT NULL,
          mime_type TEXT NOT NULL,
          caption TEXT NOT NULL,
          model TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_media_unique
        ON timeline_media_insights(chat_id, attachment_rowid);

        CREATE TABLE IF NOT EXISTS timeline_jobs (
          chat_id INTEGER PRIMARY KEY,
          job_id TEXT NOT NULL,
          status TEXT NOT NULL,
          phase TEXT NOT NULL,
          progress REAL NOT NULL,
          processed_messages INTEGER NOT NULL DEFAULT 0,
          total_messages INTEGER NOT NULL DEFAULT 0,
          started_at TEXT,
          updated_at TEXT,
          finished_at TEXT,
          error TEXT,
          degraded INTEGER NOT NULL DEFAULT 0,
          failed_batches INTEGER NOT NULL DEFAULT 0,
          completed_batches INTEGER NOT NULL DEFAULT 0,
          run_id TEXT
        );

        CREATE TABLE IF NOT EXISTS timeline_runs (
          run_id TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          status TEXT NOT NULL,
          prompt_version INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          model_text TEXT NOT NULL,
          model_media TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_runs_chat ON timeline_runs(chat_id, started_at DESC);

        CREATE TABLE IF NOT EXISTS timeline_batches (
          batch_id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          start_rowid INTEGER NOT NULL,
          end_rowid INTEGER NOT NULL,
          status TEXT NOT NULL,
          retry_count INTEGER NOT NULL DEFAULT 0,
          error TEXT,
          completed_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_batches_run ON timeline_batches(run_id, seq);

        CREATE TABLE IF NOT EXISTS timeline_node_links (
          source_node_id INTEGER NOT NULL,
          target_node_id INTEGER NOT NULL,
          link_type TEXT NOT NULL,
          weight REAL NOT NULL,
          rationale TEXT NOT NULL,
          PRIMARY KEY (source_node_id, target_node_id, link_type)
        );
        
        CREATE INDEX IF NOT EXISTS idx_node_links_source_type
        ON timeline_node_links(source_node_id, link_type);

        CREATE TABLE IF NOT EXISTS timeline_memories (
          memory_id TEXT PRIMARY KEY,
          chat_id INTEGER NOT NULL,
          memory_type TEXT NOT NULL,
          summary TEXT NOT NULL,
          confidence REAL NOT NULL,
          first_seen_rowid INTEGER NOT NULL,
          last_seen_rowid INTEGER NOT NULL,
          support_rowids_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_memories_chat ON timeline_memories(chat_id, updated_at DESC);

        CREATE TABLE IF NOT EXISTS timeline_node_memory_links (
          node_id INTEGER NOT NULL,
          memory_id TEXT NOT NULL,
          weight REAL NOT NULL,
          PRIMARY KEY (node_id, memory_id)
        );

        ",
    )?;

    // Backward-compatible migrations for older local DBs.
    let _ = conn.execute(
        "ALTER TABLE timeline_meta ADD COLUMN prompt_version INTEGER NOT NULL DEFAULT 1",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_meta ADD COLUMN index_health TEXT NOT NULL DEFAULT 'stale'",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_meta ADD COLUMN last_successful_run_at TEXT",
        [],
    );

    let _ = conn.execute(
        "ALTER TABLE timeline_nodes ADD COLUMN ai_rationale TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_nodes ADD COLUMN source_batch_id TEXT",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_nodes ADD COLUMN is_draft INTEGER NOT NULL DEFAULT 1",
        [],
    );

    let _ = conn.execute(
        "ALTER TABLE timeline_jobs ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_jobs ADD COLUMN failed_batches INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute(
        "ALTER TABLE timeline_jobs ADD COLUMN completed_batches INTEGER NOT NULL DEFAULT 0",
        [],
    );
    let _ = conn.execute("ALTER TABLE timeline_jobs ADD COLUMN run_id TEXT", []);

    Ok(())
}

pub fn create_run(
    conn: &Connection,
    run_id: &str,
    chat_id: i32,
    prompt_version: i32,
    schema_version: i32,
    model_text: &str,
    model_media: &str,
) -> TimelineResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO timeline_runs (
            run_id, chat_id, status, prompt_version, schema_version,
            model_text, model_media, started_at, finished_at
         ) VALUES (?1, ?2, 'running', ?3, ?4, ?5, ?6, ?7, NULL)",
        rusqlite::params![
            run_id,
            chat_id,
            prompt_version,
            schema_version,
            model_text,
            model_media,
            now_iso()
        ],
    )?;
    Ok(())
}

pub fn finish_run(conn: &Connection, run_id: &str, status: &str) -> TimelineResult<()> {
    conn.execute(
        "UPDATE timeline_runs SET status = ?2, finished_at = ?3 WHERE run_id = ?1",
        rusqlite::params![run_id, status, now_iso()],
    )?;
    Ok(())
}

pub fn upsert_batch(conn: &Connection, batch: &TimelineBatchRecord) -> TimelineResult<()> {
    conn.execute(
        "INSERT INTO timeline_batches (
            batch_id, run_id, seq, start_rowid, end_rowid,
            status, retry_count, error, completed_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT(batch_id) DO UPDATE SET
            status = excluded.status,
            retry_count = excluded.retry_count,
            error = excluded.error,
            completed_at = excluded.completed_at",
        rusqlite::params![
            batch.batch_id,
            batch.run_id,
            batch.seq,
            batch.start_rowid,
            batch.end_rowid,
            batch.status,
            batch.retry_count,
            batch.error,
            batch.completed_at,
        ],
    )?;
    Ok(())
}

pub fn latest_failed_batches(
    conn: &Connection,
    chat_id: i32,
) -> TimelineResult<Vec<(i32, i32, i32)>> {
    let run_id: Option<String> = conn
        .query_row(
            "SELECT run_id FROM timeline_runs WHERE chat_id = ?1 ORDER BY started_at DESC LIMIT 1",
            [chat_id],
            |row| row.get(0),
        )
        .ok();

    let Some(run_id) = run_id else {
        return Ok(Vec::new());
    };

    let mut stmt = conn.prepare(
        "SELECT seq, start_rowid, end_rowid
         FROM timeline_batches
         WHERE run_id = ?1 AND status = 'failed'
         ORDER BY seq ASC",
    )?;

    let rows = stmt.query_map([run_id], |row| {
        Ok((
            row.get::<_, i32>(0)?,
            row.get::<_, i32>(1)?,
            row.get::<_, i32>(2)?,
        ))
    })?;

    Ok(rows.flatten().collect())
}

pub fn get_meta(conn: &Connection, chat_id: i32) -> TimelineResult<Option<TimelineMetaRecord>> {
    let mut stmt = conn.prepare(
        "SELECT chat_id, schema_version, source_max_rowid, indexed_max_rowid, indexed_at,
                openai_used, last_error, prompt_version, index_health, last_successful_run_at
         FROM timeline_meta
         WHERE chat_id = ?1",
    )?;

    let mut rows = stmt.query([chat_id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };

    Ok(Some(TimelineMetaRecord {
        chat_id: row.get(0)?,
        schema_version: row.get(1)?,
        source_max_rowid: row.get(2)?,
        indexed_max_rowid: row.get(3)?,
        indexed_at: row.get(4)?,
        openai_used: row.get::<_, i32>(5)? != 0,
        last_error: row.get(6)?,
        prompt_version: row.get(7)?,
        index_health: row.get(8)?,
        last_successful_run_at: row.get(9)?,
    }))
}

pub fn upsert_meta(conn: &Connection, meta: &TimelineMetaRecord) -> TimelineResult<()> {
    conn.execute(
        "INSERT INTO timeline_meta (
            chat_id, schema_version, source_max_rowid, indexed_max_rowid, indexed_at,
            openai_used, last_error, prompt_version, index_health, last_successful_run_at
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(chat_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            source_max_rowid = excluded.source_max_rowid,
            indexed_max_rowid = excluded.indexed_max_rowid,
            indexed_at = excluded.indexed_at,
            openai_used = excluded.openai_used,
            last_error = excluded.last_error,
            prompt_version = excluded.prompt_version,
            index_health = excluded.index_health,
            last_successful_run_at = excluded.last_successful_run_at",
        rusqlite::params![
            meta.chat_id,
            meta.schema_version,
            meta.source_max_rowid,
            meta.indexed_max_rowid,
            meta.indexed_at,
            if meta.openai_used { 1 } else { 0 },
            meta.last_error,
            meta.prompt_version,
            meta.index_health,
            meta.last_successful_run_at,
        ],
    )?;

    Ok(())
}

pub fn set_job_state(
    conn: &Connection,
    state: &TimelineJobState,
    job_id: &str,
) -> TimelineResult<()> {
    conn.execute(
        "INSERT INTO timeline_jobs (
            chat_id, job_id, status, phase, progress, processed_messages, total_messages,
            started_at, updated_at, finished_at, error, degraded, failed_batches, completed_batches, run_id
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(chat_id) DO UPDATE SET
            job_id = excluded.job_id,
            status = excluded.status,
            phase = excluded.phase,
            progress = excluded.progress,
            processed_messages = excluded.processed_messages,
            total_messages = excluded.total_messages,
            started_at = excluded.started_at,
            updated_at = excluded.updated_at,
            finished_at = excluded.finished_at,
            error = excluded.error,
            degraded = excluded.degraded,
            failed_batches = excluded.failed_batches,
            completed_batches = excluded.completed_batches,
            run_id = excluded.run_id",
        rusqlite::params![
            state.chat_id,
            job_id,
            state.status,
            state.phase,
            state.progress,
            state.processed_messages,
            state.total_messages,
            state.started_at,
            state.updated_at,
            state.finished_at,
            state.error,
            if state.degraded { 1 } else { 0 },
            state.failed_batches,
            state.completed_batches,
            state.run_id,
        ],
    )?;

    Ok(())
}

pub fn get_job_state(conn: &Connection, chat_id: i32) -> TimelineResult<TimelineJobState> {
    let mut stmt = conn.prepare(
        "SELECT status, phase, progress, processed_messages, total_messages,
                started_at, updated_at, finished_at, error,
                degraded, failed_batches, completed_batches, run_id
         FROM timeline_jobs
         WHERE chat_id = ?1",
    )?;

    let mut rows = stmt.query([chat_id])?;
    let Some(row) = rows.next()? else {
        return Ok(TimelineJobState::idle(chat_id));
    };

    let meta = get_meta(conn, chat_id)?;

    Ok(TimelineJobState {
        chat_id,
        status: row.get(0)?,
        phase: row.get(1)?,
        progress: row.get(2)?,
        processed_messages: row.get(3)?,
        total_messages: row.get(4)?,
        started_at: row.get(5)?,
        updated_at: row.get(6)?,
        finished_at: row.get(7)?,
        error: row.get(8)?,
        degraded: row.get::<_, i32>(9)? != 0,
        failed_batches: row.get(10)?,
        completed_batches: row.get(11)?,
        run_id: row.get(12)?,
        openai_used: meta.map(|m| m.openai_used).unwrap_or(false),
    })
}

pub fn get_nodes(
    conn: &Connection,
    chat_id: i32,
    level: u8,
    parent_id: Option<i64>,
) -> TimelineResult<TimelineNodeList> {
    let sql = if parent_id.is_some() {
        "SELECT id, chat_id, level, parent_id, ordinal, start_rowid, end_rowid, representative_rowid,
                start_ts, end_ts, title, summary, keywords_json, message_count, media_count,
                reaction_count, reply_count, confidence, ai_rationale, source_batch_id, is_draft
         FROM timeline_nodes
         WHERE chat_id = ?1 AND level = ?2 AND parent_id = ?3
         ORDER BY ordinal ASC, start_rowid ASC, id ASC"
    } else {
        "SELECT id, chat_id, level, parent_id, ordinal, start_rowid, end_rowid, representative_rowid,
                start_ts, end_ts, title, summary, keywords_json, message_count, media_count,
                reaction_count, reply_count, confidence, ai_rationale, source_batch_id, is_draft
         FROM timeline_nodes
         WHERE chat_id = ?1 AND level = ?2
         ORDER BY ordinal ASC, start_rowid ASC, id ASC"
    };

    let mut stmt = conn.prepare(sql)?;

    let mut rows = if let Some(parent) = parent_id {
        stmt.query(rusqlite::params![chat_id, level as i32, parent])?
    } else {
        stmt.query(rusqlite::params![chat_id, level as i32])?
    };

    let mut nodes = Vec::new();
    while let Some(row) = rows.next()? {
        let keywords_json: String = row.get(12)?;
        let keywords = serde_json::from_str::<Vec<String>>(&keywords_json).unwrap_or_default();
        nodes.push(TimelineNodeResponse {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            level: row.get::<_, i32>(2)? as u8,
            parent_id: row.get(3)?,
            ordinal: row.get(4)?,
            start_rowid: row.get(5)?,
            end_rowid: row.get(6)?,
            representative_rowid: row.get(7)?,
            start_ts: row.get(8)?,
            end_ts: row.get(9)?,
            title: row.get(10)?,
            summary: row.get(11)?,
            keywords,
            message_count: row.get(13)?,
            media_count: row.get(14)?,
            reaction_count: row.get(15)?,
            reply_count: row.get(16)?,
            confidence: row.get::<_, f64>(17)? as f32,
            ai_rationale: row.get(18)?,
            source_batch_id: row.get(19)?,
            is_draft: row.get::<_, i32>(20)? != 0,
        });
    }

    Ok(TimelineNodeList { nodes })
}

pub fn get_related_nodes(
    conn: &Connection,
    node_id: i64,
    limit: i32,
) -> TimelineResult<TimelineNodeList> {
    let mut stmt = conn.prepare(
        "SELECT n.id, n.chat_id, n.level, n.parent_id, n.ordinal, n.start_rowid, n.end_rowid,
                n.representative_rowid, n.start_ts, n.end_ts, n.title, n.summary, n.keywords_json,
                n.message_count, n.media_count, n.reaction_count, n.reply_count, n.confidence,
                n.ai_rationale, n.source_batch_id, n.is_draft
         FROM timeline_node_links l
         JOIN timeline_nodes n ON n.id = l.target_node_id
         WHERE l.source_node_id = ?1
           AND l.link_type <> 'prev_moment'
         ORDER BY l.weight DESC
         LIMIT ?2",
    )?;

    let mut rows = stmt.query(rusqlite::params![node_id, limit])?;
    let mut nodes = Vec::new();
    while let Some(row) = rows.next()? {
        let keywords_json: String = row.get(12)?;
        let keywords = serde_json::from_str::<Vec<String>>(&keywords_json).unwrap_or_default();
        nodes.push(TimelineNodeResponse {
            id: row.get(0)?,
            chat_id: row.get(1)?,
            level: row.get::<_, i32>(2)? as u8,
            parent_id: row.get(3)?,
            ordinal: row.get(4)?,
            start_rowid: row.get(5)?,
            end_rowid: row.get(6)?,
            representative_rowid: row.get(7)?,
            start_ts: row.get(8)?,
            end_ts: row.get(9)?,
            title: row.get(10)?,
            summary: row.get(11)?,
            keywords,
            message_count: row.get(13)?,
            media_count: row.get(14)?,
            reaction_count: row.get(15)?,
            reply_count: row.get(16)?,
            confidence: row.get::<_, f64>(17)? as f32,
            ai_rationale: row.get(18)?,
            source_batch_id: row.get(19)?,
            is_draft: row.get::<_, i32>(20)? != 0,
        });
    }

    Ok(TimelineNodeList { nodes })
}

pub fn get_overview(conn: &Connection, chat_id: i32) -> TimelineResult<TimelineOverview> {
    let mut overview = TimelineOverview {
        chat_id,
        ..TimelineOverview::default()
    };

    if let Some(meta) = get_meta(conn, chat_id)? {
        overview.indexed = meta.indexed_max_rowid > 0;
        overview.indexed_max_rowid = meta.indexed_max_rowid;
        overview.index_health = meta.index_health;
        overview.last_successful_run_at = meta.last_successful_run_at;
    }

    let mut counts = TimelineLevelCounts::default();
    {
        let mut stmt = conn.prepare(
            "SELECT level, COUNT(*)
             FROM timeline_nodes
             WHERE chat_id = ?1
             GROUP BY level",
        )?;
        let rows = stmt.query_map([chat_id], |row| {
            Ok((row.get::<_, i32>(0)?, row.get::<_, i32>(1)?))
        })?;

        for row in rows.flatten() {
            match row.0 {
                0 => counts.level_0 = row.1,
                1 => counts.level_1 = row.1,
                2 => counts.level_2 = row.1,
                3 => counts.level_3 = row.1,
                _ => {}
            }
        }
    }
    overview.level_counts = counts;

    {
        let mut stmt = conn.prepare(
            "SELECT MIN(start_ts), MAX(end_ts)
             FROM timeline_nodes
             WHERE chat_id = ?1",
        )?;
        let mut rows = stmt.query([chat_id])?;
        if let Some(row) = rows.next()? {
            overview.earliest_ts = row.get(0)?;
            overview.latest_ts = row.get(1)?;
        }
    }

    let media_total: i32 = conn
        .query_row(
            "SELECT COUNT(*) FROM timeline_media_insights WHERE chat_id = ?1",
            [chat_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    let media_candidates: i32 = conn
        .query_row(
            "SELECT COALESCE(SUM(media_count), 0) FROM timeline_nodes WHERE chat_id = ?1 AND level = 2",
            [chat_id],
            |row| row.get(0),
        )
        .unwrap_or(0);

    overview.media_caption_coverage = if media_candidates > 0 {
        (media_total as f32 / media_candidates as f32).clamp(0.0, 1.0)
    } else {
        0.0
    };

    Ok(overview)
}

pub fn replace_chat_timeline(
    conn: &mut Connection,
    chat_id: i32,
    nodes: &[TimelineNodeInsert],
    evidence: &[TimelineEvidenceInsert],
    links: &[TimelineNodeLinkInsert],
    media: &[TimelineMediaInsightInsert],
    memories: &[TimelineMemoryInsert],
    memory_links: &[TimelineNodeMemoryLinkInsert],
) -> TimelineResult<()> {
    let tx = conn.transaction()?;

    tx.execute(
        "DELETE FROM timeline_node_memory_links
         WHERE node_id IN (SELECT id FROM timeline_nodes WHERE chat_id = ?1)",
        [chat_id],
    )?;
    tx.execute(
        "DELETE FROM timeline_node_links
         WHERE source_node_id IN (SELECT id FROM timeline_nodes WHERE chat_id = ?1)
            OR target_node_id IN (SELECT id FROM timeline_nodes WHERE chat_id = ?1)",
        [chat_id],
    )?;
    tx.execute(
        "DELETE FROM timeline_node_evidence
         WHERE node_id IN (SELECT id FROM timeline_nodes WHERE chat_id = ?1)",
        [chat_id],
    )?;
    tx.execute("DELETE FROM timeline_nodes WHERE chat_id = ?1", [chat_id])?;
    tx.execute(
        "DELETE FROM timeline_media_insights WHERE chat_id = ?1",
        [chat_id],
    )?;
    tx.execute(
        "DELETE FROM timeline_memories WHERE chat_id = ?1",
        [chat_id],
    )?;

    let mut id_map: HashMap<i64, i64> = HashMap::new();
    let mut pending_parent_updates: Vec<(i64, i64)> = Vec::new();

    // Pass 1: insert all nodes first so parent resolution does not depend on insertion order.
    for node in nodes {
        let keywords_json = serde_json::to_string(&node.keywords)?;
        tx.execute(
            "INSERT INTO timeline_nodes (
                chat_id, level, parent_id, ordinal, start_rowid, end_rowid, representative_rowid,
                start_ts, end_ts, title, summary, keywords_json,
                message_count, media_count, reaction_count, reply_count, confidence,
                ai_rationale, source_batch_id, is_draft,
                created_at, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                       ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)",
            rusqlite::params![
                node.chat_id,
                node.level as i32,
                Option::<i64>::None,
                node.ordinal,
                node.start_rowid,
                node.end_rowid,
                node.representative_rowid,
                node.start_ts,
                node.end_ts,
                node.title,
                node.summary,
                keywords_json,
                node.message_count,
                node.media_count,
                node.reaction_count,
                node.reply_count,
                node.confidence,
                node.ai_rationale,
                node.source_batch_id,
                if node.is_draft { 1 } else { 0 },
                now_iso(),
                now_iso(),
            ],
        )?;
        let inserted_id = tx.last_insert_rowid();
        id_map.insert(node.temp_id, inserted_id);
        if let Some(parent_temp_id) = node.parent_temp_id {
            pending_parent_updates.push((node.temp_id, parent_temp_id));
        }
    }

    // Pass 2: resolve and write parent ids now that every node has a persisted row id.
    for (child_temp_id, parent_temp_id) in pending_parent_updates {
        let Some(child_id) = id_map.get(&child_temp_id).copied() else {
            continue;
        };
        let parent_id = id_map.get(&parent_temp_id).copied();
        tx.execute(
            "UPDATE timeline_nodes SET parent_id = ?2, updated_at = ?3 WHERE id = ?1",
            rusqlite::params![child_id, parent_id, now_iso()],
        )?;
    }

    for ev in evidence {
        if let Some(node_id) = id_map.get(&ev.node_temp_id) {
            tx.execute(
                "INSERT OR REPLACE INTO timeline_node_evidence (node_id, rowid, reason, weight)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![node_id, ev.rowid, ev.reason, ev.weight],
            )?;
        }
    }

    for link in links {
        if let (Some(source_id), Some(target_id)) = (
            id_map.get(&link.source_temp_id),
            id_map.get(&link.target_temp_id),
        ) {
            tx.execute(
                "INSERT OR REPLACE INTO timeline_node_links (source_node_id, target_node_id, link_type, weight, rationale)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                rusqlite::params![source_id, target_id, link.link_type, link.weight, link.rationale],
            )?;
        }
    }

    for insight in media {
        tx.execute(
            "INSERT OR REPLACE INTO timeline_media_insights (
                chat_id, message_rowid, attachment_rowid, mime_type, caption, model, created_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                insight.chat_id,
                insight.message_rowid,
                insight.attachment_rowid,
                insight.mime_type,
                insight.caption,
                insight.model,
                insight.created_at,
            ],
        )?;
    }

    for memory in memories {
        tx.execute(
            "INSERT OR REPLACE INTO timeline_memories (
                memory_id, chat_id, memory_type, summary, confidence,
                first_seen_rowid, last_seen_rowid, support_rowids_json, updated_at
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                memory.memory_id,
                memory.chat_id,
                memory.memory_type,
                memory.summary,
                memory.confidence,
                memory.first_seen_rowid,
                memory.last_seen_rowid,
                serde_json::to_string(&memory.support_rowids)?,
                memory.updated_at,
            ],
        )?;
    }

    for link in memory_links {
        if let Some(node_id) = id_map.get(&link.node_temp_id) {
            tx.execute(
                "INSERT OR REPLACE INTO timeline_node_memory_links (node_id, memory_id, weight)
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![node_id, link.memory_id, link.weight],
            )?;
        }
    }

    tx.commit()?;
    Ok(())
}
