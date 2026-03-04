import * as React from "react";
import { MessageSquare } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { makeCitationKey, rewriteInlineRowidTokens } from "@/lib/assistant-citations";
import { ContactAvatar } from "@/components/contact-avatar";
import type { AssistantCitation } from "@/lib/types";

interface AssistantMarkdownProps {
  text: string;
  citationByKey?: Record<string, AssistantCitation>;
  citationByUniqueRowid?: Record<number, AssistantCitation>;
  renderUnresolvedAsInvalid?: boolean;
  onJumpToCitation: (chatId: number | null, rowid: number) => void;
}

export function AssistantMarkdown({
  text,
  citationByKey,
  citationByUniqueRowid,
  renderUnresolvedAsInvalid = true,
  onJumpToCitation,
}: AssistantMarkdownProps) {
  const normalized = React.useMemo(
    () => rewriteInlineRowidTokens(decodeEscapedUnicode(text)),
    [text],
  );

  return (
    <div className="max-w-none text-sm leading-relaxed [&_p]:my-2 [&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:my-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-3 [&_hr]:my-3 [&_hr]:border-border">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const ref =
              extractCitationRefFromHref(href) ??
              extractCitationRefFromText(readNodeText(children));
            if (ref) {
              const citation = resolveCitation(ref, citationByKey, citationByUniqueRowid);
              if (!citation) {
                if (!renderUnresolvedAsInvalid) {
                  return (
                    <button
                      type="button"
                      onClick={() => onJumpToCitation(ref.chatId, ref.rowid)}
                      className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/60 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted/90 align-middle"
                    >
                      <MessageSquare className="h-2.5 w-2.5" />
                      <span className="truncate max-w-[12rem]">{`cite:${ref.chatId}:${ref.rowid}`}</span>
                    </button>
                  );
                }
                return (
                  <span className="inline-flex items-center gap-1 rounded-full border border-destructive/40 bg-destructive/10 px-1.5 py-0.5 text-[10px] text-destructive align-middle">
                    <MessageSquare className="h-2.5 w-2.5" />
                    <span className="truncate max-w-[12rem]">{`Invalid citation ${ref.rowid}`}</span>
                  </span>
                );
              }
              const chatId = citation.chat_id;
              const rowid = citation.rowid;
              const chipLabel = buildCitationChipLabel(citation, rowid);
              return (
                <button
                  type="button"
                  onClick={() => onJumpToCitation(chatId, rowid)}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/70 px-1.5 py-0.5 text-[10px] text-foreground hover:bg-muted/90 align-middle"
                >
                  <ContactAvatar
                    handleId={citation.sender_handle ?? null}
                    name={citation.sender?.trim() || citation.chat_label?.trim() || "Citation"}
                    size={12}
                    className="ring-0"
                  />
                  <span className="truncate max-w-[12rem]">{chipLabel}</span>
                </button>
              );
            }
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="text-primary underline"
              >
                {children}
              </a>
            );
          },
          ul: ({ children }) => <ul className="my-2 list-disc pl-5 marker:text-muted-foreground">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal pl-5 marker:text-muted-foreground">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          p: ({ children }) => <p className="my-2">{children}</p>,
          code: ({ className, children }) => (
            <code className={className ? className : "rounded bg-muted px-1 py-0.5"}>
              {children}
            </code>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
}

interface ParsedCitationRef {
  chatId: number;
  rowid: number;
}

function extractCitationRefFromHref(href?: string): ParsedCitationRef | null {
  if (!href) {
    return null;
  }
  const decoded = decodeURIComponent(href).trim();
  const composite = decoded.match(/cite:(?:\/\/)?(\d+)[/:](\d+)\b/i);
  if (composite) {
    const chatId = Number(composite[1]);
    const rowid = Number(composite[2]);
    if (Number.isFinite(chatId) && Number.isFinite(rowid)) {
      return { chatId, rowid };
    }
  }
  return null;
}

function extractCitationRefFromText(text: string): ParsedCitationRef | null {
  const composite = text.match(/\bcite:(\d+):(\d+)\b/i);
  if (composite) {
    const chatId = Number(composite[1]);
    const rowid = Number(composite[2]);
    if (Number.isFinite(chatId) && Number.isFinite(rowid)) {
      return { chatId, rowid };
    }
  }
  return null;
}

function readNodeText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(readNodeText).join("");
  }
  if (React.isValidElement(node)) {
    return readNodeText((node as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function buildCitationChipLabel(citation: AssistantCitation | undefined, rowid: number): string {
  if (!citation) {
    return `Citation ${rowid}`;
  }
  if (citation.chat_label && citation.chat_label.trim().length > 0) {
    return truncate(citation.chat_label, 26);
  }
  if (citation.sender && citation.sender.trim().length > 0) {
    const sender = truncate(citation.sender.trim(), 18);
    const time = citation.date ? formatChipTime(citation.date) : null;
    return time ? `${sender} · ${time}` : sender;
  }
  if (citation.message_text && citation.message_text.trim().length > 0) {
    return truncate(citation.message_text.trim(), 30);
  }
  return `Citation ${rowid}`;
}

function resolveCitation(
  ref: ParsedCitationRef,
  citationByKey?: Record<string, AssistantCitation>,
  citationByUniqueRowid?: Record<number, AssistantCitation>,
): AssistantCitation | undefined {
  const keyed = citationByKey?.[makeCitationKey(ref.chatId, ref.rowid)];
  if (keyed) {
    return keyed;
  }
  return citationByUniqueRowid?.[ref.rowid];
}

function formatChipTime(value: string): string {
  try {
    return new Date(value).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return value;
  }
}

function truncate(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function decodeEscapedUnicode(input: string): string {
  const source = String(input ?? "");
  if (!/\\u[0-9a-fA-F]{4}/.test(source)) {
    return source;
  }
  return source.replace(/\\u([0-9a-fA-F]{4})/g, (_match, code) =>
    String.fromCharCode(parseInt(code, 16)),
  );
}
