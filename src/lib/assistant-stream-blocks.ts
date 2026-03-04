import type { AssistantDisplayBlock, AssistantProcessingEvent } from "@/lib/types";
import { formatToolFinishLabel, formatToolStartLabel } from "@/lib/assistant-tool-status";

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
  if (event.kind === "policy-fallback-start") {
    return [
      ...previous,
      {
        id: makeBlockId(messageId, "tool_call", `retry-${event.at_ms}`, previous.length),
        kind: "tool_call",
        text: event.text ?? "Revising answer with better evidence",
      },
    ];
  }

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
        text: formatToolStartLabel(event),
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
        text: formatToolFinishLabel(event),
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

  if (event.kind === "citation-warning" && event.text) {
    return [
      ...previous,
      {
        id: makeBlockId(messageId, "tool_result", `citation-${event.at_ms}`, previous.length),
        kind: "tool_result",
        text: compact(event.text, 180),
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

  return reconcileTextBlocksInPlace(previous, finalText, messageId);
}

function reconcileTextBlocksInPlace(
  previous: AssistantDisplayBlock[],
  finalText: string,
  messageId: string,
): AssistantDisplayBlock[] {
  const textIndices: number[] = [];
  for (let idx = 0; idx < previous.length; idx += 1) {
    if (previous[idx]?.kind === "text") {
      textIndices.push(idx);
    }
  }

  if (textIndices.length === 0) {
    return appendStreamingDelta(previous, "text", finalText, messageId, Date.now());
  }

  const sourceLengths = textIndices.map((index) => (previous[index]?.text ?? "").length);
  const textIndicesMap = new Map<number, number>();
  textIndices.forEach((index, slot) => {
    textIndicesMap.set(index, slot);
  });
  const pieces: string[] = [];
  let cursor = 0;
  for (let i = 0; i < textIndices.length; i += 1) {
    if (i === textIndices.length - 1) {
      pieces.push(finalText.slice(cursor));
      break;
    }
    const size = sourceLengths[i] ?? 0;
    if (size <= 0) {
      pieces.push("");
      continue;
    }
    pieces.push(finalText.slice(cursor, cursor + size));
    cursor += size;
  }

  const out = previous.map((block, index) => {
    if (block.kind !== "text") {
      return block;
    }
    const textSlot = textIndicesMap.get(index) ?? -1;
    const nextText = textSlot >= 0 ? pieces[textSlot] ?? "" : block.text ?? "";
    return {
      ...block,
      text: nextText,
    };
  });

  return out.filter((block) => block.kind !== "text" || (block.text ?? "").length > 0);
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

function compact(text: string, max: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}
