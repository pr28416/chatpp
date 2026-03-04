import type { AssistantCitation } from "@/lib/types";

const COMPOSITE_REGEX = /\bcite:(\d+):(\d+)\b/gi;

export interface InlineCitationRef {
  chatId: number;
  rowid: number;
}

export function extractInlineRowids(text: string): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const match of String(text || "").matchAll(COMPOSITE_REGEX)) {
    const rowid = Number(match[2]);
    if (!Number.isFinite(rowid) || seen.has(rowid)) {
      continue;
    }
    seen.add(rowid);
    out.push(rowid);
  }
  return out;
}

export function extractInlineCitationRefs(text: string): InlineCitationRef[] {
  const refs: InlineCitationRef[] = [];
  const seen = new Set<string>();

  for (const match of String(text || "").matchAll(COMPOSITE_REGEX)) {
    const chatId = Number(match[1]);
    const rowid = Number(match[2]);
    if (!Number.isFinite(chatId) || !Number.isFinite(rowid)) {
      continue;
    }
    const key = `${chatId}:${rowid}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    refs.push({ chatId, rowid });
  }

  return refs;
}

export function rewriteInlineRowidTokens(text: string): string {
  const fromCompositeBracketed = text.replace(
    /\[cite:(\d+):(\d+)\]/gi,
    (_match, chatId, rowid) => `[cite:${chatId}:${rowid}](cite://${chatId}/${rowid})`,
  );
  const fromComposite = fromCompositeBracketed.replace(
    /(^|[^\[\w/])cite:(\d+):(\d+)\b/gi,
    (_match, prefix, chatId, rowid) =>
      `${prefix}[cite:${chatId}:${rowid}](cite://${chatId}/${rowid})`,
  );
  return fromComposite;
}

export function buildInlineCitations(
  text: string,
  citations: AssistantCitation[],
  _fallbackChatId?: number | null,
): AssistantCitation[] {
  const refs = extractInlineCitationRefs(text);
  const byKey = new Map<string, AssistantCitation>();
  for (const citation of citations) {
    byKey.set(makeCitationKey(citation.chat_id, citation.rowid), citation);
  }
  const out: AssistantCitation[] = [];
  const seen = new Set<string>();
  for (const ref of refs) {
    const keyed = byKey.get(makeCitationKey(ref.chatId, ref.rowid));
    if (keyed) {
      const key = makeCitationKey(keyed.chat_id, keyed.rowid);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(keyed);
      }
    }
  }
  return out;
}

export function makeCitationKey(chatId: number, rowid: number): string {
  return `${chatId}:${rowid}`;
}
