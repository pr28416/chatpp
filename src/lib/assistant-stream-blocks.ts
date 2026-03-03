import type { AssistantDisplayBlock, AssistantProcessingEvent } from "@/lib/types";

export function buildDisplayBlocksFromEvents(
  events: AssistantProcessingEvent[],
  messageId: string,
  finalText?: string,
): AssistantDisplayBlock[] {
  let blocks: AssistantDisplayBlock[] = [];
  for (const event of events) {
    blocks = appendEventToDisplayBlocks(blocks, event, messageId);
  }
  if (finalText) {
    blocks = syncDisplayBlocksWithFinalText(blocks, finalText, messageId);
  }
  return blocks;
}

export function appendEventToDisplayBlocks(
  previous: AssistantDisplayBlock[],
  event: AssistantProcessingEvent,
  messageId: string,
): AssistantDisplayBlock[] {
  if (event.kind === "text-delta" && event.text) {
    return appendStreamingDelta(previous, "text", event.text, messageId, event.at_ms);
  }

  if (event.kind === "reasoning-delta" && event.text) {
    return appendStreamingDelta(previous, "reasoning", event.text, messageId, event.at_ms);
  }

  if (event.kind === "tool-start") {
    return [
      ...previous,
      {
        id: makeBlockId(messageId, "tool_call", event.tool_call_id ?? String(event.at_ms), previous.length),
        kind: "tool_call",
        text: describeToolCall(event.tool_name),
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
      },
    ];
  }

  if (event.kind === "tool-finish") {
    return [
      ...previous,
      {
        id: makeBlockId(messageId, "tool_result", event.tool_call_id ?? String(event.at_ms), previous.length),
        kind: "tool_result",
        text:
          event.success === false
            ? `Tool failed: ${friendlyToolName(event.tool_name)}`
            : `${friendlyToolName(event.tool_name)} complete`,
        tool_name: event.tool_name,
        tool_call_id: event.tool_call_id,
        success: event.success,
        duration_ms: event.duration_ms,
      },
    ];
  }

  if (event.kind === "run-error") {
    return [
      ...previous,
      {
        id: makeBlockId(messageId, "error", String(event.at_ms), previous.length),
        kind: "error",
        text: event.text ? `Error: ${event.text}` : "Error: Unknown error",
      },
    ];
  }

  return previous;
}

export function syncDisplayBlocksWithFinalText(
  previous: AssistantDisplayBlock[],
  finalText: string,
  messageId: string,
): AssistantDisplayBlock[] {
  if (!finalText) {
    return previous;
  }
  const streamedText = previous
    .filter((block) => block.kind === "text")
    .map((block) => block.text ?? "")
    .join("");

  if (streamedText === finalText || streamedText.trim() === finalText.trim()) {
    return previous;
  }

  if (finalText.startsWith(streamedText)) {
    const remainder = finalText.slice(streamedText.length);
    if (!remainder) {
      return previous;
    }
    return appendStreamingDelta(previous, "text", remainder, messageId, Date.now());
  }

  return previous;
}

function appendStreamingDelta(
  previous: AssistantDisplayBlock[],
  kind: "text" | "reasoning",
  delta: string,
  messageId: string,
  atMs: number,
): AssistantDisplayBlock[] {
  const last = previous[previous.length - 1];
  if (last && last.kind === kind) {
    const merged = `${last.text ?? ""}${delta}`;
    return [
      ...previous.slice(0, -1),
      {
        ...last,
        text: merged,
      },
    ];
  }
  return [
    ...previous,
    {
      id: makeBlockId(messageId, kind, String(atMs), previous.length),
      kind,
      text: delta,
    },
  ];
}

function makeBlockId(
  messageId: string,
  kind: AssistantDisplayBlock["kind"],
  token: string,
  index: number,
): string {
  return `${messageId}:${index}:${kind}:${token}`;
}

function describeToolCall(toolName?: string): string {
  return `Running ${friendlyToolName(toolName)}`;
}

function friendlyToolName(toolName?: string): string {
  switch (toolName) {
    case "search_messages":
      return "message search";
    case "get_message_context":
      return "message context fetch";
    case "search_timeline":
      return "timeline search";
    case "timeline_overview":
      return "timeline status check";
    case "run_readonly_sql":
      return "read-only SQL";
    default:
      return toolName ?? "tool";
  }
}
