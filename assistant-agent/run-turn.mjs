import readline from 'node:readline';
import { ToolLoopAgent, stepCountIs, tool } from 'ai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { xai } from '@ai-sdk/xai';
import { z } from 'zod';

const SYSTEM_PROMPT = [
  'You are an investigative assistant for a local iMessage archive.',
  'Always use tools for factual claims about messages/timeline/SQL data.',
  'If at least one conversation is in scope and the user asks for message/timeline facts, you must call at least one tool before the final answer.',
  'Do not claim a conversation cannot be found until you have tried a relevant tool call.',
  'Use multiple tool calls when needed and cross-check evidence before concluding.',
  'For latest/last/recent message requests, prefer get_recent_messages instead of text search.',
  'If more than one conversation is in scope, always specify the target conversation when calling tools.',
  'Conversation labels can be user-defined aliases and may not match participant names.',
  'Treat provided conversation labels and @mentions as canonical references for tool selection.',
  'If evidence is insufficient, say so clearly.',
  'Keep answers concise and practical.',
  'Never use ambiguous pronouns like "they" without naming who spoke.',
  'When summarizing a message, always attribute it to a specific speaker label (for example: "You", "Alex", "Unknown sender").',
  'Do not mention chat IDs or row IDs in prose.',
  'When useful, add inline evidence markers in the form [rowid:12345]; these markers are rendered as UI citations.',
].join(' ');

let currentRun = null;
const pendingToolCalls = new Map();
const SUPPORTED_MODELS_BY_PROVIDER = {
  openai: new Set(['gpt-5.2', 'gpt-5.2-pro', 'gpt-5-mini', 'gpt-5-nano']),
  anthropic: new Set(['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4-5']),
  google: new Set([
    'gemini-2.5-flash-lite',
    'gemini-2.5-flash',
    'gemini-2.5-pro',
  ]),
  xai: new Set([
    'grok-4-latest',
    'grok-4-0709',
    'grok-4-fast-reasoning',
    'grok-4-fast-non-reasoning',
  ]),
};

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', async (line) => {
  if (!line.trim()) {
    return;
  }

  let payload;
  try {
    payload = JSON.parse(line);
  } catch {
    emit({ type: 'error', message: 'Invalid JSON input' });
    return;
  }

  if (payload.type === 'tool_result') {
    const waiter = pendingToolCalls.get(payload.id);
    if (!waiter) {
      return;
    }
    pendingToolCalls.delete(payload.id);
    if (payload.ok) {
      waiter.resolve(payload.result);
    } else {
      waiter.reject(new Error(payload.error || 'Tool call failed'));
    }
    return;
  }

  if (payload.type !== 'run') {
    emit({ type: 'error', message: `Unsupported message type: ${payload.type}` });
    return;
  }

  if (currentRun) {
    emit({ type: 'error', message: 'Run already in progress' });
    return;
  }

  currentRun = runTurn(payload.payload)
    .catch((err) => {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    })
    .finally(() => {
      currentRun = null;
      rl.close();
    });
});

async function runTurn(payload) {
  const selectedChatId = Number.isFinite(Number(payload.selected_chat_id))
    ? Number(payload.selected_chat_id)
    : null;
  const mentionedChatIds = Array.isArray(payload.mentioned_chat_ids)
    ? payload.mentioned_chat_ids.map((v) => Number(v)).filter(Number.isFinite)
    : [];
  const conversation = Array.isArray(payload.conversation) ? payload.conversation : [];
  const userMessage = String(payload.user_message || '').trim();
  const modelProvider = String(payload.model_provider || 'openai').trim().toLowerCase();
  const modelId = String(payload.model_id || 'gpt-5-mini').trim();

  if (!userMessage) {
    throw new Error('user_message is required');
  }
  const supportedModels = SUPPORTED_MODELS_BY_PROVIDER[modelProvider];
  if (!supportedModels) {
    throw new Error(`Unsupported model provider: ${modelProvider}`);
  }
  if (!supportedModels.has(modelId)) {
    throw new Error(`Unsupported model for provider ${modelProvider}: ${modelId}`);
  }

  ensureProviderKey(modelProvider);

  const startedAt = Date.now();
  const nowMs = () => Math.max(0, Date.now() - startedAt);
  emitStreamEvent({ kind: 'run-start', at_ms: 0 });

  const scopedChatIds = Array.from(
    new Set([
      ...(selectedChatId == null ? [] : [selectedChatId]),
      ...mentionedChatIds,
    ]),
  );
  const selectedChatContext = normalizeChatContext(payload.selected_chat_context);
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
    ? mentionedChatContexts.map((ctx) => describeChatContext(ctx)).join('; ')
    : 'None.';
  const toolTraceLog = [];
  let preflightEvidenceText = '';

  const resolveScopedChatId = (input = {}) => {
    if (Number.isFinite(input.chat_id)) {
      const requested = Number(input.chat_id);
      if (scopedChatIds.includes(requested)) {
        return requested;
      }
      throw new Error('Requested conversation is outside the allowed scope');
    }

    const conversation = typeof input.conversation === 'string' ? input.conversation.trim() : '';
    if (!conversation || /^current$/i.test(conversation)) {
      if (scopedChatIds.length === 0) {
        throw new Error('No conversation in scope. Use @ in the composer to mention at least one chat.');
      }
      if (scopedChatIds.length > 1) {
        throw new Error('Multiple conversations are in scope. Specify one by name or chat_id.');
      }
      return scopedChatIds[0];
    }

    const normalizedConversation = normalizeConversationToken(conversation);
    for (const context of chatContextById.values()) {
      const label = normalizeConversationToken(context.label);
      const participants = normalizeConversationToken(context.participants.join(' '));
      if (label.includes(normalizedConversation) || participants.includes(normalizedConversation)) {
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
      ? 'Tool scope is empty until the user @mentions at least one conversation.'
      : scopedChatIds.length === 1
        ? 'Tool scope is limited to one conversation.'
        : `Tool scope is limited to ${scopedChatIds.length} conversations.`;

  const bridgeTool = async (toolName, input) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    emit({
      type: 'tool_call',
      id,
      tool_name: toolName,
      args: input,
    });

    const toolStartedAt = Date.now();
    emitStreamEvent({
      kind: 'tool-start',
      at_ms: nowMs(),
      tool_call_id: id,
      tool_name: toolName,
      input_preview: compact(safeStringify(input), 180),
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

      emitStreamEvent({
        kind: 'tool-finish',
        at_ms: nowMs(),
        tool_call_id: id,
        tool_name: toolName,
        success: true,
        duration_ms: Date.now() - toolStartedAt,
        output_preview: compact(safeStringify(output), 220),
      });

      return output;
    } catch (err) {
      emitStreamEvent({
        kind: 'tool-finish',
        at_ms: nowMs(),
        tool_call_id: id,
        tool_name: toolName,
        success: false,
        duration_ms: Date.now() - toolStartedAt,
        output_preview: compact(err instanceof Error ? err.message : String(err), 220),
      });
      throw err;
    }
  };

  if (shouldPrefetchRecentMessages(userMessage, scopedChatIds)) {
    try {
      const prefetched = await bridgeTool('get_recent_messages', {
        chat_id: scopedChatIds[0],
        limit: 12,
      });
      preflightEvidenceText = compact(safeStringify(prefetched), 1800);
    } catch {
      preflightEvidenceText = '';
    }
  }

  const agent = new ToolLoopAgent({
    model: buildModel(modelProvider, modelId),
    instructions: SYSTEM_PROMPT,
    stopWhen: stepCountIs(16),
    tools: {
      search_messages: tool({
        description: 'Search messages in a conversation. Use this first for fact-finding.',
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          q: z.string().min(1),
          limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async (input) =>
          bridgeTool('search_messages', {
            chat_id: resolveScopedChatId(input),
            q: input.q,
            limit: input.limit,
          }),
      }),
      get_recent_messages: tool({
        description:
          'Fetch newest messages in a conversation, optionally filtered by sender label/handle.',
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          sender: z.string().optional(),
          offset: z.number().int().min(0).max(5000).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        }),
        execute: async (input) =>
          bridgeTool('get_recent_messages', {
            chat_id: resolveScopedChatId(input),
            sender: input.sender,
            offset: input.offset,
            limit: input.limit,
          }),
      }),
      get_message_context: tool({
        description: 'Fetch message window around a rowid in a conversation.',
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          rowid: z.number().int(),
          window: z.number().int().min(10).max(120).optional(),
        }),
        execute: async (input) =>
          bridgeTool('get_message_context', {
            chat_id: resolveScopedChatId(input),
            rowid: input.rowid,
            window: input.window,
          }),
      }),
      search_timeline: tool({
        description: 'Search AI-generated timeline nodes in a conversation.',
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
          q: z.string().min(1),
          limit: z.number().int().min(1).max(64).optional(),
        }),
        execute: async (input) =>
          bridgeTool('search_timeline', {
            chat_id: resolveScopedChatId(input),
            q: input.q,
            limit: input.limit,
          }),
      }),
      timeline_overview: tool({
        description: 'Get timeline index status/health for a conversation.',
        inputSchema: z.object({
          conversation: z.string().optional(),
          chat_id: z.number().int().optional(),
        }),
        execute: async (input) =>
          bridgeTool('timeline_overview', {
            chat_id: resolveScopedChatId(input),
          }),
      }),
      run_readonly_sql: tool({
        description: 'Run a bespoke read-only SQL query against chat or timeline DB.',
        inputSchema: z.object({
          db: z.enum(['chat', 'timeline']).optional(),
          sql: z.string().min(1),
          params: z
            .array(z.union([z.string(), z.number(), z.boolean(), z.null()]))
            .optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async (input) => bridgeTool('run_readonly_sql', input),
      }),
    },
  });

  const transcript = conversation
    .slice(-14)
    .map(
      (turn) =>
        `${turn.role?.toUpperCase() || 'USER'}: ${sanitizePromptText(String(turn.text || '').trim())}`,
    )
    .join('\n');
  const contextListText =
    Array.from(chatContextById.values())
      .map((ctx) => `- ${ctx.label} (participants: ${ctx.participants.join(', ') || 'n/a'})`)
      .join('\n') || '- none';

  const prompt = [
    selectedChatContext
      ? `Current conversation: ${describeChatContext(selectedChatContext)}.`
      : 'Current conversation: none selected.',
    `Referenced conversations: ${mentionedContextText}`,
    'Use conversation names and participants in your reasoning and response, not internal IDs.',
    'Reminder: a conversation label is not necessarily a participant name.',
    scopeDescription,
    scopedChatIds.length === 0
      ? 'If you need evidence, first ask the user to @mention a conversation before making factual claims.'
      : '',
    preflightEvidenceText
      ? `Pre-fetched recent messages evidence (JSON): ${preflightEvidenceText}`
      : '',
    'Available conversation references:',
    contextListText,
    transcript ? `Recent conversation:\n${transcript}` : '',
    `User request: ${userMessage}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let finalText = await streamResultToText(await agent.stream({ prompt }), nowMs);

  if (scopedChatIds.length > 0 && toolTraceLog.length === 0) {
    const fallbackPlan = buildRequiredToolFallback({
      userMessage,
      scopedChatIds,
      chatContextById,
    });
    emitStreamEvent({
      kind: 'policy-fallback-start',
      at_ms: nowMs(),
      text: `No model tool call detected. Running fallback: ${fallbackPlan.tool_name}.`,
    });
    const fallbackOutput = await bridgeTool(fallbackPlan.tool_name, fallbackPlan.input);
    const fallbackPrompt = [
      prompt,
      `Tool policy fallback reason: ${fallbackPlan.reason}.`,
      `Fallback evidence from ${fallbackPlan.tool_name}: ${compact(safeStringify(fallbackOutput), 2500)}`,
      'Now answer the user using this evidence. If multiple conversations are possible, explicitly ask for disambiguation.',
    ].join('\n\n');
    finalText = await streamResultToText(await agent.stream({ prompt: fallbackPrompt }), nowMs);
    emitStreamEvent({
      kind: 'policy-fallback-finish',
      at_ms: nowMs(),
      text: `Fallback completed using ${fallbackPlan.tool_name}.`,
    });
  }

  const durationMs = nowMs();
  emitStreamEvent({ kind: 'run-finish', at_ms: durationMs, duration_ms: durationMs });

  const citations = inferCitations(toolTraceLog, selectedChatId);
  emit({
    type: 'final',
    text: finalText.trim(),
    citations,
    tool_traces: toolTraceLog,
    duration_ms: durationMs,
  });
}

function extractDeltaText(part) {
  if (!part || typeof part !== 'object') {
    return '';
  }
  const candidates = [part.text, part.delta, part.value, part.content, part.outputText];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return '';
}

function isReasoningLikePart(type) {
  if (!type || typeof type !== 'string') {
    return false;
  }
  const normalized = type.toLowerCase();
  return normalized.includes('reasoning') && normalized.includes('delta');
}

function isTextLikePart(type) {
  if (!type || typeof type !== 'string') {
    return false;
  }
  const normalized = type.toLowerCase();
  if (normalized.includes('reasoning')) {
    return false;
  }
  return normalized.includes('text') && normalized.includes('delta');
}

async function streamResultToText(result, nowMs) {
  let streamedText = '';
  let stepIndex = -1;

  for await (const part of result.fullStream) {
    switch (part.type) {
      case 'start-step': {
        stepIndex += 1;
        emitStreamEvent({ kind: 'step-start', at_ms: nowMs(), step_index: stepIndex });
        break;
      }
      case 'finish-step': {
        emitStreamEvent({
          kind: 'step-finish',
          at_ms: nowMs(),
          step_index: stepIndex,
          finish_reason: part.finishReason,
        });
        break;
      }
      case 'reasoning-delta': {
        const reasoningText = extractDeltaText(part);
        if (reasoningText) {
          emitStreamEvent({ kind: 'reasoning-delta', at_ms: nowMs(), text: reasoningText });
        }
        break;
      }
      case 'text-delta': {
        const textDelta = extractDeltaText(part);
        if (textDelta) {
          streamedText += textDelta;
          emitStreamEvent({ kind: 'text-delta', at_ms: nowMs(), text: textDelta });
        }
        break;
      }
      case 'error': {
        emitStreamEvent({
          kind: 'run-error',
          at_ms: nowMs(),
          text: compact(String(part.error ?? 'Unknown stream error'), 200),
        });
        break;
      }
      default:
        if (isReasoningLikePart(part.type)) {
          const reasoningText = extractDeltaText(part);
          if (reasoningText) {
            emitStreamEvent({ kind: 'reasoning-delta', at_ms: nowMs(), text: reasoningText });
          }
          break;
        }
        if (isTextLikePart(part.type)) {
          const textDelta = extractDeltaText(part);
          if (textDelta) {
            streamedText += textDelta;
            emitStreamEvent({ kind: 'text-delta', at_ms: nowMs(), text: textDelta });
          }
        }
        break;
    }
  }

  return streamedText.trim();
}

function buildRequiredToolFallback({ userMessage, scopedChatIds, chatContextById }) {
  const normalizedMessage = normalizeConversationToken(userMessage);
  const explicitChatId = resolveChatFromMessageAliases(normalizedMessage, scopedChatIds, chatContextById);
  const targetChatId = explicitChatId ?? (scopedChatIds.length === 1 ? scopedChatIds[0] : scopedChatIds[0]);
  const latestLike = /\b(latest|recent|last|newest)\b/.test(normalizedMessage);
  const searchLike = /\b(search|find|contains|mention|mentions)\b/.test(normalizedMessage);

  if (latestLike) {
    return {
      tool_name: 'get_recent_messages',
      reason: 'latest/recent intent requires concrete evidence',
      input: {
        chat_id: targetChatId,
        limit: 12,
      },
    };
  }

  if (searchLike) {
    return {
      tool_name: 'search_messages',
      reason: 'search intent requires concrete evidence',
      input: {
        chat_id: targetChatId,
        q: extractSearchQuery(normalizedMessage) || normalizedMessage,
        limit: 80,
      },
    };
  }

  return {
    tool_name: 'get_recent_messages',
    reason: 'tool-required policy fallback',
    input: {
      chat_id: targetChatId,
      limit: 8,
    },
  };
}

function resolveChatFromMessageAliases(normalizedMessage, scopedChatIds, chatContextById) {
  const aliasTokens = Array.from(
    new Set(
      (String(normalizedMessage || '').match(/@([a-z0-9_][a-z0-9_\-]*)/gi) || [])
        .map((token) => normalizeConversationToken(token.replace(/^@+/, '')))
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
          `${context.label} ${context.participants.join(' ')}`,
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
  const match = String(normalizedMessage || '').match(/"([^"]+)"/);
  if (match && match[1]) {
    return match[1].trim();
  }
  return null;
}

function buildModel(provider, modelId) {
  const options = {
    parallelToolCalls: true,
    reasoningSummary: 'detailed',
  };
  switch (provider) {
    case 'openai':
      return openai(modelId, options);
    case 'anthropic':
      return anthropic(modelId, options);
    case 'google':
      return google(modelId, options);
    case 'xai':
      return xai(modelId, options);
    default:
      throw new Error(`Unsupported model provider: ${provider}`);
  }
}

function ensureProviderKey(provider) {
  const keyByProvider = {
    openai: 'OPENAI_API_KEY',
    anthropic: 'ANTHROPIC_API_KEY',
    google: 'GOOGLE_GENERATIVE_AI_API_KEY',
    xai: 'XAI_API_KEY',
  };
  const envVar = keyByProvider[provider];
  const value = envVar ? process.env[envVar] : '';
  if (!value || !String(value).trim()) {
    throw new Error(`${envVar} is required for ${provider} models`);
  }
}

function inferCitations(toolTraces, fallbackChatId) {
  const seen = new Set();
  const out = [];

  for (const trace of toolTraces) {
    let parsed;
    try {
      parsed = JSON.parse(trace.output);
    } catch {
      continue;
    }

    harvestRowids(parsed, fallbackChatId, seen, out, null);
    if (out.length >= 16) {
      break;
    }
  }

  return out;
}

function harvestRowids(node, fallbackChatId, seen, out, inheritedChatId) {
  if (!node || out.length >= 16) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      harvestRowids(item, fallbackChatId, seen, out, inheritedChatId);
      if (out.length >= 16) {
        return;
      }
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  const nodeChatId = toInt(node.chat_id);
  const effectiveInheritedChatId = Number.isFinite(nodeChatId) ? nodeChatId : inheritedChatId;
  const rowid = toInt(node.rowid);
  if (Number.isFinite(rowid)) {
    const chatId = Number.isFinite(effectiveInheritedChatId)
      ? effectiveInheritedChatId
      : fallbackChatId;
    if (!Number.isFinite(chatId)) {
      return;
    }
    const key = `${chatId}:${rowid}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        chat_id: chatId,
        rowid,
        label: `rowid ${rowid}`,
        chat_label: null,
        sender: null,
        date: null,
        message_text: typeof node.text === 'string' ? node.text : null,
        reason: typeof node.text === 'string' ? compact(node.text, 80) : undefined,
      });
    }
  }

  for (const value of Object.values(node)) {
    harvestRowids(value, fallbackChatId, seen, out, effectiveInheritedChatId);
    if (out.length >= 16) {
      return;
    }
  }
}

function toInt(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return NaN;
  }
  return Math.trunc(n);
}

function compact(value, max) {
  const normalized = String(value).replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function normalizeChatContext(value) {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const chatId = Number(value.chat_id);
  if (!Number.isFinite(chatId)) {
    return null;
  }
  const label = String(value.label || '').trim() || 'Conversation';
  const participants = Array.isArray(value.participants)
    ? value.participants.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  return { chat_id: chatId, label, participants };
}

function describeChatContext(context) {
  const people = context.participants.length > 0 ? context.participants.join(', ') : context.label;
  return `a conversation between you and ${people}`;
}

function sanitizePromptText(text) {
  return text
    .replace(/\browid:\d+\b/gi, 'citation')
    .replace(/\bchat[_\s-]*id[:=]?\s*\d+\b/gi, 'conversation')
    .replace(/\bchat\s+#?\d+\b/gi, 'conversation');
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeConversationToken(value) {
  return String(value || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function shouldPrefetchRecentMessages(userMessage, scopedChatIds) {
  if (!Array.isArray(scopedChatIds) || scopedChatIds.length !== 1) {
    return false;
  }
  const normalized = String(userMessage || '').toLowerCase();
  if (!/\b(latest|recent|last)\b/.test(normalized)) {
    return false;
  }
  return /\b(message|messages|chat|chats)\b/.test(normalized);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function emitStreamEvent(event) {
  emit({ type: 'stream_event', event });
}
