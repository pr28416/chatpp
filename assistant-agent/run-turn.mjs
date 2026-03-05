import readline from "node:readline";
import { writeSync } from "node:fs";
import { ToolLoopAgent, stepCountIs, tool } from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { xai } from "@ai-sdk/xai";
import { z } from "zod";

const DEBUG_ENABLED = ["1", "true", "yes", "on"].includes(
  String(process.env.ASSISTANT_DEBUG || "").toLowerCase(),
);

const SYSTEM_PROMPT = [
  "You are an investigative assistant for a local iMessage archive.",
  "Always use tools for factual claims about messages/timeline/SQL data.",
  "If at least one conversation is in scope and the user asks for message/timeline facts, you must call at least one tool before the final answer.",
  "Do not claim a conversation cannot be found until you have tried a relevant tool call.",
  "Use multiple tool calls when needed and cross-check evidence before concluding.",
  "For latest/last/recent message requests, prefer get_recent_messages instead of text search.",
  "If more than one conversation is in scope, always specify the target conversation when calling tools.",
  "Conversation labels can be user-defined aliases and may not match participant names.",
  "Treat provided conversation labels and @mentions as canonical references for tool selection.",
  "Be exploratory and choose the tools that best answer the question; you can combine tools iteratively.",
  "If evidence is insufficient, say so clearly.",
  "Keep answers concise and practical.",
  'Never use ambiguous pronouns like "they" without naming who spoke.',
  'When summarizing a message, always attribute it to a specific speaker label (for example: "You", "Alex", "Unknown sender").',
  "Prefer user-friendly prose over internal identifiers when possible.",
  "Use [cite:<chat_id>:<rowid>] inline evidence markers when possible, but do not refuse solely because citations are incomplete.",
  "Do not provide capability refusals for archive questions before attempting relevant tools.",
  "For personal or relationship questions, use only local archive evidence and clearly state uncertainty when evidence is indirect.",
  "For cross-chat text lookups, prefer search_all_chats before run_readonly_sql.",
  "For cross-chat requests where no specific chat is selected, you may use run_readonly_sql to discover evidence across chats.",
  "Investigate dynamically: combine broad search, contact lookup, chat narrowing, targeted message scans, and context fetches as needed.",
  "For open-ended investigations, run independent probes in parallel when possible, then refine with follow-up tool calls.",
  "Before concluding that evidence is missing, perform at least one refinement step from initial hits (for example: pivot to specific chats or contact-linked searches).",
  "Treat nearby messages as a context bundle, not isolated rows; stitch adjacent turns before concluding.",
  "Resolve pronouns (she/he/they) using nearest named entities in the same local context window when evidence supports it.",
  "Do not return a “name not found” conclusion if adjacent context in the same conversation plausibly names the entity; refine once more.",
  "run_readonly_sql output must map to message keys (rowid/chat_id) and be normalized before use.",
  "Chat DB schema hints for SQL: message(ROWID, guid, text, date, handle_id, is_from_me), chat(ROWID, chat_identifier, display_name), chat_message_join(chat_id, message_id), handle(ROWID, id).",
  "When querying chat table, use chat.ROWID as chat_id (do not assume chat.chat_id exists).",
  "Present results from the user perspective: lead with a direct answer, then concise supporting details.",
  "Prefer human-readable dates and avoid raw database/internal identifiers in prose.",
  "Be concise by default. If the user asks for all instances, provide complete coverage with a summary first, then grouped details.",
  "For cross-chat breakdown requests, group by conversation and keep chronology within each conversation.",
].join(" ");

let currentRun = null;
const pendingToolCalls = new Map();
let runKeepAlive = null;
let currentRunId = null;

function startRunKeepAlive() {
  if (runKeepAlive) {
    return;
  }
  // Keep the event loop alive while a run is active so unresolved async work cannot exit silently.
  runKeepAlive = setInterval(() => {}, 1000);
}

function stopRunKeepAlive() {
  if (!runKeepAlive) {
    return;
  }
  clearInterval(runKeepAlive);
  runKeepAlive = null;
}
const SUPPORTED_MODELS_BY_PROVIDER = {
  openai: new Set(["gpt-5.2", "gpt-5.2-pro", "gpt-5-mini", "gpt-5-nano"]),
  anthropic: new Set([
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5",
  ]),
  google: new Set([
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
  ]),
  xai: new Set([
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
    "grok-4-fast-reasoning",
    "grok-4-fast-non-reasoning",
  ]),
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

process.on("beforeExit", (code) => {
  if (!currentRun) {
    return;
  }
  emit({
    type: "error",
    message: `Sidecar beforeExit(${code}) while run is still active${currentRunId ? ` (run_id=${currentRunId})` : ""}`,
  });
});

process.on("unhandledRejection", (reason) => {
  emit({
    type: "error",
    message: `Unhandled rejection in assistant sidecar: ${compact(String(reason || "unknown"), 280)}`,
  });
});

function debugLog(event, details = {}) {
  if (!DEBUG_ENABLED) {
    return;
  }
  const payload = {
    at: new Date().toISOString(),
    event,
    ...details,
  };
  console.error(`[assistant-debug] ${JSON.stringify(payload)}`);
}

rl.on("line", async (line) => {
  if (!line.trim()) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    emit({ type: "error", message: "Invalid JSON input" });
    return;
  }

  if (payload.type === "tool_result") {
    const waiter = pendingToolCalls.get(payload.id);
    if (!waiter) {
      return;
    }
    pendingToolCalls.delete(payload.id);
    if (payload.ok) {
      waiter.resolve(payload.result);
    } else {
      waiter.reject(new Error(payload.error || "Tool call failed"));
    }
    return;
  }

  if (payload.type !== "run") {
    emit({
      type: "error",
      message: `Unsupported message type: ${payload.type}`,
    });
    return;
  }

  if (currentRun) {
    emit({ type: "error", message: "Run already in progress" });
    return;
  }

  currentRun = runTurn(payload.payload)
    .catch((err) => {
      emit({
        type: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      currentRunId = null;
      stopRunKeepAlive();
      currentRun = null;
      rl.close();
    });
});

async function runTurn(payload) {
  let finalized = false;
  const emitRuntimeEvent = (event) => {
    if (finalized) {
      debugLog("post-final-stream-drop", {
        run_id: runId,
        kind: event?.kind ?? null,
      });
      return;
    }
    emitStreamEvent(event);
  };
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  currentRunId = runId;
  startRunKeepAlive();
  const selectedChatId = isValidChatId(payload.selected_chat_id)
    ? Number(payload.selected_chat_id)
    : null;
  const mentionedChatIds = Array.isArray(payload.mentioned_chat_ids)
    ? payload.mentioned_chat_ids
        .map((v) => Number(v))
        .filter((v) => isValidChatId(v))
    : [];
  const conversation = Array.isArray(payload.conversation)
    ? payload.conversation
    : [];
  const userMessage = String(payload.user_message || "").trim();
  const modelProvider = String(payload.model_provider || "openai")
    .trim()
    .toLowerCase();
  const modelId = String(payload.model_id || "gpt-5-mini").trim();

  if (!userMessage) {
    throw new Error("user_message is required");
  }
  const supportedModels = SUPPORTED_MODELS_BY_PROVIDER[modelProvider];
  if (!supportedModels) {
    throw new Error(`Unsupported model provider: ${modelProvider}`);
  }
  if (!supportedModels.has(modelId)) {
    throw new Error(
      `Unsupported model for provider ${modelProvider}: ${modelId}`,
    );
  }

  ensureProviderKey(modelProvider);

  const startedAt = Date.now();
  const nowMs = () => Math.max(0, Date.now() - startedAt);
  emitRuntimeEvent({ kind: "run-start", at_ms: 0, run_id: runId });
  debugLog("run-start", {
    run_id: runId,
    provider: modelProvider,
    model_id: modelId,
    selected_chat_id: selectedChatId,
    mentioned_chat_ids: mentionedChatIds,
    user_message_preview: compact(userMessage, 140),
  });

  const scopedChatIds = Array.from(
    new Set([
      ...(selectedChatId == null ? [] : [selectedChatId]),
      ...mentionedChatIds,
    ]),
  );
  const selectedChatContext = normalizeChatContext(
    payload.selected_chat_context,
  );
  const mentionedChatContexts = Array.isArray(payload.mentioned_chat_contexts)
    ? payload.mentioned_chat_contexts.map(normalizeChatContext).filter(Boolean)
    : [];
  const chatContextById = new Map();
  if (selectedChatContext) {
    chatContextById.set(selectedChatContext.chat_id, selectedChatContext);
  }
  for (const context of mentionedChatContexts) {
    chatContextById.set(context.chat_id, context);
  }
  const mentionedContextText = mentionedChatContexts.length
    ? mentionedChatContexts.map((ctx) => describeChatContext(ctx)).join("; ")
    : "None.";
  const toolTraceLog = [];
  let activePass = null;
  let preflightEvidenceText = "";

  const resolveScopedChatId = (input = {}) => {
    if (isValidChatId(input.chat_id)) {
      const requested = Number(input.chat_id);
      if (scopedChatIds.length === 0) {
        return requested;
      }
      if (scopedChatIds.includes(requested)) {
        return requested;
      }
      throw new Error("Requested conversation is outside the allowed scope");
    }

    const conversation =
      typeof input.conversation === "string" ? input.conversation.trim() : "";
    if (!conversation || /^current$/i.test(conversation)) {
      if (scopedChatIds.length === 0) {
        throw new Error(
          "No conversation in scope. Use @ in the composer to mention at least one chat.",
        );
      }
      if (scopedChatIds.length > 1) {
        throw new Error(
          "Multiple conversations are in scope. Specify one by name or chat_id.",
        );
      }
      return scopedChatIds[0];
    }

    const normalizedConversation = normalizeConversationToken(conversation);
    for (const context of chatContextById.values()) {
      const label = normalizeConversationToken(context.label);
      const participants = normalizeConversationToken(
        context.participants.join(" "),
      );
      if (
        label.includes(normalizedConversation) ||
        participants.includes(normalizedConversation)
      ) {
        return context.chat_id;
      }
    }

    // If only one conversation is in scope, default to it even when the free-text reference is noisy.
    if (scopedChatIds.length === 1) {
      return scopedChatIds[0];
    }

    throw new Error(`Unknown conversation reference: ${conversation}`);
  };

  const scopeDescription =
    scopedChatIds.length === 0
      ? "Tool scope is empty until the user @mentions at least one conversation."
      : scopedChatIds.length === 1
        ? "Tool scope is limited to one conversation."
        : `Tool scope is limited to ${scopedChatIds.length} conversations.`;

  const bridgeTool = async (toolName, input) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emit({
      type: "tool_call",
      id,
      tool_name: toolName,
      args: input,
    });

    const toolStartedAt = Date.now();
    emitRuntimeEvent({
      kind: "tool-start",
      at_ms: nowMs(),
      run_id: runId,
      pass_index: activePass?.pass_index ?? null,
      pass_kind: activePass?.pass_kind ?? null,
      stream_text_enabled: activePass?.stream_text_enabled ?? null,
      tool_call_id: id,
      tool_name: toolName,
      input_preview: compact(safeStringify(input), 180),
      input_summary: summarizeToolStart(
        toolName,
        input,
        chatContextById,
        toolTraceLog,
      ),
    });

    try {
      const output = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingToolCalls.delete(id);
          reject(new Error(`Tool call timed out: ${toolName}`));
        }, 45000);

        pendingToolCalls.set(id, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });

      toolTraceLog.push({
        tool_name: toolName,
        input: safeStringify(input),
        output: safeStringify(output),
      });

      emitRuntimeEvent({
        kind: "tool-finish",
        at_ms: nowMs(),
        run_id: runId,
        pass_index: activePass?.pass_index ?? null,
        pass_kind: activePass?.pass_kind ?? null,
        stream_text_enabled: activePass?.stream_text_enabled ?? null,
        tool_call_id: id,
        tool_name: toolName,
        success: true,
        duration_ms: Date.now() - toolStartedAt,
        output_preview: compact(safeStringify(output), 220),
        output_summary: summarizeToolFinish(toolName, input, output),
      });

      return output;
    } catch (err) {
      emitRuntimeEvent({
        kind: "tool-finish",
        at_ms: nowMs(),
        run_id: runId,
        pass_index: activePass?.pass_index ?? null,
        pass_kind: activePass?.pass_kind ?? null,
        stream_text_enabled: activePass?.stream_text_enabled ?? null,
        tool_call_id: id,
        tool_name: toolName,
        success: false,
        duration_ms: Date.now() - toolStartedAt,
        output_preview: compact(
          err instanceof Error ? err.message : String(err),
          220,
        ),
        output_summary: null,
      });
      throw err;
    }
  };

  if (shouldPrefetchRecentMessages(userMessage, scopedChatIds)) {
    try {
      const prefetched = await bridgeTool("get_recent_messages", {
        chat_id: scopedChatIds[0],
        limit: 12,
      });
      preflightEvidenceText = compact(safeStringify(prefetched), 1800);
    } catch {
      preflightEvidenceText = "";
    }
  }

  if (shouldRunInvestigationPrelude(userMessage, scopedChatIds)) {
    const probePlan = dedupeInvestigationProbes(
      buildInvestigationProbes(userMessage, conversation, scopedChatIds),
    ).slice(0, 4);
    if (probePlan.length > 0) {
      const settled = await Promise.all(
        probePlan.map(async (probe) => {
          try {
            const output = await bridgeTool(probe.tool_name, probe.input);
            return {
              ok: true,
              tool_name: probe.tool_name,
              label: probe.label,
              output,
            };
          } catch (error) {
            return {
              ok: false,
              tool_name: probe.tool_name,
              label: probe.label,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }),
      );
      const successful = settled
        .filter((item) => item.ok)
        .map((item) => ({
          tool: item.tool_name,
          label: item.label,
          output: item.output,
        }));
      if (successful.length > 0) {
        const leads = rankInvestigationLeads({
          probeOutputs: successful,
          userMessage,
          scopedChatIds,
          max: 6,
        });
        const refinementPlan = dedupeInvestigationProbes(
          buildRefinementProbes({
            leads,
            userMessage,
            scopedChatIds,
          }),
        ).slice(0, 4);

        const refinementSuccessful = [];
        if (refinementPlan.length > 0) {
          const refinementSettled = await Promise.all(
            refinementPlan.map(async (probe) => {
              try {
                const output = await bridgeTool(probe.tool_name, probe.input);
                return {
                  ok: true,
                  tool_name: probe.tool_name,
                  label: probe.label,
                  output,
                };
              } catch (error) {
                return {
                  ok: false,
                  tool_name: probe.tool_name,
                  label: probe.label,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            }),
          );
          refinementSuccessful.push(
            ...refinementSettled
              .filter((item) => item.ok)
              .map((item) => ({
                tool: item.tool_name,
                label: item.label,
                output: item.output,
              })),
          );
        }

        const summarized = compact(safeStringify(successful), 2200);
        const leadSummary = compact(safeStringify(leads), 1000);
        const refinedSummary = refinementSuccessful.length
          ? compact(safeStringify(refinementSuccessful), 1800)
          : "";
        preflightEvidenceText = preflightEvidenceText
          ? `${preflightEvidenceText}\n\nInvestigation probes (JSON): ${summarized}\n\nInvestigation leads (JSON): ${leadSummary}${refinedSummary ? `\n\nRefinement probes (JSON): ${refinedSummary}` : ""}`
          : `Investigation probes (JSON): ${summarized}\n\nInvestigation leads (JSON): ${leadSummary}${refinedSummary ? `\n\nRefinement probes (JSON): ${refinedSummary}` : ""}`;
      }
    }
  }

  const agent = new ToolLoopAgent({
    model: buildModel(modelProvider, modelId),
    instructions: SYSTEM_PROMPT,
    stopWhen: stepCountIs(16),
    tools: {
      search_messages: tool({
        description:
          "Search messages in a conversation. Use this first for fact-finding.",
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          q: z.string().min(1),
          limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async (input) =>
          bridgeTool("search_messages", {
            chat_id: resolveScopedChatId(input),
            q: input.q,
            limit: input.limit,
          }),
      }),
      search_all_chats: tool({
        description:
          "Search across all chats for a text query and return normalized message evidence with chat_id/rowid.",
        inputSchema: z.object({
          q: z.string().min(1),
          limit: z.number().int().min(1).max(240).optional(),
        }),
        execute: async (input) =>
          bridgeTool("search_all_chats", {
            q: input.q,
            limit: input.limit,
          }),
      }),
      search_contacts: tool({
        description:
          "Find contacts by name or handle and return best matches plus candidate conversation ids.",
        inputSchema: z.object({
          q: z.string().min(1),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (input) =>
          bridgeTool("search_contacts", {
            q: input.q,
            limit: input.limit,
          }),
      }),
      find_chats_by_contact: tool({
        description:
          "Find conversations associated with a contact name or handle.",
        inputSchema: z.object({
          name_or_handle: z.string().min(1),
          limit: z.number().int().min(1).max(80).optional(),
        }),
        execute: async (input) =>
          bridgeTool("find_chats_by_contact", {
            name_or_handle: input.name_or_handle,
            limit: input.limit,
          }),
      }),
      search_messages_by_contact: tool({
        description:
          "Search messages in conversations containing a contact. Optional q filters message text.",
        inputSchema: z.object({
          name_or_handle: z.string().min(1),
          q: z.string().optional(),
          limit: z.number().int().min(1).max(240).optional(),
        }),
        execute: async (input) =>
          bridgeTool("search_messages_by_contact", {
            name_or_handle: input.name_or_handle,
            q: input.q,
            limit: input.limit,
          }),
      }),
      get_recent_messages: tool({
        description:
          "Fetch newest messages in a conversation, optionally filtered by sender label/handle.",
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          sender: z.string().optional(),
          offset: z.number().int().min(0).max(5000).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        execute: async (input) =>
          bridgeTool("get_recent_messages", {
            chat_id: resolveScopedChatId(input),
            sender: input.sender,
            offset: input.offset,
            limit: input.limit,
          }),
      }),
      get_message_context: tool({
        description: "Fetch message window around a rowid in a conversation.",
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          rowid: z.number().int(),
          window: z.number().int().min(10).max(120).optional(),
        }),
        execute: async (input) =>
          bridgeTool("get_message_context", {
            chat_id: resolveScopedChatId(input),
            rowid: input.rowid,
            window: input.window,
          }),
      }),
      search_timeline: tool({
        description: "Search AI-generated timeline nodes in a conversation.",
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          q: z.string().min(1),
          limit: z.number().int().min(1).max(64).optional(),
        }),
        execute: async (input) =>
          bridgeTool("search_timeline", {
            chat_id: resolveScopedChatId(input),
            q: input.q,
            limit: input.limit,
          }),
      }),
      timeline_overview: tool({
        description: "Get timeline index status/health for a conversation.",
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
        }),
        execute: async (input) =>
          bridgeTool("timeline_overview", {
            chat_id: resolveScopedChatId(input),
          }),
      }),
      run_readonly_sql: tool({
        description:
          "Advanced last-resort query on chat DB. Results must include rowid/chat_id and are normalized into message records by Rust.",
        inputSchema: z.object({
          db: z.literal("chat").optional(),
          sql: z.string().min(1),
          params: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async (input) => bridgeTool("run_readonly_sql", input),
      }),
    },
  });

  const transcript = conversation
    .slice(-14)
    .map(
      (turn) =>
        `${turn.role?.toUpperCase() || "USER"}: ${sanitizePromptText(String(turn.text || "").trim())}`,
    )
    .join("\n");
  const contextListText =
    Array.from(chatContextById.values())
      .map(
        (ctx) =>
          `- ${ctx.label} (participants: ${ctx.participants.join(", ") || "n/a"})`,
      )
      .join("\n") || "- none";

  const prompt = [
    selectedChatContext
      ? `Current conversation: ${describeChatContext(selectedChatContext)}.`
      : "Current conversation: none selected.",
    `Referenced conversations: ${mentionedContextText}`,
    "Use conversation names and participants in your reasoning and response, not internal IDs.",
    "Reminder: a conversation label is not necessarily a participant name.",
    scopeDescription,
    scopedChatIds.length === 0
      ? "No chat is currently selected. For cross-chat requests, you may discover evidence via run_readonly_sql."
      : "",
    preflightEvidenceText
      ? `Pre-fetched recent messages evidence (JSON): ${preflightEvidenceText}`
      : "",
    "Available conversation references:",
    contextListText,
    transcript ? `Recent conversation:\n${transcript}` : "",
    `User request: ${userMessage}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  let passIndex = 0;
  const runAgentPass = async (
    passPrompt,
    {
      streamTextDeltas = true,
      streamReasoningDeltas = true,
      passKind = "primary",
    } = {},
  ) => {
    const currentPass = passIndex;
    passIndex += 1;
    activePass = {
      pass_index: currentPass,
      pass_kind: passKind,
      stream_text_enabled: streamTextDeltas,
    };
    debugLog("pass-start", {
      run_id: runId,
      pass_index: currentPass,
      pass_kind: passKind,
      stream_text_enabled: streamTextDeltas,
      stream_reasoning_enabled: streamReasoningDeltas,
    });
    try {
      const text = await streamResultToText(
        await agent.stream({ prompt: passPrompt }),
        nowMs,
        {
          streamTextDeltas,
          streamReasoningDeltas,
          runId,
          passInfo: activePass,
          emitEvent: emitRuntimeEvent,
        },
      );
      debugLog("pass-finish", {
        run_id: runId,
        pass_index: currentPass,
        pass_kind: passKind,
        text_len: text.length,
      });
      return text;
    } finally {
      activePass = null;
    }
  };

  let finalText = await runAgentPass(prompt, {
    streamTextDeltas: true,
    streamReasoningDeltas: true,
    passKind: "primary",
  });

  if (toolTraceLog.length === 0) {
    const fallbackPlan = buildRequiredToolFallback({
      userMessage,
      conversation,
      scopedChatIds,
      chatContextById,
    });
    emitRuntimeEvent({
      kind: "policy-fallback-start",
      at_ms: nowMs(),
      text: `No model tool call detected. Running fallback: ${fallbackPlan.tool_name}.`,
    });
    const fallbackOutput = await bridgeTool(
      fallbackPlan.tool_name,
      fallbackPlan.input,
    );
    const fallbackPrompt = [
      prompt,
      `Tool policy fallback reason: ${fallbackPlan.reason}.`,
      `Fallback evidence from ${fallbackPlan.tool_name}: ${compact(safeStringify(fallbackOutput), 2500)}`,
      "Now answer the user using this evidence. If multiple conversations are possible, explicitly ask for disambiguation.",
    ].join("\n\n");
    finalText = await runAgentPass(fallbackPrompt, {
      streamTextDeltas: false,
      streamReasoningDeltas: false,
      passKind: "policy-fallback",
    });
    emitRuntimeEvent({
      kind: "policy-fallback-finish",
      at_ms: nowMs(),
      text: `Fallback completed using ${fallbackPlan.tool_name}.`,
    });
  }

  const stitchHints = deriveContextStitchHints({
    toolTraces: toolTraceLog,
    scopedChatIds,
  });
  if (shouldRetryForContextStitch(finalText, stitchHints)) {
    emitRuntimeEvent({
      kind: "policy-fallback-start",
      at_ms: nowMs(),
      text: "Refining with adjacent-message context stitching.",
    });
    const stitchPrompt = [
      prompt,
      `Context-stitch hints (JSON): ${compact(safeStringify(stitchHints.slice(0, 6)), 1800)}`,
      "Your current draft appears inconclusive. Re-evaluate by stitching adjacent messages and resolving pronouns to nearest named entities when supported by local context.",
      "If a plausible name appears in adjacent turns, state it with confidence level and cite the supporting turns.",
    ].join("\n\n");
    finalText = await runAgentPass(stitchPrompt, {
      streamTextDeltas: false,
      streamReasoningDeltas: false,
      passKind: "context-stitch-refinement",
    });
    emitRuntimeEvent({
      kind: "policy-fallback-finish",
      at_ms: nowMs(),
      text: "Context-stitch refinement complete.",
    });
  }

  let citations = inferCitations({
    toolTraces: toolTraceLog,
    fallbackChatId: selectedChatId,
    scopedChatIds,
    preferredRefs: extractPreferredCitationRefs(finalText),
  });
  finalText = canonicalizeCitationTokens(finalText, citations);
  debugLog("citations-inferred", {
    run_id: runId,
    count: citations.length,
    inline_refs: extractInlineCitationRefs(finalText).length,
  });
  let hardValidation = validateCitationIntegrity({
    text: finalText,
    citations,
    toolTraces: toolTraceLog,
    scopedChatIds,
  });
  debugLog("citation-validation", {
    run_id: runId,
    ok: hardValidation.ok,
    reason: hardValidation.reason ?? null,
    phase: "final",
  });
  if (!hardValidation.ok) {
    debugLog("citation-validation-failed", {
      run_id: runId,
      reason: hardValidation.reason,
    });
    emitRuntimeEvent({
      kind: "citation-warning",
      at_ms: nowMs(),
      run_id: runId,
      text: `Citation validation warning: ${hardValidation.reason}`,
    });
    finalText = stripUnresolvedInlineCitations(finalText, citations);
  }

  const durationMs = nowMs();
  emitRuntimeEvent({
    kind: "run-finish",
    at_ms: durationMs,
    duration_ms: durationMs,
    run_id: runId,
  });
  debugLog("run-finish", {
    run_id: runId,
    duration_ms: durationMs,
    citation_count: citations.length,
    tool_trace_count: toolTraceLog.length,
    final_text_len: finalText.trim().length,
  });

  finalized = true;
  debugLog("final-emit-start", {
    run_id: runId,
    final_text_len: finalText.trim().length,
    tool_trace_count: toolTraceLog.length,
  });
  emit({
    type: "final",
    text: finalText.trim(),
    tool_traces: toolTraceLog,
    duration_ms: durationMs,
  });
  debugLog("final-emit-complete", {
    run_id: runId,
  });
}

function extractDeltaText(part) {
  if (!part || typeof part !== "object") {
    return "";
  }
  const candidates = [
    part.text,
    part.delta,
    part.value,
    part.content,
    part.outputText,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return "";
}

function isReasoningLikePart(type) {
  if (!type || typeof type !== "string") {
    return false;
  }
  const normalized = type.toLowerCase();
  return normalized.includes("reasoning") && normalized.includes("delta");
}

function isTextLikePart(type) {
  if (!type || typeof type !== "string") {
    return false;
  }
  const normalized = type.toLowerCase();
  if (normalized.includes("reasoning")) {
    return false;
  }
  return normalized.includes("text") && normalized.includes("delta");
}

async function streamResultToText(
  result,
  nowMs,
  {
    streamTextDeltas = true,
    streamReasoningDeltas = true,
    runId = null,
    passInfo = null,
    emitEvent = emitStreamEvent,
  } = {},
) {
  let streamedText = "";
  let stepIndex = -1;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case "start-step": {
        stepIndex += 1;
        emitEvent({
          kind: "step-start",
          at_ms: nowMs(),
          run_id: runId,
          pass_index: passInfo?.pass_index ?? null,
          pass_kind: passInfo?.pass_kind ?? null,
          stream_text_enabled: passInfo?.stream_text_enabled ?? null,
          step_index: stepIndex,
        });
        break;
      }
      case "finish-step": {
        emitEvent({
          kind: "step-finish",
          at_ms: nowMs(),
          run_id: runId,
          pass_index: passInfo?.pass_index ?? null,
          pass_kind: passInfo?.pass_kind ?? null,
          stream_text_enabled: passInfo?.stream_text_enabled ?? null,
          step_index: stepIndex,
          finish_reason: part.finishReason,
        });
        break;
      }
      case "reasoning-delta": {
        const reasoningText = extractDeltaText(part);
        if (reasoningText && streamReasoningDeltas) {
          emitEvent({
            kind: "reasoning-delta",
            at_ms: nowMs(),
            run_id: runId,
            pass_index: passInfo?.pass_index ?? null,
            pass_kind: passInfo?.pass_kind ?? null,
            stream_text_enabled: passInfo?.stream_text_enabled ?? null,
            text: reasoningText,
          });
        }
        break;
      }
      case "text-delta": {
        const textDelta = extractDeltaText(part);
        if (textDelta) {
          streamedText += textDelta;
          if (streamTextDeltas) {
            emitEvent({
              kind: "text-delta",
              at_ms: nowMs(),
              run_id: runId,
              pass_index: passInfo?.pass_index ?? null,
              pass_kind: passInfo?.pass_kind ?? null,
              stream_text_enabled: passInfo?.stream_text_enabled ?? null,
              text: textDelta,
            });
          }
        }
        break;
      }
      case "error": {
        emitEvent({
          kind: "run-error",
          at_ms: nowMs(),
          run_id: runId,
          pass_index: passInfo?.pass_index ?? null,
          pass_kind: passInfo?.pass_kind ?? null,
          stream_text_enabled: passInfo?.stream_text_enabled ?? null,
          text: compact(String(part.error ?? "Unknown stream error"), 200),
        });
        break;
      }
      default:
        if (isReasoningLikePart(part.type)) {
          const reasoningText = extractDeltaText(part);
          if (reasoningText && streamReasoningDeltas) {
            emitEvent({
              kind: "reasoning-delta",
              at_ms: nowMs(),
              run_id: runId,
              pass_index: passInfo?.pass_index ?? null,
              pass_kind: passInfo?.pass_kind ?? null,
              stream_text_enabled: passInfo?.stream_text_enabled ?? null,
              text: reasoningText,
            });
          }
          break;
        }
        if (isTextLikePart(part.type)) {
          const textDelta = extractDeltaText(part);
          if (textDelta) {
            streamedText += textDelta;
            if (streamTextDeltas) {
              emitEvent({
                kind: "text-delta",
                at_ms: nowMs(),
                run_id: runId,
                pass_index: passInfo?.pass_index ?? null,
                pass_kind: passInfo?.pass_kind ?? null,
                stream_text_enabled: passInfo?.stream_text_enabled ?? null,
                text: textDelta,
              });
            }
          }
        }
        break;
    }
  }

  return streamedText.trim();
}

function buildRequiredToolFallback({
  userMessage,
  conversation,
  scopedChatIds,
  chatContextById,
}) {
  const normalizedMessage = normalizeConversationToken(userMessage);
  if (scopedChatIds.length === 0) {
    const seedMessage = deriveFallbackSeed(userMessage, conversation);
    const extracted = extractSearchQuery(String(seedMessage || ""));
    const fallbackQuery =
      extracted ||
      extractLikelySearchTerm(String(seedMessage || "")) ||
      seedMessage.trim() ||
      normalizedMessage;
    return {
      tool_name: "search_all_chats",
      reason: "cross-chat request with no selected conversation",
      input: {
        q: fallbackQuery,
        limit: 120,
      },
    };
  }
  const explicitChatId = resolveChatFromMessageAliases(
    normalizedMessage,
    scopedChatIds,
    chatContextById,
  );
  const targetChatId =
    explicitChatId ??
    (scopedChatIds.length === 1 ? scopedChatIds[0] : scopedChatIds[0]);
  const latestLike = /\b(latest|recent|last|newest)\b/.test(normalizedMessage);
  const searchLike = /\b(search|find|contains|mention|mentions)\b/.test(
    normalizedMessage,
  );

  if (latestLike) {
    return {
      tool_name: "get_recent_messages",
      reason: "latest/recent intent requires concrete evidence",
      input: {
        chat_id: targetChatId,
        limit: 12,
      },
    };
  }

  if (searchLike) {
    return {
      tool_name: "search_messages",
      reason: "search intent requires concrete evidence",
      input: {
        chat_id: targetChatId,
        q: extractSearchQuery(normalizedMessage) || normalizedMessage,
        limit: 80,
      },
    };
  }

  return {
    tool_name: "get_recent_messages",
    reason: "tool-required policy fallback",
    input: {
      chat_id: targetChatId,
      limit: 8,
    },
  };
}

function resolveChatFromMessageAliases(
  normalizedMessage,
  scopedChatIds,
  chatContextById,
) {
  const aliasTokens = Array.from(
    new Set(
      (
        String(normalizedMessage || "").match(/@([a-z0-9_][a-z0-9_\-]*)/gi) ||
        []
      )
        .map((token) => normalizeConversationToken(token.replace(/^@+/, "")))
        .filter(Boolean),
    ),
  );
  if (aliasTokens.length === 0) {
    return null;
  }
  for (const token of aliasTokens) {
    const candidates = Array.from(chatContextById.values())
      .filter((context) => scopedChatIds.includes(context.chat_id))
      .filter((context) => {
        const haystack = normalizeConversationToken(
          `${context.label} ${context.participants.join(" ")}`,
        );
        return haystack.includes(token);
      });
    if (candidates.length === 1) {
      return candidates[0].chat_id;
    }
  }
  return null;
}

function extractSearchQuery(normalizedMessage) {
  const match = String(normalizedMessage || "").match(/"([^"]+)"/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function extractLikelySearchTerm(message) {
  const stopwords = new Set([
    "tell",
    "me",
    "where",
    "all",
    "across",
    "my",
    "chats",
    "chat",
    "conversations",
    "conversation",
    "give",
    "breakdown",
    "of",
    "about",
    "spoke",
    "discussed",
    "mentioned",
    "mention",
    "instances",
    "instance",
    "did",
    "was",
    "were",
    "the",
    "a",
    "an",
    "to",
    "for",
  ]);
  const tokens = String(message || "")
    .split(/[^A-Za-z0-9._-]+/)
    .map((token) => token.trim())
    .filter(Boolean);
  const candidates = tokens.filter((token) => {
    const lower = token.toLowerCase();
    if (stopwords.has(lower)) {
      return false;
    }
    if (lower.length < 2) {
      return false;
    }
    return /[a-zA-Z]/.test(token);
  });
  if (candidates.length === 0) {
    return null;
  }
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0];
}

function extractLikelyPersonSeed(message) {
  const source = String(message || "").trim();
  const whoIsMatch = source.match(
    /\bwho\s+is\s+([a-z][a-z0-9'’._-]*(?:\s+[a-z][a-z0-9'’._-]*){0,2})\b/i,
  );
  if (whoIsMatch?.[1]) {
    return whoIsMatch[1].trim().replace(/['’]s$/i, "");
  }
  return null;
}

function deriveFallbackSeed(userMessage, conversation) {
  const message = String(userMessage || "").trim();
  if (!isVagueFollowup(message)) {
    return message;
  }
  const priorUserTurns = Array.isArray(conversation)
    ? conversation
        .slice()
        .reverse()
        .filter((turn) => String(turn?.role || "").toLowerCase() === "user")
        .map((turn) => String(turn?.text || "").trim())
        .filter(Boolean)
    : [];
  return priorUserTurns.find((text) => !isVagueFollowup(text)) || message;
}

function isVagueFollowup(message) {
  const normalized = normalizeConversationToken(String(message || ""));
  if (!normalized) {
    return true;
  }
  if (
    !/\b(yes|yea|yeah|yep|look up|search|check|in my archive|do it|please)\b/.test(
      normalized,
    )
  ) {
    return false;
  }
  return normalized.split(/\s+/).length <= 8;
}

function shouldRunInvestigationPrelude(userMessage, scopedChatIds) {
  if (Array.isArray(scopedChatIds) && scopedChatIds.length > 0) {
    return false;
  }
  const normalized = normalizeConversationToken(String(userMessage || ""));
  if (!normalized) {
    return false;
  }
  return /\b(who|what|when|where|why|how|find|search|look up|check|tell me|does|did|is|are)\b/.test(
    normalized,
  );
}

function buildInvestigationProbes(userMessage, conversation, scopedChatIds) {
  if (Array.isArray(scopedChatIds) && scopedChatIds.length > 0) {
    return [];
  }
  const seed = deriveFallbackSeed(userMessage, conversation);
  const quoted = extractSearchQuery(seed);
  const likelyTerm = extractLikelySearchTerm(seed);
  const personSeed = extractLikelyPersonSeed(seed);
  const broad = quoted || seed.trim();
  const probes = [];

  if (broad) {
    probes.push({
      tool_name: "search_all_chats",
      label: "broad archive search",
      input: { q: broad, limit: 120 },
    });
  }
  if (likelyTerm && likelyTerm.toLowerCase() !== String(broad).toLowerCase()) {
    probes.push({
      tool_name: "search_all_chats",
      label: "narrowed term search",
      input: { q: likelyTerm, limit: 120 },
    });
  }
  if (personSeed) {
    probes.push({
      tool_name: "search_contacts",
      label: "contact lookup",
      input: { q: personSeed, limit: 12 },
    });
    probes.push({
      tool_name: "search_messages_by_contact",
      label: "contact-linked message scan",
      input: { name_or_handle: personSeed, limit: 120 },
    });
  } else if (likelyTerm) {
    probes.push({
      tool_name: "search_contacts",
      label: "contact lookup",
      input: { q: likelyTerm, limit: 12 },
    });
  }
  return probes;
}

function dedupeInvestigationProbes(probes) {
  const out = [];
  const seen = new Set();
  for (const probe of probes || []) {
    const key = `${probe?.tool_name}:${safeStringify(probe?.input || {})}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(probe);
  }
  return out;
}

function deriveContextStitchHints({ toolTraces, scopedChatIds }) {
  const rows = collectEvidenceCitations({
    toolTraces,
    fallbackChatId: null,
    scopedChatIds,
    max: 512,
  });
  const byChat = new Map();
  for (const row of rows) {
    const list = byChat.get(row.chat_id) ?? [];
    list.push(row);
    byChat.set(row.chat_id, list);
  }

  const hints = [];
  for (const [chatId, list] of byChat.entries()) {
    const sorted = list.slice().sort((a, b) => a.rowid - b.rowid);
    for (let i = 0; i < sorted.length; i += 1) {
      const current = sorted[i];
      const currentText = String(current.message_text || "");
      if (!/\b(she|he|they|her|him|their)\b/i.test(currentText)) {
        continue;
      }
      const start = Math.max(0, i - 3);
      const window = sorted.slice(start, i + 1);
      const names = extractEntityNamesFromWindow(window);
      if (names.length === 0) {
        continue;
      }
      hints.push({
        chat_id: chatId,
        rowid: current.rowid,
        pronoun_text: compact(currentText, 120),
        candidate_names: names.slice(0, 3),
        window_rowids: window.map((item) => item.rowid),
      });
    }
  }
  return hints;
}

function extractEntityNamesFromWindow(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const text = String(row?.message_text || "");
    for (const match of text.matchAll(
      /\b([A-Z][a-z]{2,})(?:\s+([A-Z][a-z]{2,}))?\b/g,
    )) {
      const first = String(match[1] || "");
      const second = String(match[2] || "");
      const candidate = second ? `${first} ${second}` : first;
      const lower = candidate.toLowerCase();
      if (
        [
          "you",
          "she",
          "he",
          "they",
          "her",
          "him",
          "their",
          "yeah",
          "yep",
        ].includes(lower)
      ) {
        continue;
      }
      if (seen.has(lower)) {
        continue;
      }
      seen.add(lower);
      out.push(candidate);
    }
  }
  return out;
}

function shouldRetryForContextStitch(finalText, stitchHints) {
  if (!Array.isArray(stitchHints) || stitchHints.length === 0) {
    return false;
  }
  const normalized = String(finalText || "").toLowerCase();
  if (!normalized) {
    return false;
  }
  return /\b(cannot find|can't find|can’t find|don't see a name|do not see a name|name not found|no evidence|unable to determine)\b/.test(
    normalized,
  );
}

function rankInvestigationLeads({
  probeOutputs,
  userMessage,
  scopedChatIds,
  max = 6,
}) {
  const queryTerms = buildQueryTerms(userMessage);
  const scored = new Map();

  for (const probe of probeOutputs || []) {
    const rows = collectEvidenceFromValue(probe?.output, scopedChatIds, 80);
    for (const row of rows) {
      const key = `${row.chat_id}:${row.rowid}`;
      const text = String(row.message_text || "").toLowerCase();
      let score = 10;
      if (text.length > 0) {
        for (const term of queryTerms) {
          if (text.includes(term)) {
            score += 6;
          }
        }
      }
      if (
        /\b(girlfriend|boyfriend|partner|wife|husband|dating|relationship)\b/i.test(
          text,
        )
      ) {
        score += 8;
      }
      const existing = scored.get(key);
      if (!existing || existing.score < score) {
        scored.set(key, {
          chat_id: row.chat_id,
          rowid: row.rowid,
          score,
          message_text: row.message_text || "",
          chat_label: row.chat_label || null,
        });
      }
    }
  }

  return Array.from(scored.values())
    .sort((a, b) => b.score - a.score || b.rowid - a.rowid)
    .slice(0, max);
}

function buildRefinementProbes({ leads, userMessage, scopedChatIds }) {
  const probes = [];
  const queryTerms = buildQueryTerms(userMessage);
  const q =
    queryTerms[0] || extractLikelySearchTerm(userMessage) || userMessage.trim();
  const uniqueChats = Array.from(
    new Set((leads || []).map((lead) => lead.chat_id)),
  ).slice(0, 3);

  for (const lead of (leads || []).slice(0, 2)) {
    probes.push({
      tool_name: "get_message_context",
      label: "context expansion around top lead",
      input: {
        chat_id: lead.chat_id,
        rowid: lead.rowid,
        window: 90,
      },
    });
  }

  for (const chatId of uniqueChats) {
    if (
      Array.isArray(scopedChatIds) &&
      scopedChatIds.length > 0 &&
      !scopedChatIds.includes(chatId)
    ) {
      continue;
    }
    probes.push({
      tool_name: "search_messages",
      label: "targeted chat refinement",
      input: {
        chat_id: chatId,
        q,
        limit: 80,
      },
    });
    probes.push({
      tool_name: "get_recent_messages",
      label: "recent messages check",
      input: {
        chat_id: chatId,
        limit: 20,
      },
    });
  }

  return probes;
}

function buildQueryTerms(message) {
  return String(message || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter(
      (token) =>
        ![
          "who",
          "what",
          "where",
          "when",
          "does",
          "have",
          "from",
          "with",
          "that",
          "your",
          "this",
        ].includes(token),
    )
    .slice(0, 6);
}

function collectEvidenceFromValue(value, scopedChatIds, max = 80) {
  const out = [];
  const seen = new Set();
  collectMessageEvidenceRows(value, {
    toolName: "investigation-prelude",
    fallbackChatId: null,
    scopedChatIds,
    seen,
    out,
    max,
  });
  return out;
}

function buildModel(provider, modelId) {
  const options = {
    parallelToolCalls: true,
    reasoningSummary: "detailed",
  };
  switch (provider) {
    case "openai":
      return openai(modelId, options);
    case "anthropic":
      return anthropic(modelId, options);
    case "google":
      return google(modelId, options);
    case "xai":
      return xai(modelId, options);
    default:
      throw new Error(`Unsupported model provider: ${provider}`);
  }
}

function ensureProviderKey(provider) {
  const keyByProvider = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_GENERATIVE_AI_API_KEY",
    xai: "XAI_API_KEY",
  };
  const envVar = keyByProvider[provider];
  const value = envVar ? process.env[envVar] : "";
  if (!value || !String(value).trim()) {
    throw new Error(`${envVar} is required for ${provider} models`);
  }
}

function inferCitations({
  toolTraces,
  fallbackChatId,
  scopedChatIds,
  preferredRefs = [],
  max = 64,
}) {
  if (!Array.isArray(preferredRefs) || preferredRefs.length === 0) {
    return [];
  }
  const evidence = collectEvidenceCitations({
    toolTraces,
    fallbackChatId,
    scopedChatIds,
    max: Math.max(max, 256),
  });

  const ordered = [];
  const seen = new Set();
  for (const preferredRef of preferredRefs) {
    const preferredRowid = toInt(preferredRef?.rowid);
    if (!Number.isFinite(preferredRowid)) {
      continue;
    }
    const preferredChatId = toInt(preferredRef?.chatId);
    const match = Number.isFinite(preferredChatId)
      ? evidence.find(
          (citation) =>
            citation.chat_id === preferredChatId &&
            citation.rowid === preferredRowid,
        )
      : evidence.find((citation) => citation.rowid === preferredRowid);
    if (!match) {
      continue;
    }
    const key = `${match.chat_id}:${match.rowid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(match);
  }
  for (const citation of evidence) {
    if (ordered.length >= max) {
      break;
    }
    const key = `${citation.chat_id}:${citation.rowid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(citation);
  }
  return ordered;
}

function collectEvidenceCitations({
  toolTraces,
  fallbackChatId,
  scopedChatIds,
  max = 256,
}) {
  const seen = new Set();
  const out = [];
  for (const trace of toolTraces) {
    let parsed;
    try {
      parsed = JSON.parse(trace.output);
    } catch {
      continue;
    }
    if (trace.tool_name === "run_readonly_sql") {
      parsed = normalizeReadonlySqlRows(parsed);
    }
    collectMessageEvidenceRows(parsed, {
      toolName: trace.tool_name,
      fallbackChatId,
      scopedChatIds,
      seen,
      out,
      max,
    });
    if (out.length >= max) {
      break;
    }
  }
  return out;
}

function normalizeReadonlySqlRows(node) {
  if (!node || typeof node !== "object" || Array.isArray(node)) {
    return node;
  }
  const columns = Array.isArray(node.columns)
    ? node.columns.map((v) => String(v))
    : null;
  const rows = Array.isArray(node.rows) ? node.rows : null;
  if (!columns || !rows) {
    return node;
  }
  const normalizedRows = rows.map((row) => {
    if (!Array.isArray(row)) {
      return row;
    }
    const mapped = {};
    for (let idx = 0; idx < columns.length; idx += 1) {
      mapped[columns[idx]] = row[idx];
    }
    return mapped;
  });
  return {
    ...node,
    rows: normalizedRows,
  };
}

function collectMessageEvidenceRows(node, state) {
  const { fallbackChatId, scopedChatIds, seen, out, max } = state;
  if (!node || out.length >= max) {
    return;
  }
  const queue = [{ value: node, inheritedChatId: null }];
  while (queue.length > 0 && out.length < max) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    const value = current.value;
    const inheritedChatId = current.inheritedChatId;
    if (Array.isArray(value)) {
      for (const item of value) {
        queue.push({ value: item, inheritedChatId });
      }
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const nodeChatId = firstFiniteInt(value.chat_id, value.chatId);
    const effectiveChatId = Number.isFinite(nodeChatId)
      ? nodeChatId
      : inheritedChatId;
    if (isMessageEvidenceNode(value)) {
      const rowid = firstFiniteInt(
        value.rowid,
        value.ROWID,
        value.message_rowid,
      );
      const chatId = Number.isFinite(effectiveChatId)
        ? effectiveChatId
        : fallbackChatId;
      if (
        Number.isFinite(rowid) &&
        Number.isFinite(chatId) &&
        isInScope(chatId, scopedChatIds)
      ) {
        const key = `${chatId}:${rowid}`;
        if (!seen.has(key)) {
          seen.add(key);
          const messageText =
            typeof value.text === "string"
              ? value.text
              : typeof value.message_text === "string"
                ? value.message_text
                : null;
          out.push({
            chat_id: chatId,
            rowid,
            label: `rowid ${rowid}`,
            chat_label: asOptionalString(value.chat_label),
            sender: asOptionalString(value.sender),
            date: asOptionalString(value.date_iso, value.date),
            message_text: messageText,
            reason: messageText ? compact(messageText, 80) : undefined,
          });
        }
      }
    }
    for (const [key, child] of Object.entries(value)) {
      if (!isEvidenceContainerKey(key)) {
        continue;
      }
      queue.push({ value: child, inheritedChatId: effectiveChatId });
    }
  }
}

function isEvidenceContainerKey(key) {
  const normalized = String(key || "").toLowerCase();
  return (
    normalized === "results" ||
    normalized === "messages" ||
    normalized === "rows" ||
    normalized === "items" ||
    normalized === "data"
  );
}

function isMessageEvidenceNode(node) {
  if (!node || typeof node !== "object") {
    return false;
  }
  const rowid = firstFiniteInt(node.rowid, node.ROWID, node.message_rowid);
  if (!Number.isFinite(rowid)) {
    return false;
  }
  if (
    typeof node.guid === "string" ||
    typeof node.date === "string" ||
    typeof node.date_iso === "string" ||
    typeof node.message_text === "string" ||
    typeof node.sender === "string"
  ) {
    return true;
  }
  if (typeof node.text === "string") {
    return (
      !("filename" in node) &&
      !("mime_type" in node) &&
      !("transfer_name" in node) &&
      !("reaction_type" in node)
    );
  }
  return false;
}

function validateCitationIntegrity({
  text,
  citations,
  toolTraces,
  scopedChatIds,
}) {
  const normalizedText = String(text || "").trim();
  if (/\browid:\d+\b/i.test(normalizedText)) {
    return { ok: false, reason: "non-canonical citation token (rowid:...)" };
  }
  const inlineRefs = extractInlineCitationRefs(normalizedText);
  const citationRows = dedupeCitationRows(citations);
  const citationByKey = new Map();
  for (const citation of citationRows) {
    if (!isInScope(citation.chat_id, scopedChatIds)) {
      return {
        ok: false,
        reason: `citation out of scope (${citation.chat_id}:${citation.rowid})`,
      };
    }
    citationByKey.set(`${citation.chat_id}:${citation.rowid}`, citation);
  }

  const evidenceRows = collectEvidenceCitations({
    toolTraces,
    fallbackChatId: null,
    scopedChatIds,
    max: 512,
  });
  const evidenceKeys = new Set(
    evidenceRows.map((item) => `${item.chat_id}:${item.rowid}`),
  );

  for (const citation of citationRows) {
    const key = `${citation.chat_id}:${citation.rowid}`;
    if (!evidenceKeys.has(key)) {
      return {
        ok: false,
        reason: `citation not backed by tool evidence (${key})`,
      };
    }
  }

  for (const ref of inlineRefs) {
    const key = `${ref.chatId}:${ref.rowid}`;
    if (!citationByKey.has(key)) {
      return { ok: false, reason: `missing citation for ${key}` };
    }
  }

  return { ok: true };
}

function validatePresentationQuality(text) {
  return findPresentationIssue(text);
}

function dedupeCitationRows(citations) {
  const out = [];
  const seen = new Set();
  for (const citation of citations || []) {
    const rowid = toInt(citation?.rowid);
    const chatId = toInt(citation?.chat_id);
    if (!Number.isFinite(rowid) || !Number.isFinite(chatId)) {
      continue;
    }
    const key = `${chatId}:${rowid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({
      ...citation,
      rowid,
      chat_id: chatId,
    });
  }
  return out;
}

function extractInlineRowids(text) {
  const out = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(/\bcite:\d+:(\d+)\b/gi)) {
    const rowid = toInt(match[1]);
    if (!Number.isFinite(rowid) || seen.has(rowid)) {
      continue;
    }
    seen.add(rowid);
    out.push(rowid);
  }
  return out;
}

function extractInlineCitationRefs(text) {
  const refs = [];
  const seen = new Set();
  const source = String(text || "");
  for (const match of source.matchAll(/\bcite:(\d+):(\d+)\b/gi)) {
    const chatId = toInt(match[1]);
    const rowid = toInt(match[2]);
    if (!Number.isFinite(chatId) || !Number.isFinite(rowid)) {
      continue;
    }
    const key = `${chatId}:${rowid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ chatId, rowid });
  }
  return refs;
}

function extractPreferredCitationRefs(text) {
  const refs = [...extractInlineCitationRefs(text)];
  const seenRowids = new Set(refs.map((ref) => ref.rowid));
  for (const rowid of extractInlineRowids(text)) {
    if (seenRowids.has(rowid)) {
      continue;
    }
    seenRowids.add(rowid);
    refs.push({ chatId: NaN, rowid });
  }
  return refs;
}

function extractFactualUnits(text) {
  const units = [];
  const lines = String(text || "")
    .replace(/```[\s\S]*?```/g, " ")
    .split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    if (/^[-*]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      units.push(trimmed);
      continue;
    }
    const sentences = trimmed
      .split(/(?<=[.!?])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (sentences.length === 0) {
      units.push(trimmed);
      continue;
    }
    units.push(...sentences);
  }
  return units;
}

function hasInlineCitation(text) {
  return /\bcite:\d+:\d+\b/i.test(String(text || ""));
}

function isLikelyFactualUnit(unit) {
  const text = String(unit || "").trim();
  if (!text) {
    return false;
  }
  if (
    /\b(i cannot verify|can't verify|unable to verify|insufficient evidence|need a narrower query|please @mention)\b/i.test(
      text,
    )
  ) {
    return false;
  }
  if (hasInlineCitation(text)) {
    return true;
  }
  return /\b((19|20)\d{2}|jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|latest|recent|last|first|earliest|sent|said|mentioned|talked|found|results?|total|count)\b/i.test(
    text,
  );
}

function isInScope(chatId, scopedChatIds) {
  if (!Number.isFinite(chatId)) {
    return false;
  }
  if (!Array.isArray(scopedChatIds) || scopedChatIds.length === 0) {
    return true;
  }
  return scopedChatIds.includes(chatId);
}

function stripUnresolvedInlineCitations(text, citations) {
  const validKeys = new Set(
    (citations || [])
      .map((citation) => {
        const chatId = toInt(citation?.chat_id);
        const rowid = toInt(citation?.rowid);
        if (!Number.isFinite(chatId) || !Number.isFinite(rowid)) {
          return null;
        }
        return `${chatId}:${rowid}`;
      })
      .filter(Boolean),
  );
  const source = String(text || "");
  const withoutInvalidBracketed = source.replace(
    /\[\s*cite:(\d+):(\d+)\s*\]/gi,
    (full, c, r) => {
      const key = `${Number(c)}:${Number(r)}`;
      return validKeys.has(key) ? `[cite:${Number(c)}:${Number(r)}]` : "";
    },
  );
  return withoutInvalidBracketed.replace(
    /\bcite:(\d+):(\d+)\b/gi,
    (full, c, r) => {
      const key = `${Number(c)}:${Number(r)}`;
      return validKeys.has(key) ? full : "";
    },
  );
}

function canonicalizeCitationTokens(text, citations) {
  const rowsByRowid = new Map();
  for (const citation of citations || []) {
    const rowid = toInt(citation?.rowid);
    const chatId = toInt(citation?.chat_id);
    if (!Number.isFinite(rowid) || !Number.isFinite(chatId)) {
      continue;
    }
    const current = rowsByRowid.get(rowid) ?? [];
    current.push({ chatId, rowid });
    rowsByRowid.set(rowid, current);
  }
  const usage = new Map();
  return String(text || "").replace(/\browid:(\d+)\b/gi, (_match, rawRowid) => {
    const rowid = toInt(rawRowid);
    if (!Number.isFinite(rowid)) {
      return _match;
    }
    const candidates = rowsByRowid.get(rowid) ?? [];
    if (candidates.length === 0) {
      return _match;
    }
    const idx = usage.get(rowid) ?? 0;
    const chosen = candidates[Math.min(idx, candidates.length - 1)];
    usage.set(rowid, idx + 1);
    return `cite:${chosen.chatId}:${chosen.rowid}`;
  });
}

function findPresentationIssue(text) {
  const normalized = String(text || "");
  if (
    /\bchat[_\s-]*id\b/i.test(normalized) ||
    /\bchat\s*#?\s*\d+\b/i.test(normalized)
  ) {
    return "response includes internal chat identifiers";
  }
  if (/\b\d+(?:\.\d+)?e\+\d+\b/i.test(normalized)) {
    return "response includes raw scientific-notation timestamp values";
  }
  if (/\b\d{15,}\b/.test(normalized)) {
    return "response includes raw database timestamp values";
  }
  if (
    /\b(timestamp format|cannot be determined with.*timestamp)\b/i.test(
      normalized,
    )
  ) {
    return "response defers timestamp interpretation instead of using human-readable dates";
  }
  return null;
}

function firstFiniteInt(...values) {
  for (const value of values) {
    const n = toInt(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return NaN;
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return NaN;
  }
  return Math.trunc(n);
}

function asOptionalString(...values) {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return null;
}

function compact(value, max) {
  const normalized = String(value).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function normalizeChatContext(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const chatId = Number(value.chat_id);
  if (!isValidChatId(chatId)) {
    return null;
  }
  const label = String(value.label || "").trim() || "Conversation";
  const participants = Array.isArray(value.participants)
    ? value.participants.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  return { chat_id: chatId, label, participants };
}

function describeChatContext(context) {
  const people =
    context.participants.length > 0
      ? context.participants.join(", ")
      : context.label;
  return `a conversation between you and ${people}`;
}

function sanitizePromptText(text) {
  return text
    .replace(/\browid:\d+\b/gi, "citation")
    .replace(/\bchat[_\s-]*id[:=]?\s*\d+\b/gi, "conversation")
    .replace(/\bchat\s+#?\d+\b/gi, "conversation");
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeConversationToken(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isValidChatId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function shouldPrefetchRecentMessages(userMessage, scopedChatIds) {
  if (!Array.isArray(scopedChatIds) || scopedChatIds.length !== 1) {
    return false;
  }
  const normalized = String(userMessage || "").toLowerCase();
  if (!/\b(latest|recent|last)\b/.test(normalized)) {
    return false;
  }
  return /\b(message|messages|chat|chats)\b/.test(normalized);
}

function summarizeToolStart(toolName, input, chatContextById, toolTraces = []) {
  const payload = isRecord(input) ? input : {};
  if (toolName === "search_contacts") {
    const query = maybeQuoted(payload.q);
    return `Searching contacts${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "find_chats_by_contact") {
    const contact = asOptionalString(payload.name_or_handle);
    return `Looking up chats${contact ? ` for ${compact(contact, 48)}` : ""}`;
  }
  if (toolName === "search_messages_by_contact") {
    const contact = asOptionalString(payload.name_or_handle);
    const textFilter = maybeQuoted(payload.q);
    return `Searching messages${contact ? ` with ${compact(contact, 48)}` : ""}${textFilter ? ` for ${textFilter}` : ""}`;
  }
  if (toolName === "search_messages") {
    const query = maybeQuoted(payload.q);
    return `Searching messages${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "search_all_chats") {
    const query = maybeQuoted(payload.q);
    return `Searching all chats${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "get_recent_messages") {
    const chatLabel = lookupChatLabel(chatContextById, payload.chat_id);
    const sender = asOptionalString(payload.sender);
    return `Fetching recent messages${chatLabel ? ` in ${chatLabel}` : ""}${sender ? ` from ${compact(sender, 36)}` : ""}`;
  }
  if (toolName === "get_message_context") {
    const chatId = firstFiniteInt(payload.chat_id);
    const rowid = firstFiniteInt(payload.rowid);
    const hint = findMessageHintFromToolTraces(toolTraces, chatId, rowid);
    if (hint) {
      const snippet = asOptionalString(hint.text)
        ? `"${compact(asOptionalString(hint.text), 40)}"`
        : Number.isFinite(rowid)
          ? `message ${rowid}`
          : "that message";
      const parties = formatContextParties({
        hint,
        chatId,
        chatContextById,
      });
      return `Fetching context around ${snippet}${parties ? ` ${parties}` : ""}`;
    }
    return Number.isFinite(rowid)
      ? `Fetching context around message ${rowid}`
      : "Fetching nearby message context";
  }
  if (toolName === "search_timeline") {
    const query = maybeQuoted(payload.q);
    return `Searching timeline${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "timeline_overview") {
    return "Checking timeline index status";
  }
  if (toolName === "run_readonly_sql") {
    return "Running a read-only SQL query";
  }
  return null;
}

function summarizeToolFinish(toolName, input, output) {
  const payload = isRecord(output) ? output : {};
  const total = firstFiniteInt(
    payload.total,
    Array.isArray(payload.results) ? payload.results.length : NaN,
  );

  if (toolName === "search_contacts") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length === 1) {
      const person = asOptionalString(
        results[0]?.display_name,
        results[0]?.handle,
      );
      return person
        ? `Found 1 contact: ${compact(person, 56)}`
        : "Found 1 contact";
    }
    return Number.isFinite(total)
      ? `Found ${total} contacts`
      : "Contact search complete";
  }

  if (toolName === "find_chats_by_contact") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    if (results.length === 1) {
      const label = asOptionalString(results[0]?.label);
      return label ? `Found 1 chat: ${compact(label, 64)}` : "Found 1 chat";
    }
    return Number.isFinite(total)
      ? `Found ${total} chats`
      : "Chat lookup complete";
  }

  if (
    toolName === "search_messages_by_contact" ||
    toolName === "search_messages"
  ) {
    return Number.isFinite(total)
      ? `Found ${total} messages`
      : "Message search complete";
  }

  if (toolName === "search_all_chats") {
    return Number.isFinite(total)
      ? `Found ${total} messages across chats`
      : "Cross-chat search complete";
  }

  if (toolName === "get_recent_messages") {
    const results = Array.isArray(payload.results) ? payload.results : [];
    const range = summarizeDateRange(results);
    const count = Number.isFinite(total) ? total : results.length;
    if (!count) {
      return "Retrieved 0 recent messages";
    }
    return range
      ? `Retrieved ${count} recent messages from ${range}`
      : `Retrieved ${count} recent messages`;
  }

  if (toolName === "get_message_context") {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const range = summarizeDateRange(messages);
    const count = messages.length;
    if (!count) {
      return "Loaded 0 nearby messages";
    }
    return range
      ? `Loaded ${count} nearby messages from ${range}`
      : `Loaded ${count} nearby messages`;
  }

  if (toolName === "search_timeline") {
    const nodeCount = firstFiniteInt(
      payload.total,
      Array.isArray(payload.nodes) ? payload.nodes.length : NaN,
    );
    return Number.isFinite(nodeCount)
      ? `Found ${nodeCount} timeline matches`
      : "Timeline search complete";
  }

  if (toolName === "timeline_overview") {
    const health = asOptionalString(payload.index_health);
    const latest = asOptionalString(
      payload.latest_ts,
      payload.last_successful_run_at,
    );
    if (health && latest) {
      return `Timeline status: ${health}, latest at ${formatShortDate(latest)}`;
    }
    if (health) {
      return `Timeline status: ${health}`;
    }
    return "Timeline status check complete";
  }

  if (toolName === "run_readonly_sql") {
    const capped = payload.capped === true;
    const limit = firstFiniteInt(payload.limit);
    if (Number.isFinite(total)) {
      if (capped && Number.isFinite(limit)) {
        return `Returned ${total} message rows (capped at ${limit})`;
      }
      return `Returned ${total} message rows`;
    }
    return "Read-only SQL complete";
  }

  return null;
}

function maybeQuoted(value) {
  const text = asOptionalString(value);
  if (!text) {
    return null;
  }
  return `"${compact(text, 48)}"`;
}

function lookupChatLabel(chatContextById, chatId) {
  const id = firstFiniteInt(chatId);
  if (!Number.isFinite(id) || !(chatContextById instanceof Map)) {
    return null;
  }
  const context = chatContextById.get(id);
  if (!context) {
    return null;
  }
  return asOptionalString(context.label);
}

function summarizeDateRange(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }
  const parsed = rows
    .map((row) => extractMessageDate(row))
    .filter(
      (value) => value instanceof Date && Number.isFinite(value.getTime()),
    );
  if (parsed.length === 0) {
    return null;
  }
  parsed.sort((a, b) => a.getTime() - b.getTime());
  const first = parsed[0];
  const last = parsed[parsed.length - 1];
  if (!first || !last) {
    return null;
  }
  if (first.getTime() === last.getTime()) {
    return formatShortDate(first);
  }
  return `${formatShortDate(first)} to ${formatShortDate(last)}`;
}

function extractMessageDate(row) {
  if (!isRecord(row)) {
    return null;
  }
  const raw = asOptionalString(
    row.date,
    row.date_iso,
    row.date_human,
    row.start_ts,
    row.end_ts,
  );
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  if (Number.isFinite(parsed.getTime())) {
    return parsed;
  }
  return null;
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return typeof value === "string" ? value : String(value);
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function isRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function findMessageHintFromToolTraces(toolTraces, chatId, rowid) {
  if (!Number.isFinite(rowid) || !Array.isArray(toolTraces)) {
    return null;
  }
  for (let idx = toolTraces.length - 1; idx >= 0; idx -= 1) {
    const trace = toolTraces[idx];
    if (!trace || typeof trace.output !== "string") {
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(trace.output);
    } catch {
      continue;
    }
    const candidate = findMessageHintInPayload(parsed, chatId, rowid);
    if (candidate) {
      return candidate;
    }
  }
  return null;
}

function findMessageHintInPayload(payload, chatId, rowid) {
  if (!payload) {
    return null;
  }
  const maybeArrays = [];
  if (Array.isArray(payload)) {
    maybeArrays.push(payload);
  }
  if (isRecord(payload)) {
    if (Array.isArray(payload.results)) {
      maybeArrays.push(payload.results);
    }
    if (Array.isArray(payload.messages)) {
      maybeArrays.push(payload.messages);
    }
  }

  for (const rows of maybeArrays) {
    for (const row of rows) {
      if (!isRecord(row)) {
        continue;
      }
      const rowRowid = firstFiniteInt(
        row.rowid,
        row.ROWID,
        row.message_id,
        row.message_rowid,
      );
      if (!Number.isFinite(rowRowid) || rowRowid !== rowid) {
        continue;
      }
      const rowChatId = firstFiniteInt(row.chat_id, row.chatId);
      if (
        Number.isFinite(chatId) &&
        Number.isFinite(rowChatId) &&
        rowChatId !== chatId
      ) {
        continue;
      }
      return {
        rowid: rowRowid,
        chat_id: Number.isFinite(rowChatId)
          ? rowChatId
          : Number.isFinite(chatId)
            ? chatId
            : NaN,
        text: asOptionalString(row.text),
        sender: asOptionalString(row.sender),
        is_from_me: row.is_from_me === true,
      };
    }
  }
  return null;
}

function formatContextParties({ hint, chatId, chatContextById }) {
  const from = hint.is_from_me
    ? "You"
    : asOptionalString(hint.sender) || "Unknown sender";
  const context = resolveChatContext(chatContextById, hint.chat_id, chatId);
  if (hint.is_from_me) {
    const recipients = context?.participants?.length
      ? compact(context.participants.join(", "), 44)
      : "conversation";
    return `from ${from} to ${recipients}`;
  }
  return `from ${from} to You`;
}

function resolveChatContext(chatContextById, ...candidateIds) {
  if (!(chatContextById instanceof Map)) {
    return null;
  }
  for (const idValue of candidateIds) {
    const id = firstFiniteInt(idValue);
    if (!Number.isFinite(id)) {
      continue;
    }
    const found = chatContextById.get(id);
    if (found) {
      return found;
    }
  }
  return null;
}

function emit(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  try {
    writeSync(1, line);
  } catch {
    debugLog("stdout-write-fallback", {
      payload_type: payload?.type ?? null,
      line_len: line.length,
    });
    process.stdout.write(line);
  }
}

function emitStreamEvent(event) {
  emit({ type: "stream_event", event });
}
