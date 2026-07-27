import { describe, expect, it } from "vite-plus/test";

import { resolveOpenAiApiKeyFromSources } from "./openAiApiKey.ts";

describe("resolveOpenAiApiKeyFromSources", () => {
  it("prefers the environment variable when set", () => {
    expect(
      resolveOpenAiApiKeyFromSources({
        envKey: "sk-env-key",
        authJson: JSON.stringify({ OPENAI_API_KEY: "sk-file-key" }),
      }),
    ).toBe("sk-env-key");
  });

  it("trims surrounding whitespace on the environment key", () => {
    expect(resolveOpenAiApiKeyFromSources({ envKey: "  sk-env-key  ", authJson: null })).toBe(
      "sk-env-key",
    );
  });

  it("falls back to the auth file OPENAI_API_KEY field", () => {
    expect(
      resolveOpenAiApiKeyFromSources({
        envKey: null,
        authJson: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-file-key" }),
      }),
    ).toBe("sk-file-key");
  });

  it("ignores an empty-string environment key and uses the file", () => {
    expect(
      resolveOpenAiApiKeyFromSources({
        envKey: "   ",
        authJson: JSON.stringify({ OPENAI_API_KEY: "sk-file-key" }),
      }),
    ).toBe("sk-file-key");
  });

  it("returns null when the auth file OPENAI_API_KEY is null (ChatGPT OAuth mode)", () => {
    expect(
      resolveOpenAiApiKeyFromSources({
        envKey: undefined,
        authJson: JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { access_token: "eyJ...", refresh_token: "rt..." },
        }),
      }),
    ).toBeNull();
  });

  it("does not accept ChatGPT OAuth tokens as an API key", () => {
    const resolved = resolveOpenAiApiKeyFromSources({
      envKey: null,
      authJson: JSON.stringify({ tokens: { access_token: "eyJ-oauth-access-token" } }),
    });
    expect(resolved).toBeNull();
  });

  it("returns null for malformed auth JSON", () => {
    expect(resolveOpenAiApiKeyFromSources({ envKey: null, authJson: "{not json" })).toBeNull();
  });

  it("returns null when neither source is configured", () => {
    expect(resolveOpenAiApiKeyFromSources({ envKey: null, authJson: null })).toBeNull();
    expect(resolveOpenAiApiKeyFromSources({ envKey: "", authJson: "" })).toBeNull();
  });
});
