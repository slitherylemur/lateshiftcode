// LateShift W6-D — message attribution, the read/render half.
//
// The server records WHO sent each user message in a sidecar JSON file
// (apps/server/src/lateshift/MessageAttribution.ts), keyed by message id,
// stamped from the gateway's X-Lsc-User header at WebSocket upgrade. This
// module fetches that sidecar over GET /api/lsc/thread-attribution and
// renders a small avatar + GitHub login beside each attributed user message.
//
// PRESENTATION ONLY. The sender's identity never exists on the prompt path:
// it is not in the orchestration command, not in orchestration_events, not in
// the message projection. This file only ever reads the sidecar endpoint.
//
// Off-gateway (desktop build, dev server, plain upstream) the route answers
// 404, the module marks itself absent for the session, and every export
// renders null — the timeline is exactly upstream's.

import { useEffect, useState } from "react";

const ENDPOINT = "/api/lsc/thread-attribution";
/** Minimum gap between refetches for one thread (misses trigger refetch). */
const REFETCH_MIN_GAP_MS = 5_000;

interface ThreadAttributionState {
  senders: Record<string, string>;
  lastFetchAt: number;
  fetching: boolean;
}

// Session-wide "the endpoint does not exist here" latch (desktop/dev/upstream).
let endpointAbsent = false;
const threads = new Map<string, ThreadAttributionState>();
const listeners = new Map<string, Set<() => void>>();

function notify(threadId: string): void {
  const set = listeners.get(threadId);
  if (set) for (const listener of set) listener();
}

async function fetchThread(threadId: string, state: ThreadAttributionState): Promise<void> {
  state.fetching = true;
  state.lastFetchAt = Date.now();
  try {
    const response = await fetch(`${ENDPOINT}?threadId=${encodeURIComponent(threadId)}`, {
      credentials: "same-origin",
    });
    if (response.status === 404) {
      // Off-gateway build, or the gateway route is absent: disable for good.
      endpointAbsent = true;
      return;
    }
    if (!response.ok) return; // transient; a later miss retries
    const body: unknown = await response.json();
    const senders = (body as { senders?: unknown }).senders;
    if (typeof senders === "object" && senders !== null) {
      const next: Record<string, string> = {};
      for (const [messageId, login] of Object.entries(senders as Record<string, unknown>)) {
        if (typeof login === "string") next[messageId] = login;
      }
      state.senders = next;
    }
  } catch {
    // Network failure: keep whatever we had; a later miss retries.
  } finally {
    state.fetching = false;
    notify(threadId);
  }
}

/**
 * The sender login for one message, or null while unknown. A cache miss
 * schedules a (throttled) refetch, which is how newly-sent messages — ours
 * and other members' — pick up their attribution.
 */
function useLscMessageSender(threadId: string | null, messageId: string): string | null {
  const [, setVersion] = useState(0);

  useEffect(() => {
    if (endpointAbsent || threadId === null) return undefined;
    let set = listeners.get(threadId);
    if (!set) {
      set = new Set();
      listeners.set(threadId, set);
    }
    const listener = () => setVersion((v) => v + 1);
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(threadId);
    };
  }, [threadId]);

  if (endpointAbsent || threadId === null) return null;

  let state = threads.get(threadId);
  if (!state) {
    state = { senders: {}, lastFetchAt: 0, fetching: false };
    threads.set(threadId, state);
  }
  const known = state.senders[messageId];
  if (known === undefined && !state.fetching && Date.now() - state.lastFetchAt > REFETCH_MIN_GAP_MS) {
    void fetchThread(threadId, state);
  }
  return known ?? null;
}

/**
 * Avatar + GitHub login rendered above a user message bubble. Renders null
 * until the sender is known, and always null off-gateway.
 */
export function LscUserMessageSender({
  threadId,
  messageId,
}: {
  threadId: string | null;
  messageId: string;
}) {
  const login = useLscMessageSender(threadId, messageId);
  if (login === null) return null;
  return (
    <div
      className="flex items-center gap-1.5 pe-1 text-xs text-muted-foreground"
      data-lsc-message-sender={login}
    >
      <img
        src={`https://github.com/${encodeURIComponent(login)}.png?size=48`}
        alt=""
        aria-hidden="true"
        className="h-4 w-4 rounded-full"
        loading="lazy"
      />
      <span>{login}</span>
    </div>
  );
}
