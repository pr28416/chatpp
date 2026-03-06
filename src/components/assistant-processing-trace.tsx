import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, ChevronDown, Sparkles } from "lucide-react";

import {
  AssistantToolCallPopover,
  renderToolStatusIcon,
} from "@/components/assistant-tool-call-popover";
import { formatToolFinishLabel, formatToolStartLabel } from "@/lib/assistant-tool-status";
import type { AssistantDisplayBlock, AssistantProcessingEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AssistantProcessingTraceProps {
  events: AssistantProcessingEvent[];
  streaming: boolean;
  durationMs?: number;
}

export function AssistantProcessingTrace({
  events,
  streaming,
  durationMs,
}: AssistantProcessingTraceProps) {
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    if (streaming) {
      setExpanded(true);
    } else {
      setExpanded(false);
    }
  }, [streaming]);

  const entries = React.useMemo(() => buildTraceEntries(events), [events]);
  const recent = React.useMemo(() => entries.slice(-3), [entries]);
  const visible = streaming ? recent : expanded ? entries : [];

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-border/70 bg-card/55 px-3 py-2">
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between gap-2 text-left"
      >
        <div className="text-xs text-muted-foreground">
          {streaming
            ? "Processing..."
            : `Reasoned for ${formatDuration(durationMs ?? events[events.length - 1]?.at_ms ?? 0)}`}
        </div>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {visible.length > 0 ? (
          <motion.div
            key={streaming ? "stream" : expanded ? "expanded" : "collapsed"}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="mt-2 space-y-1.5 overflow-hidden"
          >
            {visible.map((entry, idx) => {
              const opacity =
                streaming
                  ? [0.45, 0.72, 1][Math.max(0, idx - (visible.length - 3))] ?? 1
                  : 1;
              const row = (
                <motion.div
                  key={`${entry.id}-${idx}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className={cn(
                    "flex items-start gap-2 text-xs",
                    entry.tool?.tool_status === "error" && "opacity-70",
                  )}
                >
                  <span className="mt-0.5 text-muted-foreground">
                    {entry.icon === "tool" ? (
                      renderToolStatusIcon(entry.tool?.tool_status)
                    ) : entry.icon === "reasoning" ? (
                      <Brain className="h-3 w-3" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </span>
                  <span className="min-w-0 text-muted-foreground">
                    {entry.label}
                    {entry.icon === "tool" &&
                    entry.tool?.tool_status !== "running" &&
                    entry.tool?.duration_ms ? (
                      <> ({formatDuration(entry.tool.duration_ms)})</>
                    ) : null}
                  </span>
                </motion.div>
              );
              if (entry.icon !== "tool" || !entry.tool) {
                return row;
              }
              const block: AssistantDisplayBlock = {
                id: entry.id,
                kind: "tool_call",
                text: entry.label,
                tool_call_id: entry.tool.tool_call_id,
                tool_name: entry.tool.tool_name,
                tool_status: entry.tool.tool_status,
                duration_ms: entry.tool.duration_ms,
                tool_input_preview: entry.tool.input_preview,
                tool_output_preview: entry.tool.output_preview,
                tool_input_summary: entry.tool.input_summary,
                tool_output_summary: entry.tool.output_summary,
                success: entry.tool.success,
              };
              return (
                <AssistantToolCallPopover
                  key={`${entry.id}-${idx}`}
                  block={block}
                  chatById={new Map()}
                  onJumpToCitation={() => {}}
                >
                  <button type="button" className="w-full text-left">
                    {row}
                  </button>
                </AssistantToolCallPopover>
              );
            })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface TraceEntry {
  id: string;
  icon: "tool" | "reasoning" | "response";
  label: string;
  tool?: {
    tool_call_id?: string;
    tool_name?: string;
    tool_status: "running" | "success" | "error";
    duration_ms?: number;
    input_preview?: string;
    output_preview?: string;
    input_summary?: string;
    output_summary?: string;
    success?: boolean;
  };
}

function buildTraceEntries(events: AssistantProcessingEvent[]): TraceEntry[] {
  const entries: TraceEntry[] = [];

  for (const event of events) {
    if (event.kind === "reasoning-delta" && event.text) {
      upsertStreamingEntry(entries, `reasoning-${event.at_ms}`, "reasoning", event.text, "Reasoning");
      continue;
    }

    if (event.kind === "tool-start") {
      entries.push({
        id: `tool-start-${event.tool_call_id ?? event.at_ms}`,
        icon: "tool",
        label: formatToolStartLabel(event),
        tool: {
          tool_call_id: event.tool_call_id,
          tool_name: event.tool_name,
          tool_status: "running",
          input_preview: event.input_preview,
          input_summary: event.input_summary,
        },
      });
      continue;
    }

    if (event.kind === "tool-finish") {
      const index = findToolEntryIndex(entries, event.tool_call_id);
      if (index >= 0) {
        const current = entries[index];
        entries[index] = {
          ...current,
          id: `tool-${event.tool_call_id ?? event.at_ms}`,
          label: current.label,
          tool: {
            ...current.tool,
            tool_call_id: event.tool_call_id ?? current.tool?.tool_call_id,
            tool_name: event.tool_name ?? current.tool?.tool_name,
            tool_status: event.success === false ? "error" : "success",
            duration_ms: event.duration_ms,
            output_preview: event.output_preview,
            output_summary: event.output_summary,
            success: event.success,
          },
        };
      } else {
        entries.push({
          id: `tool-finish-${event.tool_call_id ?? event.at_ms}`,
          icon: "tool",
          label: formatToolFinishLabel(event),
          tool: {
            tool_call_id: event.tool_call_id,
            tool_name: event.tool_name,
            tool_status: event.success === false ? "error" : "success",
            duration_ms: event.duration_ms,
            output_preview: event.output_preview,
            output_summary: event.output_summary,
            success: event.success,
          },
        });
      }
      continue;
    }

    if (event.kind === "run-error") {
      entries.push({
        id: `error-${event.at_ms}`,
        icon: "response",
        label: `Error: ${compact(event.text ?? "Unknown error", 180)}`,
      });
    }
  }

  return entries;
}

function upsertStreamingEntry(
  entries: TraceEntry[],
  id: string,
  icon: TraceEntry["icon"],
  delta: string,
  prefix: string,
): void {
  const last = entries[entries.length - 1];
  if (last && last.icon === icon) {
    const previous = last.label.replace(/^[^:]+:\s*/, "");
    const merged = `${previous}${delta}`;
    entries[entries.length - 1] = {
      ...last,
      id,
      label: `${prefix}: ${compact(merged, 180)}`,
    };
    return;
  }
  entries.push({ id, icon, label: `${prefix}: ${compact(delta, 180)}` });
}

function findToolEntryIndex(entries: TraceEntry[], toolCallId?: string): number {
  if (!toolCallId) {
    return -1;
  }
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.icon !== "tool") {
      continue;
    }
    if (entry.tool?.tool_call_id !== toolCallId) {
      continue;
    }
    return i;
  }
  return -1;
}

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}
