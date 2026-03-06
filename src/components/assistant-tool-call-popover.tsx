import * as React from "react";

import { Check, Loader2, X } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AssistantDisplayBlock, Chat } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AssistantToolCallPopoverProps {
  block: AssistantDisplayBlock;
  chatById: Map<number, Chat>;
  onJumpToCitation: (chatId: number | null, rowid?: number | null) => void;
  children: React.ReactElement;
}

interface ChatJumpTarget {
  chatId: number;
  rowid: number | null;
}

export function AssistantToolCallPopover({
  block,
  chatById,
  onJumpToCitation,
  children,
}: AssistantToolCallPopoverProps) {
  const inputParsed = React.useMemo(
    () => parseMaybeJson(block.tool_input_preview),
    [block.tool_input_preview],
  );
  const outputParsed = React.useMemo(
    () => parseMaybeJson(block.tool_output_preview),
    [block.tool_output_preview],
  );
  const jumpTargets = React.useMemo(
    () => collectChatJumpTargets(inputParsed, outputParsed, block),
    [block, inputParsed, outputParsed],
  );

  const status = block.tool_status ?? "running";

  return (
    <Popover>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[34rem] max-h-[70vh] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
      >
        <div className="max-h-[70vh] overflow-y-auto px-3 py-2">
          <div className="space-y-2.5 text-xs">
            <div className="flex items-center justify-between gap-2 border-b border-border/60 pb-2">
              <div className="font-medium text-foreground">{friendlyToolName(block.tool_name)}</div>
              <div className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                {status === "running" ? (
                  <>
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Running
                  </>
                ) : status === "success" ? (
                  <>
                    <Check className="h-3 w-3" />
                    Success
                  </>
                ) : (
                  <>
                    <X className="h-3 w-3" />
                    Failed
                  </>
                )}
              </div>
            </div>

            <InfoRow
              label="Started"
              value={block.tool_input_summary ?? block.text ?? "Started tool call"}
            />

            <InfoRow
              label="Finished"
              value={
                status === "running"
                  ? "Waiting for result..."
                  : block.tool_output_summary ??
                    (status === "error" ? "Tool failed" : "Tool completed")
              }
              trailing={
                typeof block.duration_ms === "number"
                  ? `(${formatDuration(block.duration_ms)})`
                  : undefined
              }
            />

            {jumpTargets.length > 0 ? (
              <div className="border-t border-border/60 pt-2">
                <InfoRow label="Chats" value={null} />
                <div className="mt-1.5 flex flex-wrap gap-1.5 pl-20">
                  {jumpTargets.map((target) => {
                    const chat = chatById.get(target.chatId);
                    const label = chat ? formatChatName(chat) : `Chat ${target.chatId}`;
                    const hint = target.rowid != null ? ` · row ${target.rowid}` : " · latest";
                    return (
                      <button
                        key={`${target.chatId}:${target.rowid ?? "latest"}`}
                        type="button"
                        onClick={() => onJumpToCitation(target.chatId, target.rowid)}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted/90"
                      >
                        <span className="truncate max-w-[14rem]">{`${label}${hint}`}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            <details className="border-t border-border/60 pt-2">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                Parameters JSON
              </summary>
              <JsonCodeBlock raw={block.tool_input_preview} className="mt-2" />
            </details>

            <details className="border-t border-border/60 pt-2">
              <summary className="cursor-pointer list-none text-[11px] font-medium text-muted-foreground [&::-webkit-details-marker]:hidden">
                Result JSON
              </summary>
              <JsonCodeBlock raw={block.tool_output_preview} className="mt-2" />
            </details>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function InfoRow({
  label,
  value,
  trailing,
}: {
  label: string;
  value: React.ReactNode;
  trailing?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-16 shrink-0 pt-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 flex-1 text-foreground/90">
        {value}
        {trailing ? <span className="ml-1 text-muted-foreground">{trailing}</span> : null}
      </div>
    </div>
  );
}

function JsonCodeBlock({ raw, className }: { raw?: string; className?: string }) {
  const pretty = React.useMemo(() => prettyJson(raw), [raw]);
  const lines = React.useMemo(() => pretty.split("\n"), [pretty]);

  return (
    <pre
      className={cn(
        "max-h-56 overflow-auto rounded-md border border-border/70 bg-muted/40 p-2 font-mono text-[11px] leading-relaxed",
        className,
      )}
    >
      {lines.map((line, index) => (
        <div key={`${index}:${line.length}`}>{renderHighlightedJsonLine(line)}</div>
      ))}
    </pre>
  );
}

function renderHighlightedJsonLine(line: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const tokenRegex =
    /("(?:\\.|[^"\\])*")(\s*:)?|\btrue\b|\bfalse\b|\bnull\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]/g;
  let cursor = 0;

  for (const match of line.matchAll(tokenRegex)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      parts.push(line.slice(cursor, index));
    }

    const token = match[0];
    const quoted = match[1];
    const isKey = Boolean(quoted && match[2]);
    if (isKey) {
      parts.push(
        <span key={`${index}-key`} className="text-sky-600">
          {token}
        </span>,
      );
    } else if (quoted) {
      parts.push(
        <span key={`${index}-string`} className="text-emerald-600">
          {token}
        </span>,
      );
    } else if (/^-?\d/.test(token)) {
      parts.push(
        <span key={`${index}-number`} className="text-amber-600">
          {token}
        </span>,
      );
    } else if (token === "true" || token === "false" || token === "null") {
      parts.push(
        <span key={`${index}-literal`} className="text-rose-600">
          {token}
        </span>,
      );
    } else {
      parts.push(
        <span key={`${index}-punct`} className="text-muted-foreground">
          {token}
        </span>,
      );
    }

    cursor = index + token.length;
  }

  if (cursor < line.length) {
    parts.push(line.slice(cursor));
  }

  return <>{parts}</>;
}

export function renderToolStatusIcon(status?: AssistantDisplayBlock["tool_status"]) {
  if (status === "success") {
    return <Check className="h-3 w-3" />;
  }
  if (status === "error") {
    return <X className="h-3 w-3" />;
  }
  return <Loader2 className={cn("h-3 w-3 animate-spin")} />;
}

function parseMaybeJson(raw?: string): unknown {
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectChatJumpTargets(
  inputParsed: unknown,
  outputParsed: unknown,
  block: AssistantDisplayBlock,
): ChatJumpTarget[] {
  const out: ChatJumpTarget[] = [];
  const seen = new Set<string>();
  const addTarget = (chatId: number, rowid: number | null) => {
    const key = `${chatId}:${rowid ?? "latest"}`;
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ chatId, rowid });
  };

  const addFromObject = (value: Record<string, unknown>) => {
    const chatId = asPositiveInt(value.chat_id);
    const rowid = asPositiveInt(value.rowid);
    if (chatId != null) {
      addTarget(chatId, rowid);
    }

    const mentioned = value.mentioned_chat_ids;
    if (Array.isArray(mentioned)) {
      for (const id of mentioned) {
        const parsed = asPositiveInt(id);
        if (parsed != null) {
          addTarget(parsed, null);
        }
      }
    }
  };

  if (isRecord(inputParsed)) {
    addFromObject(inputParsed);
  }
  if (isRecord(outputParsed)) {
    addFromObject(outputParsed);
    const rows = outputParsed.results;
    if (Array.isArray(rows)) {
      for (const row of rows.slice(0, 6)) {
        if (isRecord(row)) {
          const chatId = asPositiveInt(row.chat_id);
          const rowid = asPositiveInt(row.rowid);
          if (chatId != null) {
            addTarget(chatId, rowid);
          }
        }
      }
    }
  }

  if (isRecord(inputParsed)) {
    const blockChatId = asPositiveInt(inputParsed.chat_id);
    if (blockChatId != null) {
      const rowid = asPositiveInt(inputParsed.rowid);
      addTarget(blockChatId, rowid);
    }
  }

  return out.slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPositiveInt(value: unknown): number | null {
  const num = typeof value === "string" ? Number(value) : value;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    return null;
  }
  if (!Number.isInteger(num) || num <= 0) {
    return null;
  }
  return num;
}

function prettyJson(raw?: string): string {
  if (!raw) {
    return "No data";
  }
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function formatChatName(chat: Chat): string {
  if (chat.display_name && chat.display_name.trim().length > 0) {
    return chat.display_name.trim();
  }
  if (chat.participants.length > 0) {
    return chat.participants.join(", ");
  }
  return "Conversation";
}

function friendlyToolName(toolName?: string): string {
  if (!toolName) {
    return "Tool call";
  }
  return toolName
    .split("_")
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1))
    .join(" ");
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
