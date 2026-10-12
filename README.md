# Quiet Automations

This bb plugin stops push notifications for automation threads that finish normally.
Failed automation runs still notify you.

## How it works

The builtin Push notifications plugin waits 2 seconds after a thread goes idle.
It then skips the push if the thread is already read.

This plugin listens for `thread.idle` on threads with `originPluginId: "automations"`.
After 500 ms, it marks the thread read.

It does not mark a thread read in these cases:

- The thread is in the `error` state. The failure push still arrives.
- The thread has a pending interaction, such as a permission request. The input push still arrives.
- The thread is a child thread. Push notifications already ignores child threads.

## Side effect

Automation threads that finish normally show as read in the sidebar.

## Auto-archive

Every 10 minutes, the plugin archives automation runs that finished cleanly.
A long thread list makes the sidebar slow, and most automation runs need no further attention.

A run is archived with all its descendants (child threads and hidden forks), because bb archives the full tree.
Archiving stops a thread that still runs, so every thread in the tree must pass these checks:

- The thread is idle. It has no error, no pending interaction, no queued work and no background activity.
- The thread had no update for the configured time (default 60 minutes).
- The thread is not in a worktree. Archiving can retire a worktree that no other thread uses.

The plugin also keeps pinned runs.
It reads every thread in the tree again just before it archives the tree.

Each sweep archives at most 120 runs (setting `autoArchiveBatchSize`), with 500 ms between runs.
This spreads a large backlog over several sweeps, so open sidebars do not re-render many times a second.

Archived threads keep their transcript. You can search them, open them and unarchive them.

Settings (Settings → Plugins → Quiet Automations, or `bb plugin config quiet-automations`):

| Setting | Default | Meaning |
| --- | --- | --- |
| `autoArchive` | `true` | Turns auto-archive on or off. |
| `autoArchiveAfterMinutes` | `60` | How long the full tree must stay idle. |
| `autoArchiveBatchSize` | `120` | The maximum number of runs archived in one sweep. |

Each sweep that archives something writes one line to `bb plugin logs quiet-automations`.

## Development

```sh
npm install
npm test
npm run typecheck
```

## Install

```sh
bb plugin install /home/bb/plugins/bb-plugin-quiet-automations --yes
```

To turn it off, run `bb plugin disable quiet-automations`.
