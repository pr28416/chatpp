import * as React from "react";
import { Message, Attachment, Reaction } from "@/lib/types";
import { ContactAvatar } from "./contact-avatar";
import { format, parseISO } from "date-fns";
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";

function attachmentUrl(rowid: number): string {
  return `localfile://localhost/${rowid}`;
}

interface MessageBubbleProps {
  message: Message;
  showSender: boolean;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  replyToMessage?: Message | null;
  onReplyClick?: (originGuid: string) => void;
  isHighlighted?: boolean;
  searchQuery?: string;
}

type BubblePart =
  | { kind: "media"; attachments: Attachment[] }
  | { kind: "text"; text: string | null; attachments: Attachment[] };

export function MessageBubble({
  message,
  showSender,
  isFirstInGroup,
  isLastInGroup,
  replyToMessage,
  onReplyClick,
  isHighlighted,
  searchQuery,
}: MessageBubbleProps) {
  const isSent = message.is_from_me;
  const text = message.text?.replace(/\uFFFC/g, "").trim() || null;
  const hasAttachments = message.attachments.length > 0;
  const activeReactions = React.useMemo(
    () => message.reactions.filter((r) => !r.reaction_type.startsWith("Removed")),
    [message.reactions],
  );
  const hasReactions = activeReactions.length > 0;
  const [isReactionOpen, setIsReactionOpen] = React.useState(false);

  if (!text && !hasAttachments) return null;

  const timestamp = (() => {
    try {
      return format(parseISO(message.date), "h:mm a");
    } catch {
      return "";
    }
  })();

  const mediaAttachments = message.attachments.filter((a) => {
    const m = a.mime_type || "";
    return m.startsWith("image/") || m.startsWith("video/");
  });
  const nonMediaAttachments = message.attachments.filter((a) => {
    const m = a.mime_type || "";
    return !m.startsWith("image/") && !m.startsWith("video/");
  });

  const parts: BubblePart[] = [];

  if (mediaAttachments.length > 0 && (text || nonMediaAttachments.length > 0)) {
    const raw = message.text || "";
    const idx = raw.indexOf("\uFFFC");
    const mediaFirst = idx === -1 || raw.slice(0, idx).trim().length === 0;

    const mediaPart: BubblePart = {
      kind: "media",
      attachments: mediaAttachments,
    };
    const textPart: BubblePart = {
      kind: "text",
      text,
      attachments: nonMediaAttachments,
    };

    if (mediaFirst) {
      parts.push(mediaPart, textPart);
    } else {
      parts.push(textPart, mediaPart);
    }
  } else if (
    !text &&
    hasAttachments &&
    mediaAttachments.length === message.attachments.length
  ) {
    parts.push({ kind: "media", attachments: mediaAttachments });
  } else {
    parts.push({ kind: "text", text, attachments: nonMediaAttachments });
  }

  const bubbleBg = isSent
    ? "bg-primary text-primary-foreground"
    : "bg-[#E9E9EB] text-black dark:bg-[#3A3A3C] dark:text-white";

  const showAvatar = showSender && !isSent;
  const avatarSize = 28;
  const avatarGutter = showAvatar ? avatarSize + 6 : 0;

  return (
    <div
      className={`flex flex-col ${isSent ? "items-end" : "items-start"} ${
        isFirstInGroup ? "mt-2" : "mt-0.5"
      } ${isHighlighted ? "search-highlight-pulse" : ""}`}
      style={
        isHighlighted
          ? {
              borderRadius: "12px",
              boxShadow:
                "0 0 0 2px rgba(250, 176, 5, 0.6), 0 0 12px rgba(250, 176, 5, 0.25)",
            }
          : undefined
      }
    >
      {showAvatar && isFirstInGroup && message.sender && (
        <span
          className="text-xs text-muted-foreground mb-0.5"
          style={{ marginLeft: avatarGutter }}
        >
          {message.sender}
        </span>
      )}

      {message.reply_to_guid && replyToMessage && (
        <button
          type="button"
          aria-label="View reply thread"
          className={`max-w-[70%] mb-0.5 ${isSent ? "self-end" : "self-start"}`}
          style={
            !isSent && showAvatar ? { marginLeft: avatarGutter } : undefined
          }
          onClick={() => onReplyClick?.(message.reply_to_guid!)}
        >
          <ReplyPreview replyTo={replyToMessage} isSent={isSent} />
        </button>
      )}

      <div
        className={`flex ${isSent ? "flex-row-reverse" : "flex-row"} items-end gap-1.5 w-full`}
      >
        {showAvatar && (
          <div style={{ width: avatarSize, minWidth: avatarSize }}>
            {isLastInGroup ? (
              <ContactAvatar
                handleId={message.sender_handle ?? null}
                name={message.sender || "?"}
                size={avatarSize}
              />
            ) : (
              <div style={{ width: avatarSize, height: avatarSize }} />
            )}
          </div>
        )}

        <div
          className={`flex flex-col ${isSent ? "items-end" : "items-start"} flex-1 min-w-0`}
        >
          {hasReactions ? (
            <Popover open={isReactionOpen} onOpenChange={setIsReactionOpen}>
              <PopoverTrigger asChild>
                <div
                  className="cursor-pointer"
                  aria-label="Show message reactions"
                  title="Show reactions"
                >
                  {parts.map((part, i) => {
                    const partFirst = i === 0 ? isFirstInGroup : false;
                    const partLast = i === parts.length - 1 ? isLastInGroup : false;
                    const radius = getBorderRadius(isSent, partFirst, partLast);

                    return (
                      <div
                        key={i}
                        className={`relative max-w-[70%] ${i > 0 ? "mt-0.5" : ""}`}
                      >
                        {part.kind === "media" ? (
                          <div className={`overflow-hidden ${radius}`}>
                            {part.attachments.map((att) => (
                              <MediaItem key={att.rowid} attachment={att} />
                            ))}
                          </div>
                        ) : (
                          <div
                            className={`flex flex-col overflow-hidden ${bubbleBg} ${radius}`}
                          >
                            {part.attachments.length > 0 && (
                              <AttachmentList
                                attachments={part.attachments}
                                isSent={isSent}
                              />
                            )}
                            {part.text && (
                              <MessageText
                                text={part.text}
                                isSent={isSent}
                                searchQuery={searchQuery}
                              />
                            )}
                          </div>
                        )}

                        {i === parts.length - 1 && (
                          <ReactionBadges
                            reactions={activeReactions}
                            isSent={isSent}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              </PopoverTrigger>
              <PopoverContent
                align={isSent ? "end" : "start"}
                className="w-64 p-3"
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <ReactionDetails reactions={activeReactions} />
              </PopoverContent>
            </Popover>
          ) : (
            parts.map((part, i) => {
              const partFirst = i === 0 ? isFirstInGroup : false;
              const partLast = i === parts.length - 1 ? isLastInGroup : false;
              const radius = getBorderRadius(isSent, partFirst, partLast);

              return (
                <div
                  key={i}
                  className={`relative max-w-[70%] ${i > 0 ? "mt-0.5" : ""}`}
                >
                  {part.kind === "media" ? (
                    <div className={`overflow-hidden ${radius}`}>
                      {part.attachments.map((att) => (
                        <MediaItem key={att.rowid} attachment={att} />
                      ))}
                    </div>
                  ) : (
                    <div
                      className={`flex flex-col overflow-hidden ${bubbleBg} ${radius}`}
                    >
                      {part.attachments.length > 0 && (
                        <AttachmentList
                          attachments={part.attachments}
                          isSent={isSent}
                        />
                      )}
                      {part.text && (
                        <MessageText
                          text={part.text}
                          isSent={isSent}
                          searchQuery={searchQuery}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {isLastInGroup && (
        <span
          className={`text-[10px] text-muted-foreground mt-0.5 ${
            isSent ? "mr-1" : ""
          }`}
          style={
            !isSent && showAvatar ? { marginLeft: avatarGutter } : undefined
          }
        >
          {timestamp}
          {message.service === "SMS" && (
            <span className="ml-1 text-green-600">SMS</span>
          )}
        </span>
      )}
    </div>
  );
}

// ── Linkified Message Text ──────────────────────────────────────────────────

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

function linkify(text: string): Array<{ type: "text" | "url"; value: string }> {
  const parts: Array<{ type: "text" | "url"; value: string }> = [];
  let lastIndex = 0;
  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", value: text.slice(lastIndex, match.index) });
    }
    parts.push({ type: "url", value: match[0] });
    lastIndex = URL_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", value: text.slice(lastIndex) });
  }
  return parts;
}

function MessageText({
  text,
  isSent,
  searchQuery,
}: {
  text: string;
  isSent: boolean;
  searchQuery?: string;
}) {
  const parts = linkify(text);
  const hasLinks = parts.some((p) => p.type === "url");

  if (!hasLinks) {
    return (
      <div className="px-3 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words">
        {searchQuery ? (
          <HighlightSearchMatches
            text={text}
            query={searchQuery}
            isSent={isSent}
          />
        ) : (
          text
        )}
      </div>
    );
  }

  return (
    <div className="px-3 py-2 text-[15px] leading-snug whitespace-pre-wrap break-words">
      {parts.map((part, i) => {
        if (part.type === "url") {
          return (
            <a
              key={i}
              href={part.value}
              target="_blank"
              rel="noopener noreferrer"
              className={`underline decoration-1 underline-offset-2 ${
                isSent
                  ? "text-white/90 hover:text-white"
                  : "text-primary hover:text-primary/80"
              }`}
            >
              {searchQuery ? (
                <HighlightSearchMatches
                  text={part.value}
                  query={searchQuery}
                  isSent={isSent}
                />
              ) : (
                part.value
              )}
            </a>
          );
        }
        return (
          <React.Fragment key={i}>
            {searchQuery ? (
              <HighlightSearchMatches
                text={part.value}
                query={searchQuery}
                isSent={isSent}
              />
            ) : (
              part.value
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function HighlightSearchMatches({
  text,
  query,
  isSent,
}: {
  text: string;
  query: string;
  isSent: boolean;
}) {
  if (!query.trim()) return <>{text}</>;

  const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`(${escapedQuery})`, "gi");
  const parts = text.split(regex);

  return (
    <>
      {parts.map((part, i) =>
        regex.test(part) ? (
          <mark
            key={i}
            className={`rounded-sm px-0.5 ${
              isSent
                ? "bg-yellow-300/50 text-white"
                : "bg-yellow-300/70 dark:bg-yellow-500/40 text-inherit"
            }`}
          >
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

// ── Reply Preview ───────────────────────────────────────────────────────────

function ReplyPreview({
  replyTo,
  isSent,
}: {
  replyTo: Message;
  isSent: boolean;
}) {
  const previewText =
    replyTo.text
      ?.replace(/\uFFFC/g, "")
      .trim()
      ?.slice(0, 80) ||
    (replyTo.num_attachments > 0 ? "Attachment" : "Message");
  const sender = replyTo.is_from_me ? "You" : replyTo.sender || "Unknown";

  return (
    <div
      className={`rounded-lg px-2.5 py-1.5 text-xs border border-border/40 text-left transition-colors ${
        isSent
          ? "bg-primary/10 text-primary hover:bg-primary/20"
          : "bg-muted text-muted-foreground hover:bg-muted/80"
      }`}
    >
      <span className="font-semibold">{sender}</span>
      <p className="line-clamp-2 opacity-80">{previewText}</p>
    </div>
  );
}

// ── Media Item (standalone, no bubble background) ───────────────────────────

function MediaItem({ attachment }: { attachment: Attachment }) {
  const src = attachmentUrl(attachment.rowid);
  const mime = attachment.mime_type || "";

  if (mime.startsWith("image/")) {
    return (
      <img
        src={src}
        alt={attachment.transfer_name || "Image"}
        className="max-w-full max-h-[400px]"
        loading="lazy"
      />
    );
  }

  return (
    <video
      src={src}
      controls
      preload="metadata"
      className="max-w-full max-h-[400px]"
    />
  );
}

// ── Attachment List (non-media files inside colored bubble) ─────────────────

function AttachmentList({
  attachments,
  isSent,
}: {
  attachments: Attachment[];
  isSent: boolean;
}) {
  return (
    <>
      {attachments.map((att) => (
        <AttachmentItem key={att.rowid} attachment={att} isSent={isSent} />
      ))}
    </>
  );
}

function AttachmentItem({
  attachment,
  isSent,
}: {
  attachment: Attachment;
  isSent: boolean;
}) {
  const mime = attachment.mime_type || "";
  const src = attachmentUrl(attachment.rowid);

  if (mime.startsWith("audio/")) {
    return (
      <div className="px-3 py-2">
        <audio src={src} controls preload="metadata" className="w-full" />
      </div>
    );
  }

  const filename = attachment.transfer_name || attachment.filename || "File";
  const size = formatBytes(attachment.total_bytes);

  return (
    <div
      className={`flex items-center gap-2 px-3 py-2 text-xs ${
        isSent ? "text-white/80" : "text-foreground/70"
      }`}
    >
      <FileIcon />
      <div className="min-w-0">
        <p className="truncate font-medium">{filename}</p>
        {size && <p className="opacity-60">{size}</p>}
      </div>
    </div>
  );
}

function FileIcon() {
  return (
    <svg
      className="w-8 h-8 shrink-0 opacity-50"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
      />
    </svg>
  );
}

// ── Reaction Badges ─────────────────────────────────────────────────────────

const REACTION_EMOJI: Record<string, string> = {
  Loved: "\u2764\uFE0F",
  Liked: "\uD83D\uDC4D",
  Disliked: "\uD83D\uDC4E",
  Laughed: "\uD83D\uDE02",
  Emphasized: "\u203C\uFE0F",
  Questioned: "\u2753",
};

function isEmojiOnlyReaction(type: string): boolean {
  if (!type.trim()) return false;
  // Matches standalone pictographic emoji reactions (e.g. 😂, 😭, 🔥).
  return /^\p{Extended_Pictographic}+$/u.test(type.trim());
}

function reactionDisplay(type: string): { emoji: string; label: string } {
  const mapped = REACTION_EMOJI[type];
  if (mapped) {
    return { emoji: mapped, label: type };
  }
  if (isEmojiOnlyReaction(type)) {
    return { emoji: type, label: "Reacted" };
  }
  return { emoji: "\u2753", label: type };
}

function ReactionBadges({
  reactions,
  isSent,
}: {
  reactions: Reaction[];
  isSent: boolean;
}) {
  const groups = new Map<string, number>();
  for (const r of reactions) {
    groups.set(r.reaction_type, (groups.get(r.reaction_type) || 0) + 1);
  }

  if (groups.size === 0) return null;

  return (
    <div
      className={`absolute -top-2 z-10 flex gap-0.5 ${
        isSent
          ? "left-0 -translate-x-1/3 -translate-y-1/2"
          : "right-0 translate-x-1/3 -translate-y-1/2"
      }`}
    >
      {Array.from(groups).map(([type, count]) => {
        const { emoji } = reactionDisplay(type);
        return (
          <span
            key={type}
            className="inline-flex items-center gap-0.5 bg-card border border-border rounded-full px-1.5 py-0.5 text-[11px] shadow-sm"
          >
            <span>{emoji}</span>
            {count > 1 && (
              <span className="text-muted-foreground">{count}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}

function ReactionDetails({ reactions }: { reactions: Reaction[] }) {
  const groups = new Map<string, string[]>();

  for (const reaction of reactions) {
    const name = reaction.is_from_me ? "You" : reaction.sender || "Unknown";
    const existing = groups.get(reaction.reaction_type) || [];
    existing.push(name);
    groups.set(reaction.reaction_type, existing);
  }

  return (
    <div className="space-y-2">
      <PopoverHeader>
        <PopoverTitle>Reactions</PopoverTitle>
      </PopoverHeader>
      <div className="space-y-1.5">
        {Array.from(groups).map(([type, names]) => {
          const { emoji, label } = reactionDisplay(type);
          return (
            <div
              key={type}
              className="flex items-start gap-2 rounded-md bg-muted/40 px-2 py-1.5 text-sm"
            >
              <span className="text-base leading-none mt-0.5">{emoji}</span>
              <div className="min-w-0">
                <p className="font-medium">{label}</p>
                <p className="text-xs text-muted-foreground break-words">
                  {names.join(", ")}
                </p>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function getBorderRadius(
  isSent: boolean,
  isFirst: boolean,
  isLast: boolean,
): string {
  const base = "rounded-[18px]";

  if (isSent) {
    if (isFirst && isLast) return `${base} rounded-br-[4px]`;
    if (isFirst) return `${base} rounded-br-[12px]`;
    if (isLast) return `${base} rounded-tr-[12px] rounded-br-[4px]`;
    return `${base} rounded-tr-[12px] rounded-br-[12px]`;
  } else {
    if (isFirst && isLast) return `${base} rounded-bl-[4px]`;
    if (isFirst) return `${base} rounded-bl-[12px]`;
    if (isLast) return `${base} rounded-tl-[12px] rounded-bl-[4px]`;
    return `${base} rounded-tl-[12px] rounded-bl-[12px]`;
  }
}

function formatBytes(bytes: number): string | null {
  if (bytes <= 0) return null;
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}
