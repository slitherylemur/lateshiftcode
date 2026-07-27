import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";

/**
 * The two supported sources for the OpenAI transcription credential. Kept as a
 * plain input so the resolution/validation logic is pure and unit-testable
 * without touching the filesystem or `process.env`.
 */
export interface OpenAiApiKeySources {
  /** Value of the `OPENAI_API_KEY` environment variable (or null/undefined). */
  readonly envKey: string | null | undefined;
  /** Raw contents of the Codex CLI `auth.json` file (or null when absent). */
  readonly authJson: string | null | undefined;
}

const CODEX_AUTH_SEGMENTS = [".codex", "auth.json"] as const;

function normalizeKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the OpenAI API key from the two supported sources, preferring the
 * environment variable.
 *
 * The Codex auth file is JSON; only its top-level `OPENAI_API_KEY` string field
 * is a usable REST API key. The ChatGPT OAuth `tokens` object in that file is
 * deliberately NOT accepted: those tokens do not authenticate the OpenAI audio
 * transcription REST API, so treating them as a key would produce silent 401s.
 *
 * Returns the trimmed key, or null when transcription is not configured.
 */
export function resolveOpenAiApiKeyFromSources(sources: OpenAiApiKeySources): string | null {
  const fromEnv = normalizeKey(sources.envKey);
  if (fromEnv !== null) {
    return fromEnv;
  }

  const rawJson = sources.authJson;
  if (typeof rawJson !== "string" || rawJson.trim().length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  return normalizeKey((parsed as Record<string, unknown>)["OPENAI_API_KEY"]);
}

/**
 * Read the Codex CLI auth file contents from the current user's home
 * directory, yielding null when the file is missing or unreadable.
 */
export const readCodexAuthJson: Effect.Effect<
  string | null,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const authPath = path.join(NodeOS.homedir(), ...CODEX_AUTH_SEGMENTS);
  return yield* fileSystem
    .readFileString(authPath)
    .pipe(Effect.orElseSucceed((): string | null => null));
});

/**
 * Resolve the OpenAI API key from the environment and, failing that, the Codex
 * CLI auth file. Returns null when transcription is not configured.
 */
export const resolveOpenAiApiKey: Effect.Effect<
  string | null,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const authJson = yield* readCodexAuthJson;
  return resolveOpenAiApiKeyFromSources({
    envKey: process.env["OPENAI_API_KEY"] ?? null,
    authJson,
  });
});
