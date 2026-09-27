import type { BbPluginApi } from "@get-bb/plugin-sdk";

// The builtin Push notifications plugin coalesces events for 2s, then skips
// the push when lastReadAt is at or after the event. Marking the thread read
// inside that window suppresses the "finished" push. Wait briefly first so
// lastReadAt lands after the event time the push plugin records.
const MARK_READ_DELAY_MS = 500;
const AUTOMATIONS_PLUGIN_ID = "automations";

export default async function plugin(bb: BbPluginApi) {
  bb.events.on("thread.idle", ({ thread }) => {
    if (thread.originPluginId !== AUTOMATIONS_PLUGIN_ID) return;
    if (thread.parentThreadId !== null) return;

    const timer = setTimeout(() => {
      void markReadIfStillIdle(bb, thread.id).catch((error: unknown) => {
        bb.log.warn(
          `Could not mark automation thread ${thread.id} read: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, MARK_READ_DELAY_MS);
    timer.unref?.();
  });
}

async function markReadIfStillIdle(bb: BbPluginApi, threadId: string) {
  const thread = await bb.sdk.threads.get({ threadId });
  // Failed runs keep their unread state, so they still notify.
  if (thread.status !== "idle") return;
  // A run that waits for input still needs attention.
  const interactions = await bb.sdk.threads.interactions.list({ threadId });
  if (interactions.some((interaction) => interaction.status === "pending")) return;
  await bb.sdk.threads.markRead({ threadId });
}
