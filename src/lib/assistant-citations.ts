import type { AssistantCitation } from "@/lib/types";

const ROWID_REGEX = /\browid:(\d+)\b/gi;

export function extractInlineRowids(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(ROWID_REGEX)) {
    const rowid = Number(match[1]);
    if (!Number.isFinite(rowid) || seen.has(rowid)) {
      continue;
    }
    seen.add(rowid);
    out.push(rowid);
  }
  return out;
}

export function rewriteInlineRowidTokens(text: string): string {
  const fromBracketed = text.replace(
    /\[rowid:(\d+)\]/gi,
    (_match, rowid) => `[rowid:${rowid}](rowid://${rowid})`,
  );
  return fromBracketed.replace(
    /(^|[^\[\w/])rowid:(\d+)\b/gi,
    (_match, prefix, rowid) => `${prefix}[rowid:${rowid}](rowid://${rowid})`,
  );
}

export function buildInlineCitations(
  text: string,
  citations: AssistantCitation[],
  fallbackChatId?: number | null,
): AssistantCitation[] {
  const byRowid = new Map<number, AssistantCitation>();
  for (const citation of citations) {
    byRowid.set(citation.rowid, citation);
  }

  return extractInlineRowids(text).flatMap((rowid) => {
    const existing = byRowid.get(rowid);
    if (existing) {
      return [existing];
    }
    if (fallbackChatId == null) {
      return [];
    }
    return [{
      chat_id: fallbackChatId,
      rowid,
      label: "Referenced message",
      reason: "Referenced in response",
    }];
  });
}
