import * as React from "react";

interface RequestedJump {
  rowid: number;
  chatId: number | null;
}

export function useRowidJumpBridge() {
  const [requestedJump, setRequestedJump] = React.useState<RequestedJump | null>(null);
  const [activeHighlightRowid, setActiveHighlightRowid] = React.useState<number | null>(null);

  const requestJump = React.useCallback((rowid: number, chatId: number | null = null) => {
    setRequestedJump({ rowid, chatId });
  }, []);

  const acknowledgeJump = React.useCallback((rowid: number, chatId: number | null = null) => {
    setRequestedJump((current) => {
      if (!current) return current;
      if (current.rowid !== rowid) return current;
      if ((current.chatId ?? null) !== (chatId ?? null)) return current;
      return null;
    });
  }, []);

  return {
    requestedJumpRowid: requestedJump?.rowid ?? null,
    requestedJumpChatId: requestedJump?.chatId ?? null,
    activeHighlightRowid,
    requestJump,
    acknowledgeJump,
    setActiveHighlightRowid,
  };
}
