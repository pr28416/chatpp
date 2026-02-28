import * as React from "react";
import {
  cancelTimelineIndex,
  getTimelineGroupChildren,
  getTimelineIndexState,
  getTimelineNodeMessageRowids,
  getTimelineNodeMessageRowidsByNode,
  getTimelineNodeOccurrences,
  getTimelineNodes,
  getTimelineOverview,
  getTimelineRelatedNodes,
  retryTimelineFailedBatches,
  startTimelineIndex,
} from "@/lib/commands";
import type {
  PerChatTimelineUiState,
  TimelineJobState,
  TimelineLevel,
  TimelineNode,
  TimelineOccurrence,
  TimelineOverview,
} from "@/lib/types";
import { format, parseISO } from "date-fns";
import {
  ArrowLeft,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Ellipsis,
  Hash,
  Info,
  ListTree,
  MessageCircle,
  RefreshCw,
  Search,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface TimelinePaneProps {
  chatId: number;
  onJumpToRowid: (rowid: number) => void;
  initialUiState?: PerChatTimelineUiState;
  onUiStateChange?: (state: PerChatTimelineUiState) => void;
  embedded?: boolean;
}

type TimelineView = "topics_list" | "topic_detail";

type RowidLoadResult = {
  rowids: number[];
  capped: boolean;
};

const POLL_MS = 1000;
const DEFAULT_ROWID_LIMIT = 5000;

const DEFAULT_UI_STATE: PerChatTimelineUiState = {
  view: "topics_list",
  topicQuery: "",
  selectedTopicId: null,
  selectedDetailNodeId: null,
  expandedSubtopicIds: {},
  selectedOccurrenceIdxByNode: {},
};

export function TimelinePane({
  chatId,
  onJumpToRowid,
  initialUiState,
  onUiStateChange,
  embedded = false,
}: TimelinePaneProps) {
  const [jobState, setJobState] = React.useState<TimelineJobState | null>(null);
  const [overview, setOverview] = React.useState<TimelineOverview | null>(null);
  const [topics, setTopics] = React.useState<TimelineNode[]>([]);
  const [childrenByParent, setChildrenByParent] = React.useState<Record<number, TimelineNode[]>>({});
  const [occurrencesByNode, setOccurrencesByNode] = React.useState<Record<number, TimelineOccurrence[]>>({});
  const [relatedNodes, setRelatedNodes] = React.useState<TimelineNode[]>([]);

  const [view, setView] = React.useState<TimelineView>("topics_list");
  const [topicQuery, setTopicQuery] = React.useState("");
  const [selectedTopicId, setSelectedTopicId] = React.useState<number | null>(null);
  const [selectedDetailNodeId, setSelectedDetailNodeId] = React.useState<number | null>(null);
  const [expandedSubtopicIds, setExpandedSubtopicIds] = React.useState<Record<number, boolean>>({});
  const [selectedOccurrenceIdxByNode, setSelectedOccurrenceIdxByNode] = React.useState<
    Record<number, number>
  >({});

  const [selectedNodeRowids, setSelectedNodeRowids] = React.useState<number[]>([]);
  const [selectedNodeRowidIdx, setSelectedNodeRowidIdx] = React.useState(0);
  const [rowidsCapped, setRowidsCapped] = React.useState(false);

  const [loadingTopics, setLoadingTopics] = React.useState(false);
  const [loadingTopicTree, setLoadingTopicTree] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [rationaleOpenNodeId, setRationaleOpenNodeId] = React.useState<number | null>(null);
  const [rationalePinnedNodeId, setRationalePinnedNodeId] = React.useState<number | null>(null);
  const [topicsListScrollTop, setTopicsListScrollTop] = React.useState(0);

  const topicsListRef = React.useRef<HTMLDivElement | null>(null);
  const selectedAnchorRowidRef = React.useRef<number | null>(null);
  const childrenByParentRef = React.useRef<Record<number, TimelineNode[]>>({});
  const selectedTopicIdRef = React.useRef<number | null>(null);
  const selectedDetailNodeIdRef = React.useRef<number | null>(null);

  React.useEffect(() => {
    childrenByParentRef.current = childrenByParent;
  }, [childrenByParent]);

  React.useEffect(() => {
    selectedTopicIdRef.current = selectedTopicId;
  }, [selectedTopicId]);

  React.useEffect(() => {
    selectedDetailNodeIdRef.current = selectedDetailNodeId;
  }, [selectedDetailNodeId]);

  const isRunning = jobState?.status === "running";
  const isCanceling = jobState?.status === "canceling";
  const isBusy = isRunning || isCanceling;
  const hasIndex = overview?.indexed ?? false;
  const isStale = !!overview && overview.source_max_rowid > overview.indexed_max_rowid;
  const showEmptyState = !hasIndex && !isBusy;

  const sortedTopics = React.useMemo(() => [...topics].sort(sortTimelineNodes), [topics]);

  const filteredTopics = React.useMemo(() => {
    const q = topicQuery.trim().toLowerCase();
    if (!q) {
      return sortedTopics;
    }
    return sortedTopics.filter((topic) => {
      const haystack = `${topic.title} ${topic.summary}`.toLowerCase();
      return haystack.includes(q);
    });
  }, [topicQuery, sortedTopics]);

  const selectedTopic = React.useMemo(
    () => sortedTopics.find((topic) => topic.id === selectedTopicId) ?? null,
    [selectedTopicId, sortedTopics],
  );

  const selectedSubtopics = React.useMemo(() => {
    if (!selectedTopic) {
      return [] as TimelineNode[];
    }
    return [...(childrenByParent[selectedTopic.id] ?? [])].sort(sortTimelineNodes);
  }, [childrenByParent, selectedTopic]);

  const selectedMomentsBySubtopic = React.useMemo(() => {
    const out: Record<number, TimelineNode[]> = {};
    for (const subtopic of selectedSubtopics) {
      out[subtopic.id] = [...(childrenByParent[subtopic.id] ?? [])].sort(sortTimelineNodes);
    }
    return out;
  }, [childrenByParent, selectedSubtopics]);

  const selectedDetailNode = React.useMemo(() => {
    if (!selectedTopic) {
      return null;
    }
    if (selectedDetailNodeId === null || selectedDetailNodeId === selectedTopic.id) {
      return selectedTopic;
    }

    for (const subtopic of selectedSubtopics) {
      if (subtopic.id === selectedDetailNodeId) {
        return subtopic;
      }
      const momentsForSubtopic: TimelineNode[] = selectedMomentsBySubtopic[subtopic.id] ?? [];
      for (const momentNode of momentsForSubtopic) {
        if (momentNode.id === selectedDetailNodeId) {
          return momentNode;
        }
      }
    }

    return selectedTopic;
  }, [selectedDetailNodeId, selectedMomentsBySubtopic, selectedSubtopics, selectedTopic]);

  const selectedDetailOccurrences = React.useMemo(() => {
    if (!selectedDetailNode) {
      return [] as TimelineOccurrence[];
    }
    return occurrencesByNode[selectedDetailNode.id] ?? [];
  }, [occurrencesByNode, selectedDetailNode]);

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

  const ensureOccurrences = React.useCallback(async (nodeId: number) => {
    const existing = occurrencesByNode[nodeId];
    if (existing) {
      return existing;
    }
    try {
      const resp = await getTimelineNodeOccurrences(nodeId);
      setOccurrencesByNode((prev) => ({ ...prev, [nodeId]: resp.occurrences }));
      return resp.occurrences;
    } catch {
      setOccurrencesByNode((prev) => ({ ...prev, [nodeId]: [] }));
      return [] as TimelineOccurrence[];
    }
  }, [occurrencesByNode]);

  const ensureChildrenLoaded = React.useCallback(async (parentId: number, childLevel: TimelineLevel) => {
    const existing = childrenByParentRef.current[parentId];
    if (existing) {
      return existing;
    }
    try {
      const resp = await getTimelineGroupChildren(parentId, childLevel);
      const deduped = dedupeNodes(resp.nodes).sort(sortTimelineNodes);
      setChildrenByParent((prev) => {
        if (prev[parentId]) {
          return prev;
        }
        return {
          ...prev,
          [parentId]: deduped,
        };
      });
      return deduped;
    } catch {
      setChildrenByParent((prev) => {
        if (prev[parentId]) {
          return prev;
        }
        return {
          ...prev,
          [parentId]: [],
        };
      });
      return [] as TimelineNode[];
    }
  }, []);

  const loadRowidsForNode = React.useCallback(
    async (node: TimelineNode): Promise<RowidLoadResult> => {
      let rowids = await getTimelineNodeMessageRowidsByNode(
        chatId,
        node.id,
        "all_occurrences",
        undefined,
        DEFAULT_ROWID_LIMIT,
      );
      if (rowids.length === 0) {
        rowids = await getTimelineNodeMessageRowids(
          chatId,
          node.start_rowid,
          node.end_rowid,
          DEFAULT_ROWID_LIMIT,
        );
      }
      return {
        rowids,
        capped: rowids.length >= DEFAULT_ROWID_LIMIT,
      };
    },
    [chatId],
  );

  const refreshTopics = React.useCallback(async () => {
    if (!overview?.indexed) {
      setTopics([]);
      setChildrenByParent({});
      setRelatedNodes([]);
      setOccurrencesByNode({});
      setSelectedTopicId(null);
      setSelectedDetailNodeId(null);
      setSelectedNodeRowids([]);
      setSelectedNodeRowidIdx(0);
      setRowidsCapped(false);
      setView("topics_list");
      return;
    }

    setLoadingTopics(true);
    try {
      const resp = await getTimelineNodes(chatId, 2, null);
      const nextTopics = resp.nodes.sort(sortTimelineNodes);
      setTopics(nextTopics);

      const topicId = selectedTopicIdRef.current;
      const hasSelectedTopic = topicId !== null && nextTopics.some((topic) => topic.id === topicId);

      if (view === "topic_detail" && !hasSelectedTopic) {
        setView("topics_list");
        setSelectedTopicId(null);
        setSelectedDetailNodeId(null);
        setSelectedNodeRowids([]);
        setSelectedNodeRowidIdx(0);
        setRowidsCapped(false);
      }

      if (hasSelectedTopic && selectedDetailNodeIdRef.current === null) {
        setSelectedDetailNodeId(topicId);
      }

      setError(null);
    } catch (err) {
      console.error("Failed to load timeline topics", err);
      setError(`Failed to load timeline topics: ${formatUnknownError(err)}`);
    } finally {
      setLoadingTopics(false);
    }
  }, [chatId, overview?.indexed, view]);

  React.useEffect(() => {
    const normalized = normalizeTimelineUiState(initialUiState);

    setTopics([]);
    setChildrenByParent({});
    setRelatedNodes([]);
    setOccurrencesByNode({});

    setView(normalized.view);
    setTopicQuery(normalized.topicQuery);
    setSelectedTopicId(normalized.selectedTopicId);
    setSelectedDetailNodeId(normalized.selectedDetailNodeId);
    setExpandedSubtopicIds(normalized.expandedSubtopicIds);
    setSelectedOccurrenceIdxByNode(normalized.selectedOccurrenceIdxByNode);

    setSelectedNodeRowids([]);
    setSelectedNodeRowidIdx(0);
    setRowidsCapped(false);
    setError(null);
    setMenuOpen(false);
    setRationaleOpenNodeId(null);
    setRationalePinnedNodeId(null);
    setTopicsListScrollTop(0);
    selectedAnchorRowidRef.current = null;

    void refreshStatus();
    // snapshot hydration only on chat switch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, refreshStatus]);

  React.useEffect(() => {
    onUiStateChange?.({
      view,
      topicQuery,
      selectedTopicId,
      selectedDetailNodeId,
      expandedSubtopicIds,
      selectedOccurrenceIdxByNode,
    });
  }, [
    expandedSubtopicIds,
    onUiStateChange,
    selectedDetailNodeId,
    selectedOccurrenceIdxByNode,
    selectedTopicId,
    topicQuery,
    view,
  ]);

  React.useEffect(() => {
    void refreshTopics();
  }, [refreshTopics, isRunning]);

  React.useEffect(() => {
    const id = window.setInterval(() => {
      void refreshStatus();
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshStatus]);

  React.useEffect(() => {
    if (view !== "topic_detail" || !selectedTopic) {
      return;
    }

    let canceled = false;

    (async () => {
      setLoadingTopicTree(true);
      const subtopics = await ensureChildrenLoaded(selectedTopic.id, 1);
      const momentBatches = await Promise.all(
        subtopics.map((subtopic) => ensureChildrenLoaded(subtopic.id, 0)),
      );

      if (canceled) {
        return;
      }

      const validNodeIds = new Set<number>([selectedTopic.id]);
      for (const subtopic of subtopics) {
        validNodeIds.add(subtopic.id);
      }
      for (const moments of momentBatches) {
        for (const moment of moments) {
          validNodeIds.add(moment.id);
        }
      }

      const currentDetailId = selectedDetailNodeIdRef.current;
      if (currentDetailId === null || !validNodeIds.has(currentDetailId)) {
        setSelectedDetailNodeId(selectedTopic.id);
      }

      setLoadingTopicTree(false);
    })().catch((err) => {
      if (!canceled) {
        setLoadingTopicTree(false);
        setError(`Failed to load topic details: ${formatUnknownError(err)}`);
      }
    });

    return () => {
      canceled = true;
    };
  }, [ensureChildrenLoaded, selectedTopic, view]);

  React.useEffect(() => {
    if (view !== "topic_detail" || !selectedDetailNode) {
      setRelatedNodes([]);
      return;
    }

    let canceled = false;
    (async () => {
      await ensureOccurrences(selectedDetailNode.id);
      try {
        const related = await getTimelineRelatedNodes(selectedDetailNode.id, 6);
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
  }, [ensureOccurrences, selectedDetailNode, view]);

  React.useEffect(() => {
    if (view !== "topics_list") {
      return;
    }
    requestAnimationFrame(() => {
      if (topicsListRef.current) {
        topicsListRef.current.scrollTop = topicsListScrollTop;
      }
    });
  }, [topicsListScrollTop, view]);

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

  const jumpToNode = React.useCallback(
    async (
      node: TimelineNode,
      options?: {
        occurrenceIdx?: number;
        anchorRowid?: number;
        reloadRowids?: boolean;
        updateDetailSelection?: boolean;
      },
    ) => {
      const reloadRowids = options?.reloadRowids ?? true;
      const updateDetailSelection = options?.updateDetailSelection ?? true;
      const occurrenceIdx = options?.occurrenceIdx ?? 0;

      const localOccurrences = await ensureOccurrences(node.id);
      const selectedOccurrence = localOccurrences[
        Math.max(0, Math.min(occurrenceIdx, localOccurrences.length - 1))
      ];
      const anchor =
        options?.anchorRowid ?? selectedOccurrence?.representative_rowid ?? node.representative_rowid;

      selectedAnchorRowidRef.current = anchor;
      setSelectedOccurrenceIdxByNode((prev) => ({ ...prev, [node.id]: occurrenceIdx }));

      if (updateDetailSelection) {
        setSelectedDetailNodeId(node.id);
      }

      onJumpToRowid(anchor);

      if (reloadRowids) {
        try {
          const loaded = await loadRowidsForNode(node);
          setSelectedNodeRowids(loaded.rowids);
          setRowidsCapped(loaded.capped);
          const nearestIdx = Math.max(0, loaded.rowids.findIndex((r) => r >= anchor));
          setSelectedNodeRowidIdx(nearestIdx === -1 ? 0 : nearestIdx);
        } catch {
          setSelectedNodeRowids([]);
          setSelectedNodeRowidIdx(0);
          setRowidsCapped(false);
        }
      } else {
        const nearestIdx = Math.max(0, selectedNodeRowids.findIndex((r) => r >= anchor));
        setSelectedNodeRowidIdx(nearestIdx === -1 ? 0 : nearestIdx);
      }
    },
    [ensureOccurrences, loadRowidsForNode, onJumpToRowid, selectedNodeRowids],
  );

  const jumpWithinSelectedNode = React.useCallback(
    (nextIdx: number) => {
      if (selectedNodeRowids.length === 0) {
        return;
      }
      const clamped = Math.max(0, Math.min(selectedNodeRowids.length - 1, nextIdx));
      setSelectedNodeRowidIdx(clamped);
      onJumpToRowid(selectedNodeRowids[clamped]);
    },
    [onJumpToRowid, selectedNodeRowids],
  );

  const handleTopicClick = React.useCallback(
    async (topic: TimelineNode) => {
      if (topicsListRef.current) {
        setTopicsListScrollTop(topicsListRef.current.scrollTop);
      }
      setSelectedTopicId(topic.id);
      setSelectedDetailNodeId(topic.id);
      setView("topic_detail");
      await jumpToNode(topic, { updateDetailSelection: true, reloadRowids: true });
    },
    [jumpToNode],
  );

  const handleBackToTopics = React.useCallback(() => {
    setView("topics_list");
  }, []);

  const resolveTopicIdForNode = React.useCallback(
    (node: TimelineNode): number | null => {
      if (node.level === 2) {
        return node.id;
      }
      if (node.level === 1) {
        return node.parent_id;
      }
      if (node.level === 0 && node.parent_id !== null) {
        for (const topic of sortedTopics) {
          const subtopics = childrenByParent[topic.id] ?? [];
          if (subtopics.some((subtopic) => subtopic.id === node.parent_id)) {
            return topic.id;
          }
        }
      }
      return null;
    },
    [childrenByParent, sortedTopics],
  );

  const handleOccurrenceChipClick = React.useCallback(
    async (evt: React.MouseEvent, node: TimelineNode, occurrenceIdx: number) => {
      evt.stopPropagation();
      const occurrences = await ensureOccurrences(node.id);
      const occurrence = occurrences[occurrenceIdx];
      if (!occurrence) {
        return;
      }
      setSelectedOccurrenceIdxByNode((prev) => ({ ...prev, [node.id]: occurrenceIdx }));
      onJumpToRowid(occurrence.representative_rowid);
      const nearestIdx = Math.max(0, selectedNodeRowids.findIndex((r) => r >= occurrence.representative_rowid));
      setSelectedNodeRowidIdx(nearestIdx === -1 ? 0 : nearestIdx);
    },
    [ensureOccurrences, onJumpToRowid, selectedNodeRowids],
  );

  const renderRationaleButton = React.useCallback(
    (node: TimelineNode) => {
      if (!node.ai_rationale) {
        return null;
      }
      const isOpen = rationaleOpenNodeId === node.id;
      const isPinned = rationalePinnedNodeId === node.id;
      return (
        <Popover
          open={isOpen}
          onOpenChange={(open) => {
            if (!open && !isPinned) {
              setRationaleOpenNodeId((prev) => (prev === node.id ? null : prev));
            }
            if (!open && isPinned) {
              setRationalePinnedNodeId((prev) => (prev === node.id ? null : prev));
              setRationaleOpenNodeId((prev) => (prev === node.id ? null : prev));
            }
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              onClick={(evt) => {
                evt.stopPropagation();
                if (isPinned) {
                  setRationalePinnedNodeId(null);
                  setRationaleOpenNodeId(null);
                } else {
                  setRationalePinnedNodeId(node.id);
                  setRationaleOpenNodeId(node.id);
                }
              }}
              onMouseEnter={(evt) => {
                evt.stopPropagation();
                setRationaleOpenNodeId(node.id);
              }}
              onMouseLeave={() => {
                if (!isPinned) {
                  setRationaleOpenNodeId((prev) => (prev === node.id ? null : prev));
                }
              }}
              className="h-5 w-5 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted/50 grid place-items-center"
              aria-label="Show rationale"
            >
              <Info className="h-3 w-3" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="end"
            side="top"
            className="w-72 p-2"
            onMouseEnter={() => setRationaleOpenNodeId(node.id)}
            onMouseLeave={() => {
              if (!isPinned) {
                setRationaleOpenNodeId((prev) => (prev === node.id ? null : prev));
              }
            }}
          >
            <p className="text-[11px] text-muted-foreground leading-relaxed">{node.ai_rationale}</p>
          </PopoverContent>
        </Popover>
      );
    },
    [rationaleOpenNodeId, rationalePinnedNodeId],
  );

  const renderTopicsListView = () => {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="p-2 border-b border-border">
          <div className="flex items-center gap-2 rounded-md bg-secondary/50 px-2.5 py-1.5">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              type="text"
              value={topicQuery}
              onChange={(evt) => setTopicQuery(evt.target.value)}
              placeholder="Search topics..."
              className="flex-1 bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>

        <div className="px-3 pt-2 pb-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Topics
        </div>

        <div
          ref={topicsListRef}
          onScroll={(evt) => setTopicsListScrollTop(evt.currentTarget.scrollTop)}
          className="flex-1 min-h-0 overflow-y-auto px-2 pb-3"
        >
          {loadingTopics && (
            <div className="px-1 py-3 text-xs text-muted-foreground">Loading topics...</div>
          )}

          {!loadingTopics && filteredTopics.length === 0 && (
            <div className="px-1 py-3 text-xs text-muted-foreground">No topics found.</div>
          )}

          {!loadingTopics && filteredTopics.length > 0 && (
            <div className="space-y-0.5">
              {filteredTopics.map((topic) => {
                const selected = selectedTopicId === topic.id;
                const subtopicCount = childrenByParent[topic.id]?.length ?? 0;
                const metaLabel =
                  subtopicCount > 0
                    ? `${subtopicCount} subtopics · ${topic.message_count} messages`
                    : `${topic.message_count} messages`;
                return (
                  <button
                    key={`topic-row-${topic.id}`}
                    type="button"
                    onClick={() => {
                      void handleTopicClick(topic);
                    }}
                    className={`w-full text-left rounded-md px-2.5 py-2 transition-colors ${
                      selected
                        ? "bg-primary/15 text-foreground"
                        : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${dotClassForNode(topic.id)}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">{topic.title}</p>
                        <p className="truncate text-xs text-muted-foreground">{metaLabel}</p>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderTopicDetailView = () => {
    if (!selectedTopic) {
      return (
        <div className="flex-1 min-h-0 flex items-center justify-center p-6 text-sm text-muted-foreground">
          Topic not found. Return to topics list.
        </div>
      );
    }

    const detailNode = selectedDetailNode ?? selectedTopic;
    const seenMomentIds = new Set<number>();

    return (
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-2 border-b border-border flex items-center gap-2">
          <Button
            variant="outline"
            size="icon-sm"
            className="h-7 w-7"
            onClick={handleBackToTopics}
            aria-label="Back to topics"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
          </Button>
          <p className="text-xs font-medium text-foreground truncate">{selectedTopic.title}</p>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 space-y-3">
          <section className="pb-3 border-b border-border">
            <div className="mb-1.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              <span className={`h-2 w-2 rounded-full ${dotClassForNode(selectedTopic.id)}`} />
              <span>Topic</span>
            </div>
            <h2 className="text-xl font-semibold text-foreground leading-tight">{selectedTopic.title}</h2>
            <p className="mt-1.5 text-sm text-muted-foreground leading-relaxed">{selectedTopic.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{formatDateRange(selectedTopic.start_ts, selectedTopic.end_ts)}</span>
              <span className="inline-flex items-center gap-1">
                <Hash className="h-3.5 w-3.5" />
                {selectedSubtopics.length} subtopics
              </span>
              <span className="inline-flex items-center gap-1">
                <MessageCircle className="h-3.5 w-3.5" />
                {selectedTopic.message_count} messages
              </span>
            </div>
          </section>

          <section className="py-2 border-b border-border">
            <p className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Selected Item</p>
            <h3 className="mt-1 text-sm font-semibold text-foreground line-clamp-2">{detailNode.title}</h3>
            <p className="mt-1 text-xs text-muted-foreground leading-relaxed line-clamp-3">{detailNode.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground pb-1">
              <span>{formatDateRange(detailNode.start_ts, detailNode.end_ts)}</span>
              <span>{detailNode.message_count} messages</span>
              {renderRationaleButton(detailNode)}
            </div>
            {selectedDetailOccurrences.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {selectedDetailOccurrences.map((occurrence, idx) => (
                  <button
                    key={`detail-occ-${detailNode.id}-${occurrence.id}`}
                    type="button"
                    onClick={(evt) => {
                      void handleOccurrenceChipClick(evt, detailNode, idx);
                    }}
                    className={`text-[10px] rounded border px-1.5 py-0.5 ${
                      (selectedOccurrenceIdxByNode[detailNode.id] ?? 0) === idx
                        ? "border-primary/60 bg-primary/15 text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {formatDateRange(occurrence.start_ts, occurrence.end_ts)}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="pt-1">
            <p className="mb-2 text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Outline</p>

            {loadingTopicTree && (
              <div className="text-xs text-muted-foreground">Loading outline...</div>
            )}

            {!loadingTopicTree && selectedSubtopics.length === 0 && (
              <div className="text-xs text-muted-foreground">No subtopics linked to this topic.</div>
            )}

            {!loadingTopicTree && selectedSubtopics.length > 0 && (
              <div className="space-y-1">
                {selectedSubtopics.map((subtopic) => {
                  const expanded = expandedSubtopicIds[subtopic.id] ?? true;
                  const moments = selectedMomentsBySubtopic[subtopic.id] ?? [];
                  const uniqueMoments = moments.filter((moment) => {
                    if (seenMomentIds.has(moment.id)) {
                      return false;
                    }
                    seenMomentIds.add(moment.id);
                    return true;
                  });
                  const subtopicSelected = detailNode.id === subtopic.id;

                  return (
                    <div key={`subtopic-${subtopic.id}`}>
                      <div
                        className={`w-full rounded-md px-2 py-1.5 ${
                          subtopicSelected ? "bg-primary/10" : "hover:bg-secondary/40"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={(evt) => {
                              evt.stopPropagation();
                              setExpandedSubtopicIds((prev) => ({
                                ...prev,
                                [subtopic.id]: !expanded,
                              }));
                            }}
                            className="h-4 w-4 grid place-items-center text-muted-foreground"
                            aria-label={expanded ? "Collapse subtopic" : "Expand subtopic"}
                          >
                            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "" : "-rotate-90"}`} />
                          </button>

                          <button
                            type="button"
                            onClick={() => {
                              void jumpToNode(subtopic, {
                                updateDetailSelection: true,
                                reloadRowids: true,
                              });
                            }}
                            className="flex-1 min-w-0 text-left"
                          >
                            <span className="block truncate text-sm text-foreground">{subtopic.title}</span>
                          </button>

                          <span className="text-xs text-muted-foreground">{uniqueMoments.length}</span>
                        </div>
                      </div>

                      {expanded && (
                        <div className="ml-4 border-l border-border/70 pl-2 py-1 space-y-0.5">
                          {uniqueMoments.map((moment) => {
                            const momentSelected = detailNode.id === moment.id;
                            return (
                              <button
                                key={`moment-${moment.id}`}
                                type="button"
                                onClick={() => {
                                  void jumpToNode(moment, {
                                    updateDetailSelection: true,
                                    reloadRowids: true,
                                  });
                                }}
                                className={`w-full rounded-md px-2 py-1 text-left ${
                                  momentSelected ? "bg-primary/10" : "hover:bg-secondary/30"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                                  <span className="flex-1 truncate text-xs text-foreground">{moment.title}</span>
                                  <span className="text-[10px] text-muted-foreground">{formatShortTime(moment.start_ts)}</span>
                                </div>
                              </button>
                            );
                          })}

                          {uniqueMoments.length === 0 && (
                            <div className="px-2 py-1 text-[11px] text-muted-foreground">No moments in this subtopic.</div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {relatedNodes.length > 0 && (
            <section className="pt-2 border-t border-border">
              <p className="text-[11px] font-medium text-foreground">Related topics</p>
              <div className="mt-2 space-y-1.5">
                {relatedNodes.map((node) => (
                  <button
                    key={`related-${node.id}`}
                    type="button"
                    onClick={async () => {
                      if (node.level === 2) {
                        await handleTopicClick(node);
                        return;
                      }
                      const resolvedTopicId = resolveTopicIdForNode(node);
                      if (resolvedTopicId !== null) {
                        setSelectedTopicId(resolvedTopicId);
                        setView("topic_detail");
                      }
                      await jumpToNode(node, {
                        updateDetailSelection: true,
                        reloadRowids: true,
                      });
                    }}
                    className="w-full text-left rounded-md px-2 py-1.5 hover:bg-muted/50"
                  >
                    <p className="text-[10px] font-medium text-foreground line-clamp-1">{node.title}</p>
                    <p className="text-[10px] text-muted-foreground line-clamp-2 mt-0.5">{node.summary}</p>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    );
  };

  const navigatorNode = selectedDetailNode ?? selectedTopic;

  return (
    <div
      className={`flex flex-col h-full bg-background ${embedded ? "w-full" : "w-[420px] shrink-0 border-l border-border"}`}
      tabIndex={0}
      onKeyDown={(evt) => {
        if (evt.key === "ArrowLeft") {
          evt.preventDefault();
          jumpWithinSelectedNode(selectedNodeRowidIdx - 1);
        } else if (evt.key === "ArrowRight") {
          evt.preventDefault();
          jumpWithinSelectedNode(selectedNodeRowidIdx + 1);
        }
      }}
    >
      <div className="px-3 py-2.5 border-b border-border">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <ListTree className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold text-foreground">Timeline</h3>
          </div>
          {hasIndex && isStale && !isBusy && (
            <span className="text-[11px] text-amber-600">New messages detected</span>
          )}
        </div>
      </div>

      {!showEmptyState && (
        <div className="px-3 py-2 border-b border-border flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => void handleStartIndex(false)}
            disabled={isBusy}
            className="h-8 w-8"
            aria-label={hasIndex ? "Update timeline index" : "Start indexing"}
          >
            <RefreshCw className="h-4 w-4" />
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

      {isBusy && (
        <div className="px-3 py-2 border-b border-border text-[11px] text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>
              {jobState?.phase ?? "processing"}
              {isCanceling ? " (stopping)" : ""}
            </span>
            <span>{Math.round((jobState?.progress ?? 0) * 100)}%</span>
          </div>
        </div>
      )}

      {error && <div className="px-3 py-2 border-b border-border text-[11px] text-red-500">{error}</div>}

      {showEmptyState && (
        <div className="p-4 text-sm text-muted-foreground space-y-2">
          <p>
            Build a local AI timeline index for this chat. Node titles, summaries, and grouping are
            generated by AI.
          </p>
          <Button size="sm" onClick={() => void handleStartIndex(false)} className="h-8">
            Start indexing
          </Button>
        </div>
      )}

      {hasIndex && (view === "topic_detail" ? renderTopicDetailView() : renderTopicsListView())}

      {navigatorNode && (
        <div className="px-3 py-2 border-t border-border bg-background/95 flex items-center justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-foreground truncate">{navigatorNode.title}</p>
            {rowidsCapped && (
              <p className="text-[10px] text-muted-foreground">Showing first {DEFAULT_ROWID_LIMIT} messages</p>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="icon-sm"
              className="h-7 w-7"
              disabled={selectedNodeRowidIdx <= 0 || selectedNodeRowids.length === 0}
              onClick={() => jumpWithinSelectedNode(selectedNodeRowidIdx - 1)}
              aria-label="Previous message"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-[10px] text-muted-foreground min-w-16 text-center">
              {selectedNodeRowids.length === 0 ? "0 / 0" : `${selectedNodeRowidIdx + 1} / ${selectedNodeRowids.length}`}
            </span>
            <Button
              variant="outline"
              size="icon-sm"
              className="h-7 w-7"
              disabled={
                selectedNodeRowids.length === 0 ||
                selectedNodeRowidIdx >= selectedNodeRowids.length - 1
              }
              onClick={() => jumpWithinSelectedNode(selectedNodeRowidIdx + 1)}
              aria-label="Next message"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeTimelineUiState(raw: unknown): PerChatTimelineUiState {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_UI_STATE };
  }

  const obj = raw as Record<string, unknown>;

  const selectedFromLegacy = toNumberOrNull(obj.selectedNodeId);

  const view = obj.view === "topic_detail" || obj.view === "topics_list"
    ? obj.view
    : selectedFromLegacy !== null
      ? "topic_detail"
      : "topics_list";

  return {
    view,
    topicQuery:
      toStringOr(obj.topicQuery, "") ??
      toStringOr(obj.leftPaneQuery, "") ??
      DEFAULT_UI_STATE.topicQuery,
    selectedTopicId:
      toNumberOrNull(obj.selectedTopicId) ?? selectedFromLegacy ?? DEFAULT_UI_STATE.selectedTopicId,
    selectedDetailNodeId:
      toNumberOrNull(obj.selectedDetailNodeId) ??
      selectedFromLegacy ??
      DEFAULT_UI_STATE.selectedDetailNodeId,
    expandedSubtopicIds:
      toRecordNumberBoolean(obj.expandedSubtopicIds) ??
      toRecordNumberBoolean(obj.expandedOutlineIds) ??
      {},
    selectedOccurrenceIdxByNode:
      toRecordNumberNumber(obj.selectedOccurrenceIdxByNode) ?? {},
  };
}

function sortTimelineNodes(a: TimelineNode, b: TimelineNode): number {
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  if (a.start_rowid !== b.start_rowid) return a.start_rowid - b.start_rowid;
  return a.id - b.id;
}

function dedupeNodes(nodes: TimelineNode[]): TimelineNode[] {
  const seen = new Set<number>();
  const out: TimelineNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) {
      continue;
    }
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function formatDateRange(start: string, end: string): string {
  try {
    const startDate = parseISO(start);
    const endDate = parseISO(end);
    return `${format(startDate, "MMM d")} - ${format(endDate, "MMM d, yyyy")}`;
  } catch {
    return "";
  }
}

function formatShortTime(ts: string): string {
  try {
    return format(parseISO(ts), "h:mm a");
  } catch {
    return "";
  }
}

function dotClassForNode(nodeId: number): string {
  const palette = [
    "bg-blue-400",
    "bg-emerald-400",
    "bg-amber-400",
    "bg-violet-400",
    "bg-rose-400",
    "bg-cyan-400",
  ];
  return palette[Math.abs(nodeId) % palette.length] ?? "bg-primary";
}

function toNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toStringOr(value: unknown, fallback: string): string | null {
  if (typeof value === "string") {
    return value;
  }
  return fallback;
}

function toRecordNumberBoolean(value: unknown): Record<number, boolean> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const out: Record<number, boolean> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const numKey = Number(k);
    if (!Number.isFinite(numKey) || typeof v !== "boolean") {
      continue;
    }
    out[numKey] = v;
  }
  return out;
}

function toRecordNumberNumber(value: unknown): Record<number, number> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const numKey = Number(k);
    if (!Number.isFinite(numKey) || typeof v !== "number" || !Number.isFinite(v)) {
      continue;
    }
    out[numKey] = v;
  }
  return out;
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
