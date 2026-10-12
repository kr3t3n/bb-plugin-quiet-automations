// Pure selection logic for the auto-archive sweep. No bb calls here, so the
// rules can be tested without a running host.

export const AUTOMATIONS_PLUGIN_ID = "automations";

/** The fields of a `threads.list` row that the rules read. */
export interface ThreadRow {
  id: string;
  parentThreadId: string | null;
  sourceThreadId: string | null;
  originPluginId: string | null;
  visibility: string;
  status: string;
  hasPendingInteraction: boolean;
  queuedWork: string;
  pinnedAt: number | null;
  environmentIsWorktree: boolean | null;
  updatedAt: number;
  activity: {
    activeBackgroundAgentCount: number;
    activeBackgroundCommandCount: number;
    activeGoalCount: number;
    activePlanModeCount: number;
    activeWorkflowCount: number;
  };
}

export type SkipReason =
  | "recent"
  | "busy"
  | "error"
  | "needs-input"
  | "pinned"
  | "worktree";

export interface ArchiveTree {
  rootId: string;
  /** The root and every descendant that bb archives with it. */
  threadIds: string[];
}

export interface ArchivePlan {
  /** Automation runs to archive with their trees, oldest first. */
  trees: ArchiveTree[];
  /** Root threads left alone, counted by the first rule that kept them. */
  skipped: Record<SkipReason, number>;
}

/**
 * Children that bb archives together with a thread: real child threads, and
 * hidden threads forked from it. A visible fork is its own thread and stays.
 */
function descendantsByThreadId(
  rows: readonly ThreadRow[],
): Map<string, ThreadRow[]> {
  const byParent = new Map<string, ThreadRow[]>();
  const add = (ownerId: string, row: ThreadRow) => {
    const list = byParent.get(ownerId);
    if (list) list.push(row);
    else byParent.set(ownerId, [row]);
  };
  for (const row of rows) {
    if (row.parentThreadId !== null) add(row.parentThreadId, row);
    else if (row.sourceThreadId !== null && row.visibility === "hidden") {
      add(row.sourceThreadId, row);
    }
  }
  return byParent;
}

function collectTree(
  root: ThreadRow,
  byParent: ReadonlyMap<string, readonly ThreadRow[]>,
): ThreadRow[] {
  const tree: ThreadRow[] = [];
  const seen = new Set<string>();
  const pending = [root];
  while (pending.length > 0) {
    const row = pending.pop()!;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    tree.push(row);
    for (const child of byParent.get(row.id) ?? []) pending.push(child);
  }
  return tree;
}

function hasActivity(row: ThreadRow): boolean {
  const a = row.activity;
  return (
    a.activeBackgroundAgentCount > 0 ||
    a.activeBackgroundCommandCount > 0 ||
    a.activeGoalCount > 0 ||
    a.activePlanModeCount > 0 ||
    a.activeWorkflowCount > 0
  );
}

/**
 * Why one thread in a tree keeps the whole tree live, or null when it is
 * settled. Archiving a tree stops any thread in it that still runs, and
 * retires a worktree nobody else uses, so every thread must pass.
 */
export function blockReason(row: ThreadRow, cutoff: number): SkipReason | null {
  if (row.status === "error") return "error";
  if (row.hasPendingInteraction) return "needs-input";
  if (row.status !== "idle" || row.queuedWork !== "none" || hasActivity(row)) {
    return "busy";
  }
  if (row.environmentIsWorktree === true) return "worktree";
  if (row.updatedAt > cutoff) return "recent";
  return null;
}

/**
 * Pick automation runs that finished cleanly and stayed idle for `idleMs`.
 * `rows` must be every live (unarchived) thread, hidden ones included, so
 * the descendants of each run are known.
 */
export function selectArchivableTrees(
  rows: readonly ThreadRow[],
  options: { now: number; idleMs: number },
): ArchivePlan {
  const cutoff = options.now - options.idleMs;
  const byParent = descendantsByThreadId(rows);
  const skipped: Record<SkipReason, number> = {
    recent: 0,
    busy: 0,
    error: 0,
    "needs-input": 0,
    pinned: 0,
    worktree: 0,
  };
  const eligible: (ArchiveTree & { updatedAt: number })[] = [];

  for (const root of rows) {
    if (root.originPluginId !== AUTOMATIONS_PLUGIN_ID) continue;
    if (root.parentThreadId !== null) continue;
    if (root.pinnedAt !== null) {
      skipped.pinned += 1;
      continue;
    }
    const tree = collectTree(root, byParent);
    let reason: SkipReason | null = null;
    let latest = 0;
    for (const row of tree) {
      reason = blockReason(row, cutoff);
      if (reason !== null) break;
      latest = Math.max(latest, row.updatedAt);
    }
    if (reason !== null) {
      skipped[reason] += 1;
      continue;
    }
    eligible.push({
      rootId: root.id,
      threadIds: tree.map((row) => row.id),
      updatedAt: latest,
    });
  }

  eligible.sort(
    (a, b) => a.updatedAt - b.updatedAt || a.rootId.localeCompare(b.rootId),
  );
  return {
    trees: eligible.map(({ rootId, threadIds }) => ({ rootId, threadIds })),
    skipped,
  };
}
