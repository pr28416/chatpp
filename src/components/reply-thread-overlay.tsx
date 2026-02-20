import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Message } from "@/lib/types";
import { MessageBubble } from "./message-bubble";

interface ReplyThreadOverlayProps {
  originGuid: string | null;
  messages: Message[];
  guidMap: Map<string, Message>;
  isGroupChat: boolean;
  onClose: () => void;
}

export function ReplyThreadOverlay({
  originGuid,
  messages,
  guidMap,
  isGroupChat,
  onClose,
}: ReplyThreadOverlayProps) {
  const isOpen = originGuid !== null;

  const thread = React.useMemo(() => {
    if (!originGuid) return [];

    const original = guidMap.get(originGuid);
    const replies = messages.filter(
      (m) => m.reply_to_guid === originGuid && !m.is_tapback,
    );

    const all: Message[] = [];
    if (original) all.push(original);
    for (const r of replies) {
      if (!original || r.guid !== original.guid) {
        all.push(r);
      }
    }

    all.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    return all;
  }, [originGuid, messages, guidMap]);

  React.useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose]);

  return (
    <AnimatePresence>
      {isOpen && thread.length > 0 && (
        <>
          <motion.div
            key="backdrop"
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
          />

          <motion.div
            key="panel"
            className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              className="pointer-events-auto w-full max-w-lg max-h-[80vh] overflow-y-auto bg-background rounded-2xl shadow-2xl border border-border/50 p-4"
              initial={{ opacity: 0, y: 60, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 40, scale: 0.97 }}
              transition={{
                type: "spring",
                damping: 28,
                stiffness: 350,
                mass: 0.8,
              }}
            >
              <div className="flex items-center justify-between mb-3 px-1">
                <h3 className="text-sm font-semibold text-foreground">
                  Thread
                  <span className="ml-1.5 text-muted-foreground font-normal">
                    {thread.length} message{thread.length !== 1 ? "s" : ""}
                  </span>
                </h3>
                <button
                  type="button"
                  onClick={onClose}
                  className="text-muted-foreground hover:text-foreground text-xs px-2 py-1 rounded-md hover:bg-muted transition-colors"
                >
                  Done
                </button>
              </div>

              <div className="space-y-0">
                {thread.map((msg, i) => {
                  const prev = i > 0 ? thread[i - 1] : null;
                  const next = i < thread.length - 1 ? thread[i + 1] : null;

                  const isFirstInGroup =
                    !prev ||
                    prev.is_from_me !== msg.is_from_me ||
                    prev.sender !== msg.sender;
                  const isLastInGroup =
                    !next ||
                    next.is_from_me !== msg.is_from_me ||
                    next.sender !== msg.sender;

                  const isOrigin = msg.guid === originGuid;

                  return (
                    <motion.div
                      key={msg.guid}
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{
                        type: "spring",
                        damping: 25,
                        stiffness: 300,
                        delay: i * 0.04,
                      }}
                    >
                      {isOrigin && thread.length > 1 && (
                        <div className="flex justify-center my-2">
                          <span className="text-[10px] text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                            Original message
                          </span>
                        </div>
                      )}
                      <div className="px-2">
                        <MessageBubble
                          message={msg}
                          showSender={isGroupChat}
                          isFirstInGroup={isFirstInGroup}
                          isLastInGroup={isLastInGroup}
                        />
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
