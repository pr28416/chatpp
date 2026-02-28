import * as React from "react";

export function useRowidJumpBridge() {
  const [requestedJumpRowid, setRequestedJumpRowid] = React.useState<number | null>(null);
  const [activeHighlightRowid, setActiveHighlightRowid] = React.useState<number | null>(null);

  const requestJump = React.useCallback((rowid: number) => {
    setRequestedJumpRowid(rowid);
  }, []);

  const acknowledgeJump = React.useCallback((rowid: number) => {
    setRequestedJumpRowid((current) => (current === rowid ? null : current));
  }, []);

  return {
    requestedJumpRowid,
    activeHighlightRowid,
    requestJump,
    acknowledgeJump,
    setActiveHighlightRowid,
  };
}
