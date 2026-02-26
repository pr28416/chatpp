import * as React from "react";
import {
  cancelTimelineIndex,
  getTimelineIndexState,
  getTimelineNodes,
  getTimelineOverview,
  getTimelineRelatedNodes,
  retryTimelineFailedBatches,
  startTimelineIndex,
} from "@/lib/commands";
import type {
  TimelineJobState,
  TimelineLevel,
  TimelineNode,
  TimelineOverview,
} from "@/lib/types";
import { format, parseISO } from "date-fns";
import { ChevronDown, Ellipsis, Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface TimelinePaneProps {
  chatId: number;
  onJumpToRowid: (rowid: number) => void;
}

const LEVEL_LABELS: Record<TimelineLevel, string> = {
  0: "Eras",
  1: "Topics",
  2: "Subtopics",
  3: "Moments",
};

const POLL_MS = 1000;

type NodeGroup = {
  key: string;
  title: string;
  nodes: TimelineNode[];
};

export function TimelinePane({ chatId, onJumpToRowid }: TimelinePaneProps) {
  const [jobState, setJobState] = React.useState<TimelineJobState | null>(null);
  const [overview, setOverview] = React.useState<TimelineOverview | null>(null);
  const [nodes, setNodes] = React.useState<TimelineNode[]>([]);
  const [parentNodes, setParentNodes] = React.useState<TimelineNode[]>([]);
  const [relatedNodes, setRelatedNodes] = React.useState<TimelineNode[]>([]);
  const [zoomLevel, setZoomLevel] = React.useState<TimelineLevel>(0);
  const [selectedNodeId, setSelectedNodeId] = React.useState<number | null>(null);
  const [expandedRationaleNodeId, setExpandedRationaleNodeId] = React.useState<number | null>(
    null,
  );
  const [groupCollapsed, setGroupCollapsed] = React.useState<Record<string, boolean>>({});
  const [loadingNodes, setLoadingNodes] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);

  const selectedNodeIdRef = React.useRef<number | null>(null);
  const selectedAnchorRowidRef = React.useRef<number | null>(null);
  const listScrollRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

  const isRunning = jobState?.status === "running";
  const isCanceling = jobState?.status === "canceling";
  const isBusy = isRunning || isCanceling;
  const hasIndex = overview?.indexed ?? false;
  const isStale = !!overview && overview.source_max_rowid > overview.indexed_max_rowid;
  const health = normalizeHealth(overview?.index_health);
  const showEmptyState = !hasIndex && !isBusy;

  const selectedNode = React.useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? null,
    [nodes, selectedNodeId],
  );

  const groupedNodes = React.useMemo<NodeGroup[]>(() => {
    if (nodes.length === 0) return [];
    if (zoomLevel === 0) {
      return [{ key: "root", title: LEVEL_LABELS[0], nodes: [...nodes].sort(sortTimelineNodes) }];
    }

    const parentTitleById = new Map<number, string>();
    for (const p of parentNodes) {
      parentTitleById.set(p.id, p.title || "Untitled Group");
    }

    const grouped = new Map<string, TimelineNode[]>();
    for (const node of nodes) {
      const key = node.parent_id !== null ? String(node.parent_id) : "ungrouped";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(node);
    }

    const result: NodeGroup[] = [];
    for (const [key, group] of grouped.entries()) {
      const title =
        key === "ungrouped"
          ? "Ungrouped"
          : parentTitleById.get(Number(key)) ?? "Ungrouped";
      result.push({ key, title, nodes: [...group].sort(sortTimelineNodes) });
    }

    const parentOrder = new Map<number, number>();
    [...parentNodes].sort(sortTimelineNodes).forEach((p, i) => parentOrder.set(p.id, i));
    result.sort((a, b) => {
      if (a.key === "ungrouped") return 1;
      if (b.key === "ungrouped") return -1;
      return (parentOrder.get(Number(a.key)) ?? 9999) - (parentOrder.get(Number(b.key)) ?? 9999);
    });

    return result;
  }, [nodes, parentNodes, zoomLevel]);

  const refreshStatus = React.useCallback(async () => {
    try {
      const [nextOverview, nextJob] = await Promise.all([
        getTimelineOverview(chatId),
        getTimelineIndexState(chatId),
      ]);
      setOverview(nextOverview);
      setJobState(nextJob);
      setError(null);
    } catch (err) {
      console.error("Failed to refresh timeline status", err);
      setError(`Failed to load timeline status: ${formatUnknownError(err)}`);
    }
  }, [chatId]);

  const refreshNodes = React.useCallback(async () => {
    if (!overview?.indexed) {
      setNodes([]);
      setParentNodes([]);
      setRelatedNodes([]);
      return;
    }

    const previousScroll = listScrollRef.current?.scrollTop ?? null;
    const anchorTarget = selectedAnchorRowidRef.current;
    const preferredNodeId = selectedNodeIdRef.current;

    setLoadingNodes(true);
    try {
      const [currentLevel, parentLevel] = await Promise.all([
        getTimelineNodes(chatId, zoomLevel, null),
        zoomLevel > 0
          ? getTimelineNodes(chatId, (zoomLevel - 1) as TimelineLevel, null)
          : Promise.resolve({ nodes: [] as TimelineNode[] }),
      ]);

      setNodes(currentLevel.nodes);
      setParentNodes(parentLevel.nodes);

      const nextSelected = chooseNodeForAnchor(
        currentLevel.nodes,
        anchorTarget,
        preferredNodeId,
      );
      setSelectedNodeId(nextSelected?.id ?? null);
      if (nextSelected) {
        selectedAnchorRowidRef.current = nextSelected.representative_rowid;
      }

      if (previousScroll !== null) {
        requestAnimationFrame(() => {
          if (listScrollRef.current) {
            listScrollRef.current.scrollTop = previousScroll;
          }
        });
      }

      setError(null);
    } catch (err) {
      console.error("Failed to load timeline nodes", err);
      setError(`Failed to load timeline nodes: ${formatUnknownError(err)}`);
    } finally {
      setLoadingNodes(false);
    }
  }, [chatId, overview?.indexed, zoomLevel]);

  React.useEffect(() => {
    setNodes([]);
    setParentNodes([]);
    setSelectedNodeId(null);
    selectedNodeIdRef.current = null;
    selectedAnchorRowidRef.current = null;
    setExpandedRationaleNodeId(null);
    setRelatedNodes([]);
    setGroupCollapsed({});
    setZoomLevel(0);
    setError(null);
    void refreshStatus();
  }, [chatId, refreshStatus]);

  React.useEffect(() => {
    void refreshNodes();
  }, [refreshNodes, isRunning]);

  React.useEffect(() => {
    if (selectedNodeId === null) {
      setRelatedNodes([]);
      return;
    }
    let canceled = false;
    (async () => {
      try {
        const related = await getTimelineRelatedNodes(selectedNodeId, 6);
        if (!canceled) {
          setRelatedNodes(related.nodes);
        }
      } catch (err) {
        if (!canceled) {
          setError(`Failed to load related topics: ${formatUnknownError(err)}`);
        }
      }
    })();
    return () => {
      canceled = true;
    };
  }, [selectedNodeId]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      void refreshStatus();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  const handleStartIndex = React.useCallback(
    async (fullRebuild: boolean) => {
      try {
        const started = await startTimelineIndex(chatId, fullRebuild, false);
        setJobState(started);
        setError(null);
      } catch (err) {
        console.error("Failed to start timeline index", err);
        setError(`Failed to start timeline indexing: ${formatUnknownError(err)}`);
      }
    },
    [chatId],
  );

  const handleRetryFailed = React.useCallback(async () => {
    try {
      const state = await retryTimelineFailedBatches(chatId);
      setJobState(state);
      setError(null);
    } catch (err) {
      console.error("Failed to retry failed batches", err);
      setError(`Failed to retry failed batches: ${formatUnknownError(err)}`);
    }
  }, [chatId]);

  const handleCancel = React.useCallback(async () => {
    try {
      const nextState = await cancelTimelineIndex(chatId);
      setJobState(nextState);
      setMenuOpen(false);
    } catch (err) {
      console.error("Failed to cancel timeline job", err);
      setError(`Failed to cancel indexing: ${formatUnknownError(err)}`);
    }
  }, [chatId]);

  const selectNode = React.useCallback(
    (node: TimelineNode) => {
      setSelectedNodeId(node.id);
      selectedNodeIdRef.current = node.id;
      selectedAnchorRowidRef.current = node.representative_rowid;
      onJumpToRowid(node.representative_rowid);
    },
    [onJumpToRowid],
  );

  const decrementZoom = React.useCallback(() => {
    setZoomLevel((prev) => Math.max(0, prev - 1) as TimelineLevel);
  }, []);

  const incrementZoom = React.useCallback(() => {
    setZoomLevel((prev) => Math.min(3, prev + 1) as TimelineLevel);
  }, []);

  return (
    <div className="w-[420px] shrink-0 border-l border-border bg-card/60 flex flex-col h-full">
      <div className="px-3 py-2.5 border-b border-border flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
          <p className="text-[11px] text-muted-foreground">AI-only adaptive indexing</p>
        </div>

        {hasIndex && (
          <div className="flex items-center rounded-full border border-border bg-background h-8">
            <button
              type="button"
              onClick={decrementZoom}
              disabled={zoomLevel === 0 || loadingNodes}
              className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label="Zoom out"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>
            <span className="text-xs font-medium text-foreground px-2 min-w-20 text-center">
              {LEVEL_LABELS[zoomLevel]}
            </span>
            <button
              type="button"
              onClick={incrementZoom}
              disabled={zoomLevel === 3 || loadingNodes}
              className="h-8 w-8 grid place-items-center text-muted-foreground hover:text-foreground disabled:opacity-40"
              aria-label="Zoom in"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>

      {!showEmptyState && (
        <div className="px-3 py-2 border-b border-border flex items-center justify-between gap-2">
          <Button size="sm" onClick={() => handleStartIndex(false)} disabled={isBusy} className="h-8">
            {hasIndex ? "Update" : "Start indexing"}
          </Button>

          <Popover open={menuOpen} onOpenChange={setMenuOpen}>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon-sm" className="h-8 w-8">
                <Ellipsis className="h-4 w-4" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-44 p-1.5">
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => {
                    void handleStartIndex(true);
                    setMenuOpen(false);
                  }}
                  disabled={isBusy}
                  className="w-full text-left text-xs px-2.5 py-2 rounded-md hover:bg-muted disabled:opacity-40"
                >
                  Rebuild index
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void handleRetryFailed();
                    setMenuOpen(false);
                  }}
                  disabled={isBusy || !(jobState?.failed_batches ?? 0)}
                  className="w-full text-left text-xs px-2.5 py-2 rounded-md hover:bg-muted disabled:opacity-40"
                >
                  Retry failed
                </button>
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={!isBusy}
                  className="w-full text-left text-xs px-2.5 py-2 rounded-md hover:bg-muted disabled:opacity-40"
                >
                  Cancel run
                </button>
              </div>
            </PopoverContent>
          </Popover>
        </div>
      )}

      {(isBusy || (hasIndex && isStale)) && (
        <div className="px-3 py-2 border-b border-border text-[11px] text-muted-foreground">
          {isBusy ? (
            <div className="flex items-center justify-between">
              <span>
                {jobState?.phase ?? "processing"}
                {isCanceling ? " (stopping)" : ""}
              </span>
              <span>{Math.round((jobState?.progress ?? 0) * 100)}%</span>
            </div>
          ) : (
            <span className="text-amber-600">New messages detected</span>
          )}
        </div>
      )}

      {error && (
        <div className="px-3 py-2 border-b border-border text-[11px] text-red-500">{error}</div>
      )}

      {showEmptyState && (
        <div className="p-4 text-sm text-muted-foreground space-y-2">
          <p>
            Build a local AI timeline index for this chat. Node titles, summaries, and grouping are
            generated by AI.
          </p>
          <Button size="sm" onClick={() => handleStartIndex(false)} className="h-8">
            Start indexing
          </Button>
        </div>
      )}

      {hasIndex && (
        <div ref={listScrollRef} className="flex-1 min-h-0 overflow-y-auto p-3">
          {loadingNodes && (
            <div className="px-1 py-4 text-xs text-muted-foreground">Loading timeline...</div>
          )}

          {!loadingNodes && groupedNodes.length === 0 && (
            <div className="px-1 py-4 text-xs text-muted-foreground">
              No {LEVEL_LABELS[zoomLevel].toLowerCase()} found. Try zooming in or out.
            </div>
          )}

          {!loadingNodes && groupedNodes.length > 0 && (
            <div className="space-y-3 transition-all ease-out" style={{ transitionDuration: "220ms" }}>
              {groupedNodes.map((group) => {
                const collapsed = groupCollapsed[group.key] ?? false;
                return (
                  <section key={group.key} className="space-y-2">
                    {zoomLevel > 0 && (
                      <button
                        type="button"
                        onClick={() =>
                          setGroupCollapsed((prev) => ({
                            ...prev,
                            [group.key]: !collapsed,
                          }))
                        }
                        className="w-full flex items-center justify-between rounded-md border border-border bg-background/80 px-2 py-1.5 text-[11px] font-medium text-foreground"
                      >
                        <span className="line-clamp-1 text-left">{group.title}</span>
                        <ChevronDown
                          className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
                            collapsed ? "-rotate-90" : "rotate-0"
                          }`}
                        />
                      </button>
                    )}

                    {!collapsed && (
                      <div className="space-y-2">
                        {group.nodes.map((node, index) => {
                          const selected = node.id === selectedNodeId;
                          const tone = toneForLevel(node.level);
                          const showWhy = expandedRationaleNodeId === node.id && !!node.ai_rationale;
                          const isLastInGroup = index === group.nodes.length - 1;
                          return (
                            <div
                              key={node.id}
                              className="grid grid-cols-[20px_minmax(0,1fr)] gap-2 transition-all"
                              style={{ transitionDuration: "220ms" }}
                            >
                              <div className="relative flex justify-center">
                                {!isLastInGroup && (
                                  <span className={`absolute top-3.5 bottom-[-10px] w-[2px] ${tone.line}`} />
                                )}
                                <span
                                  className={`mt-1 h-2.5 w-2.5 rounded-full border-2 ${
                                    selected
                                      ? `${tone.markerSelected} ring-2 ring-offset-1 ring-offset-background ring-primary/50`
                                      : tone.marker
                                  }`}
                                />
                              </div>

                              <button
                                type="button"
                                onClick={() => selectNode(node)}
                                className={`w-full text-left rounded-lg border p-2.5 transition-all ${
                                  selected
                                    ? "bg-accent border-primary/45"
                                    : "bg-background border-border hover:bg-muted/40"
                                }`}
                                style={{ transitionDuration: "140ms" }}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs font-semibold text-foreground leading-tight line-clamp-1">
                                    {node.title}
                                  </p>
                                  <span className="text-[10px] text-muted-foreground shrink-0">
                                    {node.is_draft ? "draft" : `${Math.round(node.confidence * 100)}%`}
                                  </span>
                                </div>

                                <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed line-clamp-6">
                                  {node.summary}
                                </p>

                                {node.ai_rationale && (
                                  <div className="mt-1.5">
                                    <button
                                      type="button"
                                      onClick={(evt) => {
                                        evt.stopPropagation();
                                        setExpandedRationaleNodeId((prev) =>
                                          prev === node.id ? null : node.id,
                                        );
                                      }}
                                      className="text-[10px] text-muted-foreground hover:text-foreground"
                                    >
                                      {showWhy ? "Hide why" : "Show why"}
                                    </button>
                                    {showWhy && (
                                      <p className="mt-1 text-[10px] text-muted-foreground/90 leading-relaxed">
                                        {node.ai_rationale}
                                      </p>
                                    )}
                                  </div>
                                )}

                                <div className="text-[10px] text-muted-foreground mt-2 flex items-center justify-between gap-2">
                                  <span>{node.message_count} msgs · {node.reply_count} replies</span>
                                  <span>{formatDateRange(node.start_ts, node.end_ts)}</span>
                                </div>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                );
              })}

              {selectedNode && relatedNodes.length > 0 && (
                <div className="rounded-lg border border-border bg-background p-2.5">
                  <p className="text-[11px] font-medium text-foreground">Related topics</p>
                  <div className="mt-2 space-y-1.5">
                    {relatedNodes.map((node) => (
                      <button
                        key={`related-${node.id}`}
                        type="button"
                        onClick={() => {
                          setSelectedNodeId(node.id);
                          selectedNodeIdRef.current = node.id;
                          selectedAnchorRowidRef.current = node.representative_rowid;
                          onJumpToRowid(node.representative_rowid);
                        }}
                        className="w-full text-left rounded-md border border-border px-2 py-1.5 hover:bg-muted/50"
                      >
                        <p className="text-[10px] font-medium text-foreground line-clamp-1">{node.title}</p>
                        <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">
                          {node.summary}
                        </p>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {hasIndex && (
        <div className="px-3 py-2 border-t border-border text-[10px] text-muted-foreground flex items-center justify-between">
          <span>{health}</span>
          {selectedNode && <span>Anchor {selectedNode.representative_rowid}</span>}
        </div>
      )}
    </div>
  );
}

function chooseNodeForAnchor(
  nodes: TimelineNode[],
  anchorRowid: number | null,
  preferredNodeId: number | null,
): TimelineNode | null {
  if (nodes.length === 0) return null;

  if (preferredNodeId !== null) {
    const exact = nodes.find((n) => n.id === preferredNodeId);
    if (exact) return exact;
  }

  if (anchorRowid !== null) {
    const containing = nodes
      .filter((node) => node.start_rowid <= anchorRowid && node.end_rowid >= anchorRowid)
      .sort((a, b) => (a.end_rowid - a.start_rowid) - (b.end_rowid - b.start_rowid))[0];
    if (containing) return containing;

    let nearest = nodes[0];
    let nearestDistance = Math.abs(nodes[0].representative_rowid - anchorRowid);
    for (const node of nodes.slice(1)) {
      const distance = Math.abs(node.representative_rowid - anchorRowid);
      if (distance < nearestDistance) {
        nearest = node;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  return nodes[0];
}

function sortTimelineNodes(a: TimelineNode, b: TimelineNode): number {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  if (a.start_rowid !== b.start_rowid) return a.start_rowid - b.start_rowid;
  return a.id - b.id;
}

function toneForLevel(level: TimelineLevel) {
  if (level === 0) {
    return {
      line: "bg-slate-300/80",
      marker: "bg-slate-100 border-slate-400",
      markerSelected: "bg-slate-100 border-slate-600",
    };
  }
  if (level === 1) {
    return {
      line: "bg-blue-300/80",
      marker: "bg-blue-100 border-blue-400",
      markerSelected: "bg-blue-100 border-blue-600",
    };
  }
  if (level === 2) {
    return {
      line: "bg-teal-300/80",
      marker: "bg-teal-100 border-teal-500",
      markerSelected: "bg-teal-100 border-teal-700",
    };
  }
  return {
    line: "bg-indigo-300/80",
    marker: "bg-indigo-100 border-indigo-500",
    markerSelected: "bg-indigo-100 border-indigo-700",
  };
}

function normalizeHealth(health: TimelineOverview["index_health"] | string | undefined): string {
  if (!health || health.trim().length === 0) return "stale";
  return health;
}

function formatDateRange(start: string, end: string): string {
  try {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    return `${format(startDate, "MMM d")} - ${format(endDate, "MMM d")}`;
  } catch {
    return "";
  }
}

function formatUnknownError(err: unknown): string {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err !== null) {
    const maybeMessage = (err as { message?: unknown }).message;
    if (typeof maybeMessage === "string" && maybeMessage.trim().length > 0) {
      return maybeMessage;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return "non-serializable error";
    }
  }
  return String(err);
}
