import { Brain, Sparkles } from "lucide-react";

import { AssistantMarkdown } from "@/components/assistant-markdown";
import {
  AssistantToolCallPopover,
  renderToolStatusIcon,
} from "@/components/assistant-tool-call-popover";
import { cn } from "@/lib/utils";
import type { AssistantCitation, AssistantDisplayBlock, Chat } from "@/lib/types";

interface AssistantStreamBlocksProps {
  blocks: AssistantDisplayBlock[];
  citationByKey: Record<string, AssistantCitation>;
  citationByUniqueRowid: Record<number, AssistantCitation>;
  chatById: Map<number, Chat>;
  renderUnresolvedAsInvalid?: boolean;
  onJumpToCitation: (chatId: number | null, rowid?: number | null) => void;
}

export function AssistantStreamBlocks({
  blocks,
  citationByKey,
  citationByUniqueRowid,
  chatById,
  renderUnresolvedAsInvalid = true,
  onJumpToCitation,
}: AssistantStreamBlocksProps) {
  if (blocks.length === 0) {
    return null;
  }

  const grouped = groupBlocks(blocks);

  return (
    <div className="space-y-3">
      {grouped.map((group) => {
        if (group.kind === "text") {
          return (
            <AssistantMarkdown
              key={group.block.id}
              text={group.block.text ?? ""}
              citationByKey={citationByKey}
              citationByUniqueRowid={citationByUniqueRowid}
              renderUnresolvedAsInvalid={renderUnresolvedAsInvalid}
              onJumpToCitation={onJumpToCitation}
            />
          );
        }

        return (
          <div
            key={group.id}
            className={cn(
              "rounded-lg border border-border/70 bg-card/55 px-3 py-2 text-xs",
              group.hasError && "border-destructive/40 bg-destructive/10 text-destructive",
            )}
          >
            <div className="space-y-1.5">
              {group.blocks.map((block) => (
                <TraceRow
                  key={block.id}
                  block={block}
                  chatById={chatById}
                  onJumpToCitation={onJumpToCitation}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

type BlockGroup =
  | { kind: "text"; block: AssistantDisplayBlock }
  | { kind: "trace"; id: string; blocks: AssistantDisplayBlock[]; hasError: boolean };

function groupBlocks(blocks: AssistantDisplayBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let activeTrace: AssistantDisplayBlock[] = [];

  const flushTrace = () => {
    if (activeTrace.length === 0) {
      return;
    }
    groups.push({
      kind: "trace",
      id: activeTrace[0].id,
      blocks: activeTrace,
      hasError: activeTrace.some((block) => block.kind === "error"),
    });
    activeTrace = [];
  };

  for (const block of blocks) {
    if (block.kind === "text") {
      flushTrace();
      groups.push({ kind: "text", block });
      continue;
    }
    activeTrace.push(block);
  }

  flushTrace();
  return groups;
}

function TraceRow({
  block,
  chatById,
  onJumpToCitation,
}: {
  block: AssistantDisplayBlock;
  chatById: Map<number, Chat>;
  onJumpToCitation: (chatId: number | null, rowid?: number | null) => void;
}) {
  const rowContent = (
    <div className="flex items-start gap-2">
      <span
        className={cn(
          "mt-0.5 text-muted-foreground",
          block.tool_status === "error" && "opacity-70",
        )}
      >
        {block.kind === "reasoning" ? (
          <Brain className="h-3 w-3" />
        ) : block.kind === "error" ? (
          <Sparkles className="h-3 w-3" />
        ) : block.kind === "tool_call" ? (
          renderToolStatusIcon(block.tool_status)
        ) : (
          <Sparkles className="h-3 w-3" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 text-muted-foreground",
          block.kind === "error" && "text-destructive",
          block.tool_status === "error" && "opacity-70",
        )}
      >
        {formatBlockLabel(block)}
      </span>
    </div>
  );

  if (block.kind !== "tool_call") {
    return rowContent;
  }

  return (
    <AssistantToolCallPopover
      block={block}
      chatById={chatById}
      onJumpToCitation={onJumpToCitation}
    >
      <button type="button" className="w-full text-left hover:opacity-90 transition-opacity">
        {rowContent}
      </button>
    </AssistantToolCallPopover>
  );
}

function formatBlockLabel(block: AssistantDisplayBlock): string {
  if (block.kind === "reasoning") {
    return `Reasoning: ${compact(block.text ?? "", 240)}`;
  }
  if (block.kind === "tool_call" && block.tool_status && block.tool_status !== "running") {
    if (typeof block.duration_ms === "number") {
      return `${block.text ?? "Tool complete"} (${formatDuration(block.duration_ms)})`;
    }
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
