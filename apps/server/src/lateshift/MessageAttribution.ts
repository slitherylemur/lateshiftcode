// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Like
// RateLimitSnapshotStore, this sidecar deliberately writes plain JSON files
// with node:fs/promises: the store must add ZERO service requirements to
// ws.ts/server.ts (a SqlClient dependency here breaks upstream's server/bin
// test fixtures, which type route layers against NodeServices only), and the
// files are trivially inspectable during the shadow-stack validation.
/**
 * LateShift W6-D: who sent each user message in a shared thread.
 *
 * ## The invariant that matters
 *
 * Attribution is PRESENTATION ONLY. The sender's identity lives in sidecar
 * JSON files keyed by message id — it is never added to the orchestration
 * command, never written into orchestration_events, never copied into the
 * message projection, and therefore can never be serialised into anything a
 * provider adapter reads. The model cannot be told who typed a message
 * because the fact does not exist anywhere on the prompt-construction path
 * (architecture-v2 §6 "Message attribution").
 *
 * ## Where the identity comes from
 *
 * The gateway (Caddy) stamps `X-Lsc-User` onto every proxied request after
 * the portal's /authz resolves the session. Workspace servers listen on a
 * unix socket reachable only by Caddy's group, which is what makes the header
 * trustworthy (§3). ws.ts captures it at WebSocket upgrade and records one
 * entry per `thread.turn.start` dispatch.
 *
 * ## Storage and enabling
 *
 * One JSON file per thread under `T3CODE_LSC_ATTRIBUTION_DIR`
 * (`<baseDir>/userdata/lsc-attribution` in t3ws@.service). Unset → the store
 * is a no-op and desktop/upstream-dev behave exactly like upstream. A single
 * server process owns a workspace, so writes never race across processes;
 * within the process, writes are serialised per thread via a queue of
 * promises.
 *
 * ## Failure policy
 *
 * Fail-open like the turn_usage ledger and the snapshot store: a write error
 * is logged and swallowed (attribution must never break dispatch); a read
 * error yields an empty map.
 *
 * @module lateshift/MessageAttribution
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Env var naming the directory the per-thread attribution files live in. */
export const LSC_ATTRIBUTION_DIR_ENV = "T3CODE_LSC_ATTRIBUTION_DIR";

/** Sanity bound for a GitHub login arriving via the gateway header. */
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
/** Thread ids become file names; refuse anything that is not a plain token. */
const THREAD_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Normalize the raw X-Lsc-User header value; null when absent or invalid. */
export function normalizeSenderLogin(value: string | Array<string> | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return LOGIN_RE.test(trimmed) ? trimmed : null;
}

/** On-disk shape of one thread's attribution file. */
export interface ThreadAttributionFile {
  readonly senders: Record<string, string>; // messageId -> github login
}

export function attributionFilePath(directory: string, threadId: string): string | null {
  if (!THREAD_ID_RE.test(threadId)) return null;
  return NodePath.join(directory, `${threadId}.json`);
}

/** Read a thread's attribution file; empty map on any error. Plain async. */
export async function readThreadAttribution(
  directory: string | undefined,
  threadId: string,
): Promise<Record<string, string>> {
  if (directory === undefined || directory.length === 0) return {};
  const filePath = attributionFilePath(directory, threadId);
  if (filePath === null) return {};
  try {
    const parsed: unknown = JSON.parse(await NodeFSP.readFile(filePath, "utf8"));
    const senders = (parsed as ThreadAttributionFile).senders;
    if (typeof senders !== "object" || senders === null) return {};
    const out: Record<string, string> = {};
    for (const [messageId, login] of Object.entries(senders)) {
      if (typeof login === "string" && LOGIN_RE.test(login)) out[messageId] = login;
    }
    return out;
  } catch {
    return {};
  }
}

export interface MessageAttributionShape {
  /**
   * Record the sender of one user message. Idempotent per message id (an
   * existing entry is never overwritten — a retried dispatch cannot
   * re-attribute) and fail-open.
   */
  readonly record: (entry: {
    readonly messageId: string;
    readonly threadId: string;
    readonly senderLogin: string;
  }) => Effect.Effect<void>;
}

export class MessageAttribution extends Context.Service<
  MessageAttribution,
  MessageAttributionShape
>()("t3/lateshift/MessageAttribution") {}

const noop: MessageAttributionShape = { record: () => Effect.void };

function makeService(directory: string): MessageAttributionShape {
  // Serialise writes per process; one workspace has exactly one server
  // process, so this is sufficient to avoid read-modify-write races.
  let queue: Promise<void> = Promise.resolve();

  const append = async (messageId: string, threadId: string, senderLogin: string) => {
    const filePath = attributionFilePath(directory, threadId);
    if (filePath === null) return;
    await NodeFSP.mkdir(directory, { recursive: true });
    const existing = await readThreadAttribution(directory, threadId);
    if (messageId in existing) return; // never re-attribute
    const next: ThreadAttributionFile = { senders: { ...existing, [messageId]: senderLogin } };
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    await NodeFSP.writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await NodeFSP.rename(tmpPath, filePath); // atomic within the filesystem
  };

  return {
    record: ({ messageId, threadId, senderLogin }) =>
      Effect.promise(() => {
        queue = queue.then(
          () => append(messageId, threadId, senderLogin),
          () => append(messageId, threadId, senderLogin),
        );
        return queue;
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("lateshift: message attribution write failed (ignored)", {
            messageId,
            cause: String(cause),
          }),
        ),
      ),
  };
}

/**
 * Requirement-free layer: resolves the directory from the environment at
 * build time; unset → no-op service (desktop/dev unchanged).
 */
export const MessageAttributionLayer = Layer.sync(MessageAttribution, () => {
  const directory = process.env[LSC_ATTRIBUTION_DIR_ENV];
  return directory === undefined || directory.length === 0 ? noop : makeService(directory);
});
