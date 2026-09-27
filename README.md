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

## Install

```sh
bb plugin install /home/bb/plugins/bb-plugin-quiet-automations --yes
```

To turn it off, run `bb plugin disable quiet-automations`.
