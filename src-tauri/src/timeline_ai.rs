use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::process::Command;
use std::time::{Duration, Instant};

const DEFAULT_OPENAI_MODEL: &str = "gpt-5-nano";
const DEFAULT_TIMEOUT_SECS: u64 = 45;
const DEFAULT_IMAGE_TIMEOUT_SECS: u64 = 20;
const DEFAULT_CONNECT_TIMEOUT_SECS: u64 = 10;
const MAX_IMAGE_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_DIMENSION: i32 = 1600;
const DEFAULT_IMAGE_JPEG_QUALITY: i32 = 72;

#[derive(Clone, Debug, Serialize)]
pub struct AiParticipant {
    pub full_name_or_handle: String,
    pub short_name: String,
    pub is_me: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiWindowImageMeta {
    pub attachment_rowid: i32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiWindowMessage {
    pub rowid: i32,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sender_name: Option<String>,
    pub text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub urls: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<AiWindowImageMeta>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiL0WindowContext {
    pub chat_id: i32,
    pub window_id: String,
    pub participants: Vec<AiParticipant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub current_moments_context: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub previous_texts: Vec<AiWindowMessage>,
    pub new_texts: Vec<AiWindowMessage>,
    pub prompt_version: i32,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiL2TopicInputMoment {
    pub moment_id: i64,
    pub start_rowid: i32,
    pub end_rowid: i32,
    pub representative_rowid: i32,
    pub title: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AiL2TopicsContext {
    pub chat_id: i32,
    pub participants: Vec<AiParticipant>,
    pub moments: Vec<AiL2TopicInputMoment>,
    pub prompt_version: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiTimelineItemOutput {
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
    pub rationale: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiL0WindowOutput {
    #[serde(default)]
    pub items: Vec<AiTimelineItemOutput>,
}

#[derive(Clone, Debug, Deserialize)]
pub struct AiL2TopicsOutput {
    #[serde(default)]
    pub items: Vec<AiL2TopicOutput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct AiL2TopicOutput {
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub keywords: Vec<String>,
    #[serde(default = "default_confidence")]
    pub confidence: f32,
    #[serde(default)]
    pub rationale: Option<String>,
    #[serde(default)]
    pub moment_ids: Vec<i64>,
}

const L0_WINDOW_PROMPT: &str = "\
You are building timeline moments for a single chat window.

Return strict JSON matching the schema.

Write in SECOND PERSON perspective addressed to the user ('you').
Use concrete, specific language. Never be vague.
Bad: 'You discussed plans and next steps.'
Good: 'You asked Alex to move the launch to Tuesday after legal flagged the contract wording.'

Input sections include:
- PARTICIPANTS
- CURRENT MOMENTS CONTEXT
- PREVIOUS TEXTS
- NEW TEXTS

Rules:
- Produce ONLY net-new L0 timeline items derived from NEW TEXTS.
- Cover NEW TEXTS in chronological order with contiguous, non-overlapping ranges when possible.
- representative_rowid must be inside [start_rowid, end_rowid].
- Keep titles short and specific.
- Keep summaries specific and useful to future search/review.
- Do not invent details.
- Do not mention missing metadata.
";

const L2_TOPICS_PROMPT: &str = "\
You are clustering timeline moments into broad, abstract TOPICS for one chat.

Return strict JSON matching the schema.

Write in SECOND PERSON perspective.
Use specific, concrete language. Avoid generic phrasing.

Rules:
- Build only broad topics, not tiny event fragments.
- Merge related moments about the same real-world thread (for example one meetup plan) into one topic.
- Each output item must reference one or more input moment_ids.
- Use each moment_id at most once when possible.
- Do not produce near-duplicate topics.
- Titles/summaries must be concrete but abstract enough to cover recurrence.
- Do not invent details.
";

pub fn is_openai_enabled() -> bool {
    crate::env_config::get_env_var("OPENAI_API_KEY").is_some()
}

pub fn openai_model_default() -> String {
    crate::env_config::get_env_var("OPENAI_MODEL")
        .unwrap_or_else(|| DEFAULT_OPENAI_MODEL.to_string())
}

pub fn openai_model_text() -> String {
    crate::env_config::get_env_var("OPENAI_MODEL_TIMELINE_TEXT")
        .unwrap_or_else(openai_model_default)
}

pub fn openai_model_media() -> String {
    crate::env_config::get_env_var("OPENAI_MODEL_TIMELINE_MEDIA")
        .unwrap_or_else(openai_model_default)
}

pub fn generate_l0_moments(context: &AiL0WindowContext) -> Result<AiL0WindowOutput, String> {
    let input_json = serde_json::to_string(context).map_err(|e| e.to_string())?;
    eprintln!(
        "[timeline-ai] l0 request chat={} window={} prev_texts={} new_texts={} moments_ctx={} bytes={}",
        context.chat_id,
        context.window_id,
        context.previous_texts.len(),
        context.new_texts.len(),
        context.current_moments_context.len(),
        input_json.len()
    );

    let raw = run_responses_call(
        &openai_model_text(),
        L0_WINDOW_PROMPT,
        &input_json,
        "l0_window_output",
        &l0_window_output_schema(),
    )?;
    let mut parsed: AiL0WindowOutput = parse_json_payload(&raw)?;
    for item in &mut parsed.items {
        sanitize_item(item);
    }
    parsed
        .items
        .retain(|i| !i.title.trim().is_empty() && !i.summary.trim().is_empty());

    Ok(parsed)
}

pub fn generate_l2_topics(context: &AiL2TopicsContext) -> Result<AiL2TopicsOutput, String> {
    let input_json = serde_json::to_string(context).map_err(|e| e.to_string())?;
    eprintln!(
        "[timeline-ai] l2 request chat={} moments={} bytes={}",
        context.chat_id,
        context.moments.len(),
        input_json.len()
    );

    let raw = run_responses_call(
        &openai_model_text(),
        L2_TOPICS_PROMPT,
        &input_json,
        "l2_topics_output",
        &l2_topics_output_schema(),
    )?;
    let mut parsed: AiL2TopicsOutput = parse_json_payload(&raw)?;
    for item in &mut parsed.items {
        sanitize_l2_topic(item);
    }
    parsed.items.retain(|i| {
        !i.title.trim().is_empty() && !i.summary.trim().is_empty() && !i.moment_ids.is_empty()
    });

    Ok(parsed)
}

fn sanitize_item(item: &mut AiTimelineItemOutput) {
    if item.end_rowid < item.start_rowid {
        std::mem::swap(&mut item.start_rowid, &mut item.end_rowid);
    }
    if item.representative_rowid < item.start_rowid || item.representative_rowid > item.end_rowid {
        item.representative_rowid = item.start_rowid + ((item.end_rowid - item.start_rowid) / 2);
    }
    if item.keywords.len() > 12 {
        item.keywords.truncate(12);
    }
    item.confidence = item.confidence.clamp(0.05, 1.0);
}

fn sanitize_l2_topic(item: &mut AiL2TopicOutput) {
    item.title = item.title.trim().to_string();
    item.summary = item.summary.trim().to_string();
    if item.keywords.len() > 12 {
        item.keywords.truncate(12);
    }
    item.confidence = item.confidence.clamp(0.05, 1.0);
    item.moment_ids.retain(|id| *id > 0);
    item.moment_ids.sort_unstable();
    item.moment_ids.dedup();
}

fn default_confidence() -> f32 {
    0.55
}

pub fn is_retryable_ai_error(err: &str) -> bool {
    let normalized = err.to_lowercase();
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

fn image_timeout_secs() -> u64 {
    crate::env_config::get_env_var("TIMELINE_IMAGE_TIMEOUT_SECS")
        .and_then(|v| v.parse::<u64>().ok())
        .map(|v| v.clamp(5, 120))
        .unwrap_or(DEFAULT_IMAGE_TIMEOUT_SECS)
}

pub fn describe_image_for_timeline(
    path: &str,
    mime_type: &str,
) -> Result<(String, String), String> {
    let started = Instant::now();
    let api_key = crate::env_config::get_env_var("OPENAI_API_KEY")
        .ok_or_else(|| "OPENAI_API_KEY is not set; skipping media captioning".to_string())?;

    let (bytes, effective_mime, transformed_path) =
        prepare_image_bytes_for_caption(path, mime_type)?;

    let model = openai_model_media();
    let image_b64 = {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(bytes)
    };

    let client = Client::builder()
        .connect_timeout(Duration::from_secs(DEFAULT_CONNECT_TIMEOUT_SECS))
        .timeout(Duration::from_secs(image_timeout_secs()))
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
              "image_url": format!("data:{};base64,{}", effective_mime, image_b64)
            }
          ]
        }
      ],
      "reasoning": {
        "effort": "low"
      },
      "text": {
        "verbosity": "low"
      }
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
        let incomplete = payload
            .get("incomplete_details")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".to_string());
        let output_types = payload
            .get("output")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| item.get("type").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(",")
            })
            .unwrap_or_else(|| "none".to_string());
        let preview: String = payload.to_string().chars().take(1200).collect();
        eprintln!(
            "[timeline-ai] image describe extraction failed status={} incomplete_details={} output_types={} payload_preview={}",
            status, incomplete, output_types, preview
        );
        "OpenAI response did not contain usable text".to_string()
    })?;

    eprintln!(
        "[timeline-ai] image describe ok path={} transformed_path={:?} mime={} model={} elapsed_ms={}",
        path,
        transformed_path,
        effective_mime,
        model,
        started.elapsed().as_millis()
    );
    Ok((text, model))
}

fn prepare_image_bytes_for_caption(
    path: &str,
    mime_type: &str,
) -> Result<(Vec<u8>, String, Option<String>), String> {
    let bytes = fs::read(path).map_err(|e| format!("Failed to read image {}: {}", path, e))?;
    if bytes.is_empty() {
        return Err("Image file is empty".to_string());
    }
    if bytes.len() <= MAX_IMAGE_BYTES {
        return Ok((bytes, mime_type.to_string(), None));
    }

    let tmp_name = format!(
        "timeline_caption_{}_{}.jpg",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let out_path = std::env::temp_dir().join(tmp_name);

    let status = Command::new("sips")
        .args([
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            &DEFAULT_IMAGE_JPEG_QUALITY.to_string(),
            "-Z",
            &DEFAULT_IMAGE_MAX_DIMENSION.to_string(),
            path,
            "--out",
        ])
        .arg(&out_path)
        .status()
        .map_err(|e| format!("Failed to run sips for compression: {}", e))?;

    if !status.success() {
        return Err("Failed to compress image via sips".to_string());
    }

    let compressed = fs::read(&out_path).map_err(|e| {
        format!(
            "Failed to read compressed image {}: {}",
            out_path.display(),
            e
        )
    })?;
    if compressed.is_empty() {
        return Err("Compressed image is empty".to_string());
    }
    if compressed.len() > MAX_IMAGE_BYTES {
        return Err(format!(
            "Compressed image still too large for captioning ({} bytes)",
            compressed.len()
        ));
    }

    Ok((
        compressed,
        "image/jpeg".to_string(),
        Some(out_path.to_string_lossy().to_string()),
    ))
}

fn run_responses_call(
    model: &str,
    instruction: &str,
    input_json: &str,
    schema_name: &str,
    schema: &Value,
) -> Result<String, String> {
    let started = Instant::now();
    if crate::env_config::get_env_var("TIMELINE_AI_MOCK")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
    {
        let mock = mock_response_json(schema_name, input_json);
        eprintln!(
            "[timeline-ai] mock response model={} prompt_chars={} input_chars={} output_chars={}",
            model,
            instruction.len(),
            input_json.len(),
            mock.len()
        );
        return Ok(mock);
    }

    let api_key = crate::env_config::get_env_var("OPENAI_API_KEY")
        .ok_or_else(|| "OPENAI_API_KEY is not set; cannot run AI timeline indexing".to_string())?;

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {}", e))?;

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
      }
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
        format!(
            "OpenAI response did not contain usable text (status={}, incomplete_details={})",
            status, finish
        )
    })?;

    eprintln!(
        "[timeline-ai] responses ok model={} schema={} input_chars={} output_chars={} elapsed_ms={}",
        model,
        schema_name,
        input_json.len(),
        text.len(),
        started.elapsed().as_millis()
    );

    Ok(text)
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
        let preview: String = raw.chars().take(500).collect();
        format!(
            "Failed to parse AI JSON output: {}. Preview: {}",
            e,
            preview.replace('\n', " ")
        )
    })
}

fn l0_window_output_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": timeline_item_schema()
            }
        },
        "required": ["items"],
        "additionalProperties": false
    })
}

fn l2_topics_output_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "summary": {"type": "string"},
                        "keywords": {"type": "array", "items": {"type": "string"}},
                        "confidence": {"type": "number"},
                        "rationale": {"type": "string"},
                        "moment_ids": {"type": "array", "items": {"type": "integer"}}
                    },
                    "required": ["title", "summary", "keywords", "confidence", "rationale", "moment_ids"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["items"],
        "additionalProperties": false
    })
}

fn timeline_item_schema() -> Value {
    serde_json::json!({
        "type": "object",
        "properties": {
            "start_rowid": {"type": "integer"},
            "end_rowid": {"type": "integer"},
            "representative_rowid": {"type": "integer"},
            "title": {"type": "string"},
            "summary": {"type": "string"},
            "keywords": {"type": "array", "items": {"type": "string"}},
            "confidence": {"type": "number"},
            "rationale": {"type": "string"}
        },
        "required": [
            "start_rowid",
            "end_rowid",
            "representative_rowid",
            "title",
            "summary",
            "keywords",
            "confidence",
            "rationale"
        ],
        "additionalProperties": false
    })
}

fn mock_response_json(schema_name: &str, input_json: &str) -> String {
    let parsed: Value = serde_json::from_str(input_json).unwrap_or(Value::Null);

    if schema_name == "l2_topics_output" {
        let moments = parsed
            .get("moments")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let first_title = moments
            .iter()
            .find_map(|n| n.get("title").and_then(Value::as_str))
            .unwrap_or("your main thread");
        let moment_ids: Vec<i64> = moments
            .iter()
            .filter_map(|n| n.get("moment_id").and_then(Value::as_i64))
            .collect();
        let title = format!("You coordinated around {}", truncate_plain(first_title, 36));

        serde_json::json!({
            "items": [
                {
                    "title": title,
                    "summary": "You revisited this core thread across multiple moments and pushed it forward.",
                    "keywords": ["timeline", "topic"],
                    "confidence": 0.62,
                    "rationale": "Merged linked moments into one broad topic",
                    "moment_ids": moment_ids
                }
            ]
        })
        .to_string()
    } else {
        let new_texts = parsed
            .get("new_texts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let min_rowid = new_texts
            .iter()
            .filter_map(|n| n.get("rowid").and_then(Value::as_i64))
            .min()
            .unwrap_or(1) as i32;
        let max_rowid = new_texts
            .iter()
            .filter_map(|n| n.get("rowid").and_then(Value::as_i64))
            .max()
            .unwrap_or(min_rowid as i64) as i32;
        let rep = min_rowid + ((max_rowid - min_rowid) / 2);
        let summary = new_texts
            .iter()
            .take(2)
            .filter_map(|msg| {
                let sender = msg
                    .get("sender_name")
                    .and_then(Value::as_str)
                    .unwrap_or("Someone");
                let text = msg.get("text").and_then(Value::as_str).unwrap_or("").trim();
                if text.is_empty() {
                    None
                } else {
                    Some(format!(
                        "{}: {}",
                        sender,
                        text.chars().take(48).collect::<String>()
                    ))
                }
            })
            .collect::<Vec<_>>()
            .join(" | ");

        serde_json::json!({
            "items": [
                {
                    "start_rowid": min_rowid,
                    "end_rowid": max_rowid,
                    "representative_rowid": rep,
                    "title": "You exchanged specific updates",
                    "summary": if summary.is_empty() { "You exchanged concrete details in this window.".to_string() } else { format!("You discussed: {}.", summary) },
                    "keywords": ["reform", "timeline"],
                    "confidence": 0.68,
                    "rationale": "Single contiguous request sequence"
                }
            ]
        })
        .to_string()
    }
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
