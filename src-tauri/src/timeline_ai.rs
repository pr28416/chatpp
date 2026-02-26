use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::time::{Duration, Instant};

const DEFAULT_OPENAI_MODEL: &str = "gpt-5-nano";
const DEFAULT_TIMEOUT_SECS: u64 = 45;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_TEXT_MAX_OUTPUT_TOKENS: i64 = 8000;

#[derive(Clone, Debug, Serialize)]
pub struct AiParticipant {
    pub full_name_or_handle: String,
    pub short_name: String,
    pub is_me: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiSpan {
    pub start_ts: String,
    pub end_ts: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiMessageInput {
    pub rowid: i32,
    pub timestamp: String,
    pub sender_role: String,
    pub sender_name: Option<String>,
    pub text: String,
    pub reaction_count: i32,
    pub reply_to_guid: Option<String>,
    pub media_markers: Vec<String>,
    pub media_descriptions: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiMemoryInput {
    pub memory_id: String,
    pub memory_type: String,
    pub summary: String,
    pub confidence: f32,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiBatchContext {
    pub chat_id: i32,
    pub batch_id: String,
    pub chat_title: String,
    pub participants: Vec<AiParticipant>,
    pub conversation_span: AiSpan,
    pub window_span: AiSpan,
    pub tier1_local_messages: Vec<AiMessageInput>,
    pub tier2_recent_context: Vec<String>,
    pub tier3_long_term_memories: Vec<AiMemoryInput>,
    pub prompt_version: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiNodeOutput {
    pub level: u8,
    pub start_rowid: i32,
    pub end_rowid: i32,
    #[serde(default)]
    pub representative_rowid: i32,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default)]
    pub ai_rationale: Option<String>,
    #[serde(default)]
    pub grouping_mode: Option<String>,
    #[serde(default)]
    pub context_influence: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiRelatedOutput {
    pub source_start_rowid: i32,
    pub source_end_rowid: i32,
    pub target_start_rowid: i32,
    pub target_end_rowid: i32,
    pub link_type: String,
    #[serde(default = "default_link_weight")]
    pub weight: f32,
    #[serde(default)]
    pub rationale: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiMemoryOutput {
    pub memory_type: String,
    pub summary: String,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    pub first_seen_rowid: i32,
    pub last_seen_rowid: i32,
    #[serde(default)]
    pub support_rowids: Vec<i32>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiBatchOutput {
    #[serde(default)]
    pub nodes: Vec<AiNodeOutput>,
    #[serde(default)]
    pub related: Vec<AiRelatedOutput>,
    #[serde(default)]
    pub memories: Vec<AiMemoryOutput>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiMergeInputNode {
    pub batch_id: String,
    pub level: u8,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub title: String,
    pub summary: String,
    pub keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiMergeContext {
    pub chat_id: i32,
    pub prompt_version: i32,
    pub nodes: Vec<AiMergeInputNode>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiMergeOutput {
    #[serde(default)]
    pub nodes: Vec<AiNodeOutput>,
    #[serde(default)]
    pub related: Vec<AiRelatedOutput>,
}

pub fn is_openai_enabled() -> bool {
    std::env::var("OPENAI_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
}

pub fn openai_model_default() -> String {
    std::env::var("OPENAI_MODEL")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string())
}

pub fn openai_model_text() -> String {
    std::env::var("OPENAI_MODEL_TIMELINE_TEXT")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(openai_model_default)
}

pub fn openai_model_media() -> String {
    std::env::var("OPENAI_MODEL_TIMELINE_MEDIA")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(openai_model_default)
}

fn node_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "level": {"type": "integer"},
            "start_rowid": {"type": "integer"},
            "end_rowid": {"type": "integer"},
            "representative_rowid": {"type": "integer"},
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "keywords": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
            "ai_rationale": {"type": "string"},
            "grouping_mode": {"type": "string"},
            "context_influence": {"type": "string"}
        },
        "required": ["level", "start_rowid", "end_rowid", "representative_rowid",
                      "title", "summary", "keywords", "confidence",
                      "ai_rationale", "grouping_mode", "context_influence"],
        "additionalProperties": false
    })
}

fn related_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "source_start_rowid": {"type": "integer"},
            "source_end_rowid": {"type": "integer"},
            "target_start_rowid": {"type": "integer"},
            "target_end_rowid": {"type": "integer"},
            "link_type": {"type": "string"},
            "weight": {"type": "number"},
            "rationale": {"type": "string"}
        },
        "required": ["source_start_rowid", "source_end_rowid",
                      "target_start_rowid", "target_end_rowid",
                      "link_type", "weight", "rationale"],
        "additionalProperties": false
    })
}

fn memory_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "memory_type": {"type": "string"},
            "summary": {"type": "string"},
            "confidence": {"type": "number"},
            "first_seen_rowid": {"type": "integer"},
            "last_seen_rowid": {"type": "integer"},
            "support_rowids": {"type": "array", "items": {"type": "integer"}}
        },
        "required": ["memory_type", "summary", "confidence",
                      "first_seen_rowid", "last_seen_rowid", "support_rowids"],
        "additionalProperties": false
    })
}

fn batch_output_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "nodes": {"type": "array", "items": node_schema()},
            "related": {"type": "array", "items": related_schema()},
            "memories": {"type": "array", "items": memory_schema()}
        },
        "required": ["nodes", "related", "memories"],
        "additionalProperties": false
    })
}

fn hierarchy_output_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "nodes": {"type": "array", "items": node_schema()},
            "related": {"type": "array", "items": related_schema()}
        },
        "required": ["nodes", "related"],
        "additionalProperties": false
    })
}

const L3_MOMENTS_PROMPT: &str = "\
You are summarizing a batch of chat messages into timeline moments.

Return JSON matching the provided schema. Emit 3-12 moments depending on density.

Write titles and summaries as if explaining to a friend what happened in the conversation. \
Be specific about WHO did WHAT and WHY. Never be vague or formulaic.

GOOD title: \"Santiago pitches bank philanthropy angle\"
GOOD summary: \"Santiago suggested targeting banks' philanthropy divisions as potential customers, \
arguing they already have budgets for social impact. I pushed back, leaning toward direct-to-consumer. \
We agreed to research both angles before next week.\"

BAD title: \"Banks care focus\"
BAD summary: \"In +14077178849, Santiago Calderon discuss banks and care with concrete exchanges. \
Notable messages include: Good question, I think long term either. \
The span captures decisions, clarifications, and actionable follow-ups tied to this thread.\"

Rules:
- Every node must have level=3.
- Rowid ranges must be contiguous and chronological, covering the batch with minimal gaps.
- representative_rowid must be within [start_rowid, end_rowid].
- Never quote raw messages verbatim. Never use template phrases like \"notable messages include\", \
\"the span captures\", \"concrete exchanges\", \"actionable follow-ups\", or \"tied to this thread\". \
Write naturally.
- Use participant names from context. On first mention use full name, then short name.
- ai_rationale should be a brief (<=20 word) explanation of why you grouped these messages.
- grouping_mode must be SEQUENTIAL or GRAPH_HEAVY.
- context_influence must be none, recent, or long_term.
- related links are optional; only include them for strong cross-cutting relationships.";

const HIERARCHY_PROMPT: &str = "\
You are building a hierarchy (levels 0-2) from level-3 moments.

L2 (Subtopics): Group 2-5 related moments. 3-5 sentence summary covering what happened and what changed.
L1 (Topics): Group subtopics over longer spans. 3-6 sentence summary with key decisions and turning points.
L0 (Eras): Group topics into broad eras. 4-6 sentence summary covering themes and evolution.

Write like you are telling someone the story of this conversation. Use participant names. \
Be specific about outcomes, not just topics.

GOOD L1 title: \"Debating the go-to-market strategy\"
GOOD L1 summary: \"Santiago and I spent two weeks going back and forth on whether to target banks \
or consumers first. He made a strong case for bank philanthropy divisions having existing budgets. \
I was skeptical but came around after he shared the Wells Fargo case study. We settled on a dual \
approach: banks as the initial pilot, consumers for the waitlist.\"

BAD L1 title: \"Clarify Logistics and Next Steps\"
BAD L1 summary: \"Santiago Calderon and Me confirm logistics-related decisions for the thread. \
They articulate concrete actions, assign owners, and set follow-up milestones to maintain momentum.\"

Rules:
- Emit levels 2, 1, and 0 only.
- L2 ranges should cover moment sequences contiguously. L1 groups L2. L0 groups L1.
- Split L0 into multiple eras when the timeline span justifies it.
- representative_rowid must be within [start_rowid, end_rowid].
- Never use vague or formulaic language. Write naturally.
- Use participant names from the input context.
- related links may use related_topic, reply_bridge, entity_bridge, or topic_recurrence.";

pub fn generate_l3_moments(context: &AiBatchContext) -> Result<AiBatchOutput, String> {
    let input_json = serde_json::to_string(context).map_err(|e| e.to_string())?;
    eprintln!(
        "[timeline-ai] l3 request chat={} batch_id={} messages={} recent_ctx={} memories={} bytes={}",
        context.chat_id,
        context.batch_id,
        context.tier1_local_messages.len(),
        context.tier2_recent_context.len(),
        context.tier3_long_term_memories.len(),
        input_json.len()
    );
    let schema = batch_output_schema();
    let raw = run_responses_call(
        &openai_model_text(),
        L3_MOMENTS_PROMPT,
        &input_json,
        "batch_output",
        &schema,
    )?;
    let mut parsed = parse_json_payload::<AiBatchOutput>(&raw)?;
    parsed.nodes.retain(|n| n.level == 3);
    for n in &mut parsed.nodes {
        sanitize_node(n);
    }
    parsed.related.retain(|r| {
        r.source_start_rowid > 0
            && r.source_end_rowid > 0
            && r.target_start_rowid > 0
            && r.target_end_rowid > 0
    });
    parsed.memories.retain(|m| {
        !m.summary.trim().is_empty() && m.first_seen_rowid > 0 && m.last_seen_rowid > 0
    });
    eprintln!(
        "[timeline-ai] l3 parsed chat={} batch_id={} nodes={} related={} memories={}",
        context.chat_id,
        context.batch_id,
        parsed.nodes.len(),
        parsed.related.len(),
        parsed.memories.len()
    );
    Ok(parsed)
}

pub fn generate_hierarchy(context: &AiMergeContext) -> Result<AiMergeOutput, String> {
    let input_json = serde_json::to_string(context).map_err(|e| e.to_string())?;
    eprintln!(
        "[timeline-ai] hierarchy request chat={} moments={} bytes={}",
        context.chat_id,
        context.nodes.len(),
        input_json.len()
    );
    let schema = hierarchy_output_schema();
    let raw = run_responses_call(
        &openai_model_text(),
        HIERARCHY_PROMPT,
        &input_json,
        "hierarchy_output",
        &schema,
    )?;
    let mut parsed = parse_json_payload::<AiMergeOutput>(&raw)?;
    parsed.nodes.retain(|n| (0..=2).contains(&n.level));
    for n in &mut parsed.nodes {
        sanitize_node(n);
    }
    parsed.related.retain(|r| {
        r.source_start_rowid > 0
            && r.source_end_rowid > 0
            && r.target_start_rowid > 0
            && r.target_end_rowid > 0
    });
    if parsed.nodes.is_empty() {
        return Err("Hierarchy output had zero usable nodes".to_string());
    }
    if parsed.nodes.iter().all(|n| n.level != 2) {
        return Err("Hierarchy output missing level 2 nodes".to_string());
    }
    eprintln!(
        "[timeline-ai] hierarchy parsed chat={} nodes={} related={}",
        context.chat_id,
        parsed.nodes.len(),
        parsed.related.len()
    );
    Ok(parsed)
}

fn default_confidence() -> f32 {
    0.55
}

fn default_link_weight() -> f32 {
    0.5
}

pub fn sanitize_node(node: &mut AiNodeOutput) {
    if node.end_rowid < node.start_rowid {
        std::mem::swap(&mut node.start_rowid, &mut node.end_rowid);
    }
    if node.representative_rowid < node.start_rowid || node.representative_rowid > node.end_rowid {
        node.representative_rowid = node.start_rowid + ((node.end_rowid - node.start_rowid) / 2);
    }
    node.confidence = node.confidence.clamp(0.05, 1.0);
    if node.keywords.len() > 12 {
        node.keywords.truncate(12);
    }
}

pub fn is_retryable_ai_error(err: &str) -> bool {
    let normalized = err.to_lowercase();
    if normalized.contains("hierarchy output had zero usable nodes")
        || normalized.contains("hierarchy output missing level 2 nodes")
    {
        return false;
    }
    let retryable_terms = [
        "openai request failed",
        "error sending request",
        "timeout",
        "timed out",
        "openai api error 429",
        "openai api error 500",
        "openai api error 502",
        "openai api error 503",
        "openai api error 504",
        "max_output_tokens",
        "incomplete_details",
        "failed to parse ai json output",
        "did not contain usable text",
        "failed to decode openai response",
    ];
    retryable_terms.iter().any(|p| normalized.contains(p))
}

pub fn caption_image_file(path: &str, mime_type: &str) -> Result<(String, String), String> {
    describe_image_for_timeline(path, mime_type)
}

pub fn describe_image_for_timeline(
    path: &str,
    mime_type: &str,
) -> Result<(String, String), String> {
    let started = Instant::now();
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY is not set; skipping media captioning".to_string())?;

    let bytes = fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
    if bytes.is_empty() {
        return Err("Image file is empty".to_string());
    }
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Image too large for V1 captioning ({} bytes)",
            bytes.len()
        ));
    }

    let model = openai_model_media();
    let image_b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    let body = serde_json::json!({
      "model": model,
      "input": [
        {
          "role": "user",
          "content": [
            {
              "type": "input_text",
              "text": "Describe this image for timeline indexing in 2-4 concise sentences. Include people/objects/actions/setting and any visible text."
            },
            {
              "type": "input_image",
              "image_url": format!("data:{};base64,{}", mime_type, image_b64)
            }
          ]
        }
      ],
      "max_output_tokens": 220
    });

    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("OpenAI request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .unwrap_or_else(|_| "<failed to read error body>".to_string());
        return Err(format!("OpenAI API error {}: {}", status, body));
    }

    let payload: Value = response
        .json()
        .map_err(|e| format!("Failed to decode OpenAI response: {}", e))?;

    let text = extract_output_text(&payload)
        .ok_or_else(|| "OpenAI response did not contain usable text".to_string())?;

    eprintln!(
        "[timeline-ai] image describe ok path={} mime={} model={} elapsed_ms={}",
        path,
        mime_type,
        model,
        started.elapsed().as_millis()
    );
    Ok((text, model))
}

fn run_responses_call(
    model: &str,
    instruction: &str,
    input_json: &str,
    schema_name: &str,
    schema: &Value,
) -> Result<String, String> {
    let started = Instant::now();
    if std::env::var("TIMELINE_AI_MOCK")
        .ok()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        let mock = mock_response_json(instruction, input_json);
        eprintln!(
            "[timeline-ai] mock response model={} prompt_chars={} input_chars={} output_chars={}",
            model,
            instruction.len(),
            input_json.len(),
            mock.len()
        );
        return Ok(mock);
    }
    let api_key = std::env::var("OPENAI_API_KEY")
        .map_err(|_| "OPENAI_API_KEY is not set; cannot run AI timeline indexing".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

    let max_output_tokens = timeline_text_max_output_tokens();
    eprintln!(
        "[timeline-ai] responses request model={} schema={} prompt_chars={} input_chars={} max_output_tokens={}",
        model,
        schema_name,
        instruction.len(),
        input_json.len(),
        max_output_tokens
    );
    let body = serde_json::json!({
      "model": model,
      "input": [
        {
          "role": "system",
          "content": [{"type":"input_text", "text": instruction}]
        },
        {
          "role": "user",
          "content": [{"type":"input_text", "text": input_json}]
        }
      ],
      "text": {
        "format": {
          "type": "json_schema",
          "name": schema_name,
          "strict": true,
          "schema": schema
        }
      },
      "reasoning": {
        "effort": "low"
      },
      "max_output_tokens": max_output_tokens
    });

    let response = client
        .post("https://api.openai.com/v1/responses")
        .bearer_auth(api_key)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .map_err(|e| format!("OpenAI request failed: {}", e))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response
            .text()
            .unwrap_or_else(|_| "<failed to read error body>".to_string());
        return Err(format!("OpenAI API error {}: {}", status, body));
    }

    let payload: Value = response
        .json()
        .map_err(|e| format!("Failed to decode OpenAI response: {}", e))?;

    let text = extract_output_text(&payload).ok_or_else(|| {
        let status = payload
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let finish = payload
            .get("incomplete_details")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".to_string());
        let preview: String = payload.to_string().chars().take(1500).collect();
        eprintln!(
            "[timeline-ai] extraction failed, response preview: {}",
            preview
        );
        format!(
            "OpenAI response did not contain usable text (status={}, incomplete_details={})",
            status, finish
        )
    })?;
    eprintln!(
        "[timeline-ai] responses ok model={} schema={} prompt_chars={} input_chars={} output_chars={} elapsed_ms={}",
        model,
        schema_name,
        instruction.len(),
        input_json.len(),
        text.len(),
        started.elapsed().as_millis()
    );
    Ok(text)
}

fn timeline_text_max_output_tokens() -> i64 {
    std::env::var("TIMELINE_AI_MAX_OUTPUT_TOKENS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|v| *v >= 1200 && *v <= 16_000)
        .unwrap_or(DEFAULT_TEXT_MAX_OUTPUT_TOKENS)
}

fn extract_output_text(payload: &Value) -> Option<String> {
    if let Some(text) = payload
        .get("output_text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(text.to_string());
    }

    if let Some(output_arr) = payload.get("output").and_then(Value::as_array) {
        for item in output_arr {
            if let Some(content_arr) = item.get("content").and_then(Value::as_array) {
                for content in content_arr {
                    if let Some(text) = content
                        .get("text")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                    {
                        return Some(text.to_string());
                    }
                }
            }
        }
    }

    None
}

fn parse_json_payload<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
    serde_json::from_str::<T>(raw.trim()).map_err(|e| {
        let preview: String = raw.chars().take(600).collect();
        format!(
            "Failed to parse AI JSON output: {} | raw_preview={}",
            e, preview
        )
    })
}

fn mock_response_json(instruction: &str, input_json: &str) -> String {
    if instruction.contains("hierarchy") || instruction.contains("levels 0-2") {
        return serde_json::json!({
            "nodes": [
                {
                    "level": 2,
                    "start_rowid": 1,
                    "end_rowid": 120,
                    "representative_rowid": 80,
                    "title": "Mock Subtopic",
                    "summary": "Synthetic subtopic summary for local testing with concrete details and decisions.",
                    "keywords": ["subtopic", "mock"],
                    "confidence": 0.74,
                    "ai_rationale": "mock hierarchy rationale",
                    "grouping_mode": "SEQUENTIAL",
                    "context_influence": "recent"
                },
                {
                    "level": 1,
                    "start_rowid": 1,
                    "end_rowid": 200,
                    "representative_rowid": 120,
                    "title": "Merged Topic",
                    "summary": "Synthetic merged summary for local testing with concrete timeline progression.",
                    "keywords": ["merged", "topic"],
                    "confidence": 0.72,
                    "ai_rationale": "mock merge rationale",
                    "grouping_mode": "SEQUENTIAL",
                    "context_influence": "none"
                },
                {
                    "level": 0,
                    "start_rowid": 1,
                    "end_rowid": 200,
                    "representative_rowid": 120,
                    "title": "Merged Era",
                    "summary": "Synthetic era summary for local testing with broad chronological framing.",
                    "keywords": ["era"],
                    "confidence": 0.7,
                    "ai_rationale": "mock era rationale",
                    "grouping_mode": "SEQUENTIAL",
                    "context_influence": "none"
                }
            ],
            "related": []
        })
        .to_string();
    }

    let value: Value = serde_json::from_str(input_json).unwrap_or(Value::Null);
    let local = value
        .get("tier1_local_messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let start_rowid = local
        .first()
        .and_then(|v| v.get("rowid"))
        .and_then(Value::as_i64)
        .unwrap_or(1) as i32;
    let end_rowid = local
        .last()
        .and_then(|v| v.get("rowid"))
        .and_then(Value::as_i64)
        .unwrap_or(start_rowid as i64) as i32;
    let mid_rowid = start_rowid + ((end_rowid - start_rowid) / 2);

    serde_json::json!({
        "nodes": [
            {
                "level": 3,
                "start_rowid": start_rowid,
                "end_rowid": end_rowid,
                "representative_rowid": mid_rowid,
                "title": "Mock Moment",
                "summary": "Synthetic moment summary for local testing with concrete dialogue events.",
                "keywords": ["mock", "moment"],
                "confidence": 0.67,
                "ai_rationale": "mock batch rationale",
                "grouping_mode": "SEQUENTIAL",
                "context_influence": "recent"
            }
        ],
        "related": [],
        "memories": [
            {
                "memory_type": "topic",
                "summary": "Mock recurring topic memory.",
                "confidence": 0.6,
                "first_seen_rowid": start_rowid,
                "last_seen_rowid": end_rowid,
                "support_rowids": [start_rowid, mid_rowid, end_rowid]
            }
        ]
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mock_batch_response_parses() {
        let ctx = serde_json::json!({
            "tier1_local_messages": [{"rowid": 10}, {"rowid": 20}]
        });
        let raw = mock_response_json("batch moments", &ctx.to_string());
        let parsed: AiBatchOutput = parse_json_payload(&raw).expect("mock batch parse");
        assert!(!parsed.nodes.is_empty());
    }

    #[test]
    fn mock_hierarchy_response_parses() {
        let raw = mock_response_json("hierarchy levels 0-2", "{}");
        let parsed: AiMergeOutput = parse_json_payload(&raw).expect("mock hierarchy parse");
        assert!(!parsed.nodes.is_empty());
        assert!(parsed.nodes.iter().any(|n| n.level == 0));
        assert!(parsed.nodes.iter().any(|n| n.level == 1));
        assert!(parsed.nodes.iter().any(|n| n.level == 2));
    }

    #[test]
    fn sanitize_node_fixes_swapped_rowids() {
        let mut node = AiNodeOutput {
            level: 3,
            start_rowid: 50,
            end_rowid: 10,
            representative_rowid: 30,
            title: "Test".to_string(),
            summary: "Test".to_string(),
            keywords: vec![],
            confidence: 0.5,
            ai_rationale: None,
            grouping_mode: None,
            context_influence: None,
        };
        sanitize_node(&mut node);
        assert_eq!(node.start_rowid, 10);
        assert_eq!(node.end_rowid, 50);
        assert_eq!(node.representative_rowid, 30);
    }

    #[test]
    fn batch_schema_is_valid_json() {
        let schema = batch_output_schema();
        assert_eq!(schema["type"], "object");
        assert!(schema["properties"]["nodes"].is_object());
        assert!(schema["properties"]["related"].is_object());
        assert!(schema["properties"]["memories"].is_object());
    }
}
