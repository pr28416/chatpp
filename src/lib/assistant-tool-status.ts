import type { AssistantProcessingEvent } from "@/lib/types";

type ToolEvent = Pick<
  AssistantProcessingEvent,
  "tool_name" | "input_preview" | "output_preview" | "input_summary" | "output_summary" | "success"
>;

export function formatToolStartLabel(event: ToolEvent): string {
  if (event.input_summary) {
    return event.input_summary;
  }
  const parsedInput = parseJsonObject(event.input_preview);
  const toolName = event.tool_name;

  if (toolName === "search_messages") {
    const query = maybeQuoted(parsedInput?.q);
    return `Searching messages${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "search_all_chats") {
    const query = maybeQuoted(parsedInput?.q);
    return `Searching all chats${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "search_contacts") {
    const query = maybeQuoted(parsedInput?.q);
    return `Searching contacts${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "find_chats_by_contact") {
    const contact = maybePerson(parsedInput?.name_or_handle);
    return `Looking up chats${contact ? ` for ${contact}` : ""}`;
  }
  if (toolName === "search_messages_by_contact") {
    const contact = maybePerson(parsedInput?.name_or_handle);
    return `Searching contact messages${contact ? ` for ${contact}` : ""}`;
  }
  if (toolName === "get_recent_messages") {
    return "Fetching recent messages";
  }
  if (toolName === "get_message_context") {
    return "Reading nearby messages for context";
  }
  if (toolName === "search_timeline") {
    const query = maybeQuoted(parsedInput?.q);
    return `Searching timeline${query ? ` for ${query}` : ""}`;
  }
  if (toolName === "timeline_overview") {
    return "Checking timeline index status";
  }
  if (toolName === "run_readonly_sql") {
    return "Running a read-only SQL lookup";
  }

  return `Running ${friendlyToolName(event.tool_name)}`;
}

export function formatToolFinishLabel(event: ToolEvent): string {
  if (event.success === false) {
    const failureDetail = event.output_preview ? `: ${compact(event.output_preview, 160)}` : "";
    return `Tool failed: ${friendlyToolName(event.tool_name)}${failureDetail}`;
  }

  if (event.output_summary) {
    return event.output_summary;
  }

  return `${friendlyToolName(event.tool_name)} complete`;
}

function parseJsonObject(inputPreview?: string): Record<string, unknown> | null {
  if (!inputPreview) {
    return null;
  }
  try {
    const parsed = JSON.parse(inputPreview);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function maybeQuoted(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return `"${compact(trimmed, 48)}"`;
}

function maybePerson(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return compact(trimmed, 48);
}

function friendlyToolName(toolName?: string): string {
  switch (toolName) {
    case "search_messages":
      return "message search";
    case "search_all_chats":
      return "cross-chat search";
    case "search_contacts":
      return "contact search";
    case "find_chats_by_contact":
      return "contact chat lookup";
    case "search_messages_by_contact":
      return "contact message search";
    case "get_recent_messages":
      return "recent message lookup";
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

function compact(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, max - 1)}…`;
}
