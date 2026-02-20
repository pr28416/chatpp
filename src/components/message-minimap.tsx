import * as React from "react";
import { Message } from "@/lib/types";
import { format, parseISO } from "date-fns";

const PITCH = 3;
const BAR_H = 2;

interface MessageMinimapProps {
  messages: Message[];
  scrollRef: React.RefObject<HTMLDivElement | null>;
  searchMatchRowids?: Set<number>;
  topSentinelRef?: React.RefObject<HTMLDivElement | null>;
  bottomSentinelRef?: React.RefObject<HTMLDivElement | null>;
}

export function MessageMinimap({
  messages,
  scrollRef,
  searchMatchRowids,
  topSentinelRef,
  bottomSentinelRef,
}: MessageMinimapProps) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const [hoverPos, setHoverPos] = React.useState<{
    x: number;
    y: number;
  } | null>(null);
  const [hoverDate, setHoverDate] = React.useState("");
  const [isDragging, setIsDragging] = React.useState(false);
  const isDraggingRef = React.useRef(false);

  React.useEffect(() => {
    isDraggingRef.current = isDragging;
  }, [isDragging]);

  const hasMedia = React.useMemo(() => {
    return messages.map(
      (m) =>
        m.attachments?.some(
          (a) =>
            a.mime_type?.startsWith("image/") ||
            a.mime_type?.startsWith("video/"),
        ) ?? false,
    );
  }, [messages]);

  const dateKeys = React.useMemo(() => {
    return messages.map((m) => {
      try {
        const d = parseISO(m.date);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      } catch {
        return "";
      }
    });
  }, [messages]);

  const formattedDates = React.useMemo(() => {
    return messages.map((m) => {
      try {
        return format(parseISO(m.date), "MMM d, yyyy  h:mm a");
      } catch {
        return "";
      }
    });
  }, [messages]);

  const scrollState = React.useRef({ top: 0, height: 0, client: 0 });
  const minimapHRef = React.useRef(0);

  const paint = React.useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const w = container.clientWidth;
    const containerH = container.clientHeight;
    if (containerH === 0 || messages.length === 0) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const needW = Math.round(w * dpr);
    const needH = Math.round(containerH * dpr);

    if (canvas.width !== needW || canvas.height !== needH) {
      canvas.width = needW;
      canvas.height = needH;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${containerH}px`;
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, containerH);

    const rawH = messages.length * PITCH;
    const minimapH = Math.min(rawH, containerH);
    minimapHRef.current = minimapH;

    const effectivePitch = minimapH / messages.length;
    const barH = Math.min(BAR_H, Math.max(1, effectivePitch * 0.67));

    const barW = w * 0.42;
    let lastKey = "";

    for (let i = 0; i < messages.length; i++) {
      const y = i * effectivePitch;
      const key = dateKeys[i];

      if (key !== lastKey && i > 0) {
        ctx.strokeStyle = "rgba(120,120,128,0.3)";
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(0, Math.round(y));
        ctx.lineTo(w, Math.round(y));
        ctx.stroke();
      }
      lastKey = key;

      const msg = messages[i];
      const isMedia = hasMedia[i];

      if (msg.is_from_me) {
        ctx.fillStyle = isMedia
          ? "rgba(0,122,255,0.85)"
          : "rgba(0,122,255,0.65)";
        ctx.fillRect(w - barW - 2, y, barW, barH);
        if (isMedia) {
          ctx.fillStyle = "rgba(88,86,214,0.7)";
          ctx.fillRect(w - barW - 5, y, 2, barH);
        }
      } else {
        ctx.fillStyle = isMedia
          ? "rgba(174,174,178,0.8)"
          : "rgba(174,174,178,0.6)";
        ctx.fillRect(2, y, barW, barH);
        if (isMedia) {
          ctx.fillStyle = "rgba(88,86,214,0.7)";
          ctx.fillRect(barW + 5, y, 2, barH);
        }
      }

      if (searchMatchRowids && searchMatchRowids.has(msg.rowid)) {
        ctx.fillStyle = "rgba(250,176,5,0.9)";
        const markerH = Math.max(2, barH);
        ctx.fillRect(0, Math.round(y), w, markerH);
      }
    }

    const {
      top: mainTop,
      height: mainH,
      client: mainClient,
    } = scrollState.current;

    const vpTopCanvas = mainH > 0 ? (mainTop / mainH) * minimapH : 0;
    const vpHCanvas =
      mainH > 0 ? Math.max((mainClient / mainH) * minimapH, 4) : minimapH;

    ctx.fillStyle = "rgba(0,0,0,0.18)";
    ctx.fillRect(0, Math.round(vpTopCanvas), w, Math.round(vpHCanvas));

    ctx.strokeStyle = "rgba(0,0,0,0.22)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      0.5,
      Math.round(vpTopCanvas) + 0.5,
      w - 1,
      Math.round(vpHCanvas),
    );
  }, [messages, hasMedia, dateKeys, searchMatchRowids]);

  React.useEffect(() => {
    paint();
  }, [paint]);

  React.useEffect(() => {
    const el = scrollRef.current;
    const container = containerRef.current;
    if (!el) return;

    let rafId: number | null = null;

    const schedPaint = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        paint();
      });
    };

    const onScroll = () => {
      const topH = topSentinelRef?.current?.offsetHeight ?? 0;
      const botH = bottomSentinelRef?.current?.offsetHeight ?? 0;
      const spacer = 8;

      const msgScrollHeight = Math.max(
        1,
        el.scrollHeight - topH - botH - spacer,
      );
      const msgScrollTop = Math.max(0, el.scrollTop - topH);

      scrollState.current = {
        top: msgScrollTop,
        height: msgScrollHeight,
        client: el.clientHeight,
      };
      schedPaint();
    };

    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });

    const ro = new ResizeObserver(() => {
      schedPaint();
    });
    if (container) ro.observe(container);

    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [scrollRef, paint, topSentinelRef, bottomSentinelRef]);

  const scrollToCanvasY = React.useCallback(
    (clientY: number) => {
      const container = containerRef.current;
      const el = scrollRef.current;
      if (!container || !el) return;

      const rect = container.getBoundingClientRect();
      const canvasY = clientY - rect.top;
      const minimapH = minimapHRef.current;
      if (minimapH === 0) return;

      const ratio = Math.max(0, Math.min(1, canvasY / minimapH));

      const topH = topSentinelRef?.current?.offsetHeight ?? 0;
      const botH = bottomSentinelRef?.current?.offsetHeight ?? 0;
      const spacer = 8;
      const msgScrollHeight = Math.max(
        1,
        el.scrollHeight - topH - botH - spacer,
      );

      el.scrollTop = topH + ratio * (msgScrollHeight - el.clientHeight);
    },
    [scrollRef, topSentinelRef, bottomSentinelRef],
  );

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    scrollToCanvasY(e.clientY);
  };

  React.useEffect(() => {
    if (!isDragging) return;
    const move = (e: MouseEvent) => scrollToCanvasY(e.clientY);
    const up = () => setIsDragging(false);
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, [isDragging, scrollToCanvasY]);

  const handleMouseMove = (e: React.MouseEvent) => {
    const container = containerRef.current;
    if (!container || messages.length === 0) return;

    const rect = container.getBoundingClientRect();
    const canvasY = e.clientY - rect.top;
    const minimapH = minimapHRef.current;
    if (minimapH === 0) return;

    if (canvasY > minimapH) {
      setHoverPos(null);
      setHoverDate("");
      return;
    }

    setHoverPos({ x: rect.left, y: e.clientY });

    const effectivePitch = minimapH / messages.length;
    const idx = Math.min(
      messages.length - 1,
      Math.max(0, Math.floor(canvasY / effectivePitch)),
    );

    setHoverDate(formattedDates[idx] || "");
  };

  const handleMouseLeave = () => {
    setHoverPos(null);
    setHoverDate("");
  };

  if (messages.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative w-12 shrink-0 border-l border-border bg-background cursor-pointer select-none overflow-hidden"
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <canvas ref={canvasRef} className="absolute inset-0" />

      {hoverPos !== null && hoverDate && (
        <div
          className="fixed bg-popover text-popover-foreground text-[10px] font-medium px-2 py-1 rounded-md shadow-md whitespace-nowrap pointer-events-none z-50 border border-border"
          style={{
            top: `${hoverPos.y}px`,
            left: `${hoverPos.x - 8}px`,
            transform: "translate(-100%, -50%)",
          }}
        >
          {hoverDate}
        </div>
      )}
    </div>
  );
}
