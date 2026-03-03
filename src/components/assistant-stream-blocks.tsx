import { Brain, Sparkles, Wrench } from "lucide-react";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import { cn } from "@/lib/utils";
import type { AssistantCitation, AssistantDisplayBlock } from "@/lib/types";

interface AssistantStreamBlocksProps {
  blocks: AssistantDisplayBlock[];
  citationByRowid: Record<number, AssistantCitation>;
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}

export function AssistantStreamBlocks({
  blocks,
  citationByRowid,
  onJumpToCitation,
}: AssistantStreamBlocksProps) {
  if (blocks.length === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {blocks.map((block) => {
        if (block.kind === "text") {
          return (
            <AssistantMarkdown
              key={block.id}
              text={block.text ?? ""}
              citationByRowid={citationByRowid}
              onJumpToCitation={onJumpToCitation}
            />
          );
        }

        return (
          <div
            key={block.id}
            className={cn(
              "flex items-start gap-2 rounded-lg border border-border/70 bg-card/55 px-3 py-2 text-xs",
              block.kind === "error" && "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            <span className="mt-0.5 text-muted-foreground">
              {block.kind === "reasoning" ? (
                <Brain className="h-3 w-3" />
              ) : block.kind === "error" ? (
                <Sparkles className="h-3 w-3" />
              ) : (
                <Wrench className="h-3 w-3" />
              )}
            </span>
            <span className={cn("min-w-0 text-muted-foreground", block.kind === "error" && "text-destructive")}>
              {formatBlockLabel(block)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatBlockLabel(block: AssistantDisplayBlock): string {
  if (block.kind === "reasoning") {
    return `Reasoning: ${compact(block.text ?? "", 240)}`;
  }
  if (block.kind === "tool_result" && typeof block.duration_ms === "number") {
    return `${block.text ?? "Tool complete"} (${formatDuration(block.duration_ms)})`;
  }
  return block.text ?? "";
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
