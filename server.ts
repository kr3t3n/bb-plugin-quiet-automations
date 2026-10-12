import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  AUTOMATIONS_PLUGIN_ID,
  selectArchivableTrees,
  type ArchiveTree,
  type ThreadRow,
} from "./src/auto-archive";

// The builtin Push notifications plugin coalesces events for 2s, then skips
// the push when lastReadAt is at or after the event. Marking the thread read
// inside that window suppresses the "finished" push. Wait briefly first so
// lastReadAt lands after the event time the push plugin records.
const MARK_READ_DELAY_MS = 500;

// Auto-archive runs on a schedule, not on a timer per thread, so a restart
// loses nothing: the next sweep finds the same settled runs.
const SWEEP_CRON = "*/10 * * * *";
const LIST_PAGE_SIZE = 500;
// Each archive removes rows from every open sidebar. Spacing them out keeps a
// large backlog from re-rendering the list many times a second.
const ARCHIVE_GAP_MS = 500;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    autoArchive: {
      type: "boolean",
      label: "Archive finished automation runs",
      description:
        "Archive an automation thread and its children when every thread in the tree is idle, has no error, and waits for no input. Archived threads stay searchable and can be unarchived.",
      default: true,
    },
    autoArchiveAfterMinutes: {
      type: "number",
      label: "Archive after (minutes idle)",
      description:
        "How long every thread in the tree must stay idle before the tree is archived.",
      default: 60,
    },
    autoArchiveBatchSize: {
      type: "number",
      label: "Most runs archived per sweep",
      description:
        "The sweep runs every 10 minutes. The limit spreads a large backlog over several sweeps.",
      default: 120,
    },
  });

  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.originPluginId !== AUTOMATIONS_PLUGIN_ID) return;
    if (thread.parentThreadId !== null) return;

    const timer = setTimeout(() => {
      void markReadIfStillIdle(bb, thread.id).catch((error: unknown) => {
        bb.log.warn(
          `Could not mark automation thread ${thread.id} read: ${errorMessage(error)}`,
        );
      });
    }, MARK_READ_DELAY_MS);
    timer.unref?.();
  });

  let sweeping = false;
  bb.background.schedule("auto-archive-sweep", SWEEP_CRON, async () => {
    // A sweep that is still pacing through a backlog owns the queue.
    if (sweeping) return;
    sweeping = true;
    try {
      const cfg = await settings.get();
      if (!cfg.autoArchive) return;
      await archiveSettledRuns(bb, {
        idleMs: Math.max(1, cfg.autoArchiveAfterMinutes) * 60_000,
        batchSize: Math.max(1, Math.floor(cfg.autoArchiveBatchSize)),
      });
    } catch (error) {
      bb.log.warn(`Auto-archive sweep failed: ${errorMessage(error)}`);
    } finally {
      sweeping = false;
    }
  });
}

async function markReadIfStillIdle(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  // Failed runs keep their unread state, so they still notify.
  if (thread.status !== "idle") return;
  // A run that waits for input still needs attention.
  if (await hasPendingInteraction(bb, threadId)) return;
  await bb.sdk.threads.markRead({ threadId });
}

async function hasPendingInteraction(
  bb: BbPluginApi,
  threadId: string,
): Promise<boolean> {
  const interactions = await bb.sdk.threads.interactions.list({ threadId });
  return interactions.some((interaction) => interaction.status === "pending");
}

async function listLiveThreads(bb: BbPluginApi): Promise<ThreadRow[]> {
  const rows: ThreadRow[] = [];
  for (let offset = 0; ; offset += LIST_PAGE_SIZE) {
    const page = await bb.sdk.threads.list({
      archived: false,
      includeHidden: true,
      limit: LIST_PAGE_SIZE,
      offset,
    });
    rows.push(...page);
    if (page.length < LIST_PAGE_SIZE) return rows;
  }
}

/**
 * The list is a snapshot, and archiving stops any thread in the tree that
 * runs. Re-read every thread so a run that started again, or a question that
 * arrived, keeps the tree live.
 */
async function treeStillSettled(
  bb: BbPluginApi,
  tree: ArchiveTree,
  cutoff: number,
): Promise<boolean> {
  for (const threadId of tree.threadIds) {
    const thread = await bb.sdk.threads.get({ threadId });
    if (thread.archivedAt !== null || thread.deletedAt !== null) return false;
    if (thread.status !== "idle" || thread.updatedAt > cutoff) return false;
    if (await hasPendingInteraction(bb, threadId)) return false;
  }
  return true;
}

async function archiveSettledRuns(
  bb: BbPluginApi,
  options: { idleMs: number; batchSize: number },
) {
  const rows = await listLiveThreads(bb);
  const plan = selectArchivableTrees(rows, {
    now: Date.now(),
    idleMs: options.idleMs,
  });
  const batch = plan.trees.slice(0, options.batchSize);
  if (batch.length === 0) return;

  let runs = 0;
  let threads = 0;
  let changed = 0;
  for (const tree of batch) {
    if (!(await treeStillSettled(bb, tree, Date.now() - options.idleMs))) {
      changed += 1;
      continue;
    }
    const result = await bb.sdk.threads.archiveAll({ threadId: tree.rootId });
    runs += 1;
    threads += result.archivedThreadIds.length;
    await sleep(ARCHIVE_GAP_MS);
  }

  const kept = Object.entries(plan.skipped)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  bb.log.info(
    `Auto-archive archived ${runs} runs (${threads} threads). ` +
      `${changed} runs changed after listing. ` +
      `${plan.trees.length - batch.length} runs wait for the next sweep. ` +
      `Kept: ${kept || "none"}.`,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
