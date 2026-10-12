import { strict as assert } from "node:assert";
import { test } from "node:test";
import { selectArchivableTrees, type ThreadRow } from "./auto-archive.ts";

const NOW = 10_000_000;
const HOUR = 3_600_000;
const OLD = NOW - 2 * HOUR;

function row(id: string, patch: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id,
    parentThreadId: null,
    sourceThreadId: null,
    originPluginId: "automations",
    visibility: "visible",
    status: "idle",
    hasPendingInteraction: false,
    queuedWork: "none",
    pinnedAt: null,
    environmentIsWorktree: false,
    updatedAt: OLD,
    activity: {
      activeBackgroundAgentCount: 0,
      activeBackgroundCommandCount: 0,
      activeGoalCount: 0,
      activePlanModeCount: 0,
      activeWorkflowCount: 0,
    },
    ...patch,
  };
}

const plan = (rows: ThreadRow[]) =>
  selectArchivableTrees(rows, { now: NOW, idleMs: HOUR });

test("archives a clean automation run idle for longer than the delay", () => {
  assert.deepEqual(plan([row("a")]).trees, [{ rootId: "a", threadIds: ["a"] }]);
});

test("keeps runs that are recent, failed, waiting, busy, pinned or in a worktree", () => {
  const result = plan([
    row("recent", { updatedAt: NOW - HOUR / 2 }),
    row("failed", { status: "error" }),
    row("asking", { hasPendingInteraction: true }),
    row("running", { status: "active" }),
    row("queued", { queuedWork: "waiting" }),
    row("agents", {
      activity: { ...row("x").activity, activeBackgroundAgentCount: 1 },
    }),
    row("pinned", { pinnedAt: 1 }),
    row("worktree", { environmentIsWorktree: true }),
  ]);
  assert.deepEqual(result.trees, []);
  assert.deepEqual(result.skipped, {
    recent: 1,
    error: 1,
    "needs-input": 1,
    busy: 3,
    pinned: 1,
    worktree: 1,
  });
});

test("ignores threads that automations did not start", () => {
  assert.deepEqual(plan([row("manual", { originPluginId: null })]).trees, []);
});

test("archives a run together with its clean children", () => {
  const result = plan([
    row("parent"),
    row("child", { parentThreadId: "parent", originPluginId: null }),
    row("grandchild", { parentThreadId: "child", originPluginId: "tasks" }),
  ]);
  assert.equal(result.trees.length, 1);
  assert.deepEqual([...result.trees[0]!.threadIds].sort(), [
    "child",
    "grandchild",
    "parent",
  ]);
});

test("keeps a run when any descendant still works, failed or changed recently", () => {
  for (const patch of [
    { status: "active" },
    { status: "error" },
    { hasPendingInteraction: true },
    { updatedAt: NOW - 1 },
  ] satisfies Partial<ThreadRow>[]) {
    const result = plan([
      row("parent"),
      row("child", { parentThreadId: "parent", originPluginId: null }),
      row("grandchild", { parentThreadId: "child", ...patch }),
    ]);
    assert.deepEqual(result.trees, [], JSON.stringify(patch));
  }
});

test("counts hidden forks as part of the tree, but not visible forks", () => {
  const hidden = plan([
    row("run"),
    row("fork", { sourceThreadId: "run", visibility: "hidden", status: "active" }),
  ]);
  assert.deepEqual(hidden.trees, []);

  const visible = plan([
    row("run"),
    row("fork", { sourceThreadId: "run", originPluginId: null, status: "active" }),
  ]);
  assert.deepEqual(visible.trees, [{ rootId: "run", threadIds: ["run"] }]);
});

test("orders runs oldest first, by the latest update in each tree", () => {
  const result = plan([
    row("newer", { updatedAt: OLD }),
    row("older", { updatedAt: OLD - HOUR }),
    row("child", { parentThreadId: "older", updatedAt: OLD + 1 }),
  ]);
  assert.deepEqual(
    result.trees.map((tree) => tree.rootId),
    ["newer", "older"],
  );
});
