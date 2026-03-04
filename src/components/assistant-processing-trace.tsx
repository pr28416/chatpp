import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Brain, ChevronDown, Sparkles, Wrench } from "lucide-react";

import { formatToolFinishLabel, formatToolStartLabel } from "@/lib/assistant-tool-status";
import type { AssistantProcessingEvent } from "@/lib/types";
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
              const opacity = streaming ? [0.45, 0.72, 1][Math.max(0, idx - (visible.length - 3))] ?? 1 : 1;
              return (
                <motion.div
                  key={`${entry.id}-${idx}`}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity, y: 0 }}
                  transition={{ duration: 0.18 }}
                  className="flex items-start gap-2 text-xs"
                >
                  <span className="mt-0.5 text-muted-foreground">
                    {entry.icon === "tool" ? (
                      <Wrench className="h-3 w-3" />
                    ) : entry.icon === "reasoning" ? (
                      <Brain className="h-3 w-3" />
                    ) : (
                      <Sparkles className="h-3 w-3" />
                    )}
                  </span>
                  <span className="min-w-0 text-muted-foreground">{entry.label}</span>
                </motion.div>
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
      });
      continue;
    }

    if (event.kind === "tool-finish") {
      entries.push({
        id: `tool-finish-${event.tool_call_id ?? event.at_ms}`,
        icon: "tool",
        label: `${formatToolFinishLabel(event)}${event.duration_ms ? ` (${formatDuration(event.duration_ms)})` : ""}`,
      });
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
