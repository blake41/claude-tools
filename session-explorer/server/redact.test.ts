import { describe, expect, test } from "bun:test";
import { guardFtsTokens, redactSecrets, MAX_FTS_TOKEN_LEN } from "./redact.js";

/** Longest whitespace-delimited run in `text`. */
function longestToken(text: string): number {
  return text.split(/\s+/).reduce((max, tok) => Math.max(max, tok.length), 0);
}

describe("redactSecrets — prefixed patterns", () => {
  test("redacts an AWS access key", () => {
    const input = "export AWS_ACCESS_KEY_ID=AKIA0123456789ABCDEF";
    const { text, redactions } = redactSecrets(input);
    expect(text).not.toContain("AKIA0123456789ABCDEF");
    expect(text).toBe("export AWS_ACCESS_KEY_ID=[REDACTED:aws-access-key]");
    expect(redactions).toEqual([{ kind: "aws-access-key", length: 20 }]);
  });

  test("redacts a GitHub token", () => {
    const token = "ghp_" + "a".repeat(36);
    const { text, redactions } = redactSecrets(`token: ${token}`);
    expect(text).toBe("token: [REDACTED:github-token]");
    expect(redactions).toEqual([{ kind: "github-token", length: token.length }]);
  });

  test("redacts a Slack token", () => {
    const token = "xoxb-111111111111-222222222222-abcdefghijklmnopqrstuvwx";
    const { text, redactions } = redactSecrets(`SLACK_TOKEN=${token}`);
    expect(text).toBe("SLACK_TOKEN=[REDACTED:slack-token]");
    expect(redactions).toEqual([{ kind: "slack-token", length: token.length }]);
  });

  test("redacts a Stripe live key", () => {
    const token = "sk_live_" + "A1b2C3d4E5f6G7h8I9j0K1l2";
    const { text, redactions } = redactSecrets(`stripe key ${token} in use`);
    expect(text).toBe("stripe key [REDACTED:stripe-live-key] in use");
    expect(redactions).toEqual([{ kind: "stripe-live-key", length: token.length }]);
  });

  test("redacts a JWT", () => {
    const token =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQ-abc123XYZ";
    const { text, redactions } = redactSecrets(`Authorization: Bearer ${token}`);
    expect(text).toBe("Authorization: Bearer [REDACTED:jwt]");
    expect(redactions).toEqual([{ kind: "jwt", length: token.length }]);
  });

  test("redacts a PEM private key block", () => {
    const block = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIBogIBAAJBAKj34GkxFhD91aE1YXtF...",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const { text, redactions } = redactSecrets(`before\n${block}\nafter`);
    expect(text).toBe("before\n[REDACTED:private-key]\nafter");
    expect(redactions).toEqual([{ kind: "private-key", length: block.length }]);
  });

  test("known documentation placeholder AWS key is allowlisted, not redacted", () => {
    const { text, redactions } = redactSecrets("example: AKIAIOSFODNN7EXAMPLE");
    expect(text).toBe("example: AKIAIOSFODNN7EXAMPLE");
    expect(redactions).toEqual([]);
  });
});

describe("redactSecrets — entropy layer", () => {
  test("redacts a bare high-entropy base64-charset token with no prefix", () => {
    const token = "aB3xK9pQmZ7vN2wR8sT1uY4hJ6fL0dC5gE";
    const { text, redactions } = redactSecrets(`token is ${token} here`);
    expect(text).toBe("token is [REDACTED:entropy-base64] here");
    expect(redactions).toEqual([{ kind: "entropy-base64", length: token.length }]);
  });

  test("redacts a bare high-entropy 40-char hex-charset token when it is NOT a real git SHA length coincidence check", () => {
    // A 33-char hex run (not the allowlisted 40) with entropy above the
    // hex threshold should still redact.
    const token = "4f3b2c1a9e8d7f6a5b4c3d2e1f0a9b8c7d";
    expect(token.length).toBe(34);
    const { text, redactions } = redactSecrets(`hash is ${token} done`);
    expect(text).toBe("hash is [REDACTED:entropy-hex] done");
    expect(redactions).toEqual([{ kind: "entropy-hex", length: token.length }]);
  });
});

describe("redactSecrets — allowlist pass-through", () => {
  test("a 40-char hex git SHA passes through unredacted", () => {
    const sha = "4f3b2c1a9e8d7f6a5b4c3d2e1f0a9b8c7d6e5f4a";
    expect(sha.length).toBe(40);
    const input = `commit ${sha} pushed`;
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });

  test("a UUID passes through unredacted", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const input = `request id ${uuid} logged`;
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });
});

describe("redactSecrets — false-positive resistance", () => {
  test("ordinary English prose is untouched", () => {
    const input =
      "The quick brown fox jumps over the lazy dog. This session took about ten minutes to finish, and the results looked reasonable given the constraints we discussed earlier today.";
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });

  test("a realistic file path is untouched", () => {
    const input =
      "Reading /Users/blake/Documents/Development/tools/session-explorer/server/redact.ts for review.";
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });

  test("a realistic stack trace / tool-output fixture is untouched", () => {
    const input = [
      "TypeError: Cannot read properties of undefined (reading 'map')",
      "    at renderMessages (web/components/SessionDetail.tsx:412:18)",
      "    at Object.<anonymous> (node_modules/react-dom/cjs/react-dom.development.js:20347:20)",
      "exit code: 1",
    ].join("\n");
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });

  test("a camelCase identifier over 20 chars is untouched", () => {
    const input = "calling generateSessionSummaryFromMessages(session) next";
    const { text, redactions } = redactSecrets(input);
    expect(text).toBe(input);
    expect(redactions).toEqual([]);
  });
});

describe("redactSecrets — edge cases", () => {
  test("empty string returns empty string and no redactions", () => {
    expect(redactSecrets("")).toEqual({ text: "", redactions: [] });
  });

  test("a hex run exactly at the 32-char threshold (not the 40-char SHA length) redacts", () => {
    const token = "4f3b2c1a9e8d7f6a5b4c3d2e1f0a9b8c";
    expect(token.length).toBe(32);
    const { redactions } = redactSecrets(`id ${token} end`);
    expect(redactions).toEqual([{ kind: "entropy-hex", length: 32 }]);
  });

  test("a hex run one below the 32-char threshold (31 chars) does not redact via the hex layer", () => {
    const token = "4f3b2c1a9e8d7f6a5b4c3d2e1f0a9b8"; // 31 hex chars
    expect(token.length).toBe(31);
    const { text, redactions } = redactSecrets(`id ${token} end`);
    expect(text).toBe(`id ${token} end`);
    expect(redactions).toEqual([]);
  });

  test("a base64-charset run below the 20-char minimum never redacts, however diverse its characters", () => {
    // Max possible entropy for a 19-char run (all-distinct, uniform) is
    // log2(19) ~= 4.25 bits/char, itself below BASE64_ENTROPY_THRESHOLD —
    // so at this length the regex's own length gate and the entropy
    // threshold agree by construction. Below 20 chars, entropy can never
    // reach ~4.5 no matter how diverse the characters are.
    const token = "aB3xK9pQmZ7vN2wR8sT";
    expect(token.length).toBe(19);
    const { text, redactions } = redactSecrets(`v is ${token} end`);
    expect(text).toBe(`v is ${token} end`);
    expect(redactions).toEqual([]);
  });

  test("a base64-charset run above the minimum with sufficient entropy redacts", () => {
    // log2(24) ~= 4.58 bits/char is the ceiling for 24 all-distinct chars,
    // above BASE64_ENTROPY_THRESHOLD — the smallest length class where the
    // 4.5 threshold is reachable at all.
    const token = "aB3xK9pQmZ7vN2wR8sT1uYh4";
    expect(token.length).toBe(24);
    const { redactions } = redactSecrets(`v is ${token} end`);
    expect(redactions).toEqual([{ kind: "entropy-base64", length: 24 }]);
  });

  test("never throws on arbitrary junk input, including invalid-UTF-8-ish sequences", () => {
    const junkInputs = [
      "𐀀\uD800", // lone/partial surrogate pair
      " binarygarbage",
      "%%%***???!!!" + "�".repeat(50),
      "a".repeat(100000), // long run, no separators
      "----BEGIN not quite a key----",
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of junkInputs) {
      expect(() => redactSecrets(input)).not.toThrow();
    }
  });
});

describe("guardFtsTokens", () => {
  test("a minified-JS-like line (no whitespace at all) comes out with no token over maxLen", () => {
    const longChain = Array.from({ length: 40 }, (_, i) => `p${i}`).join(".");
    const minified = `const x=${longChain};y.push(x);`;
    expect(longestToken(minified)).toBeGreaterThan(MAX_FTS_TOKEN_LEN);
    const guarded = guardFtsTokens(minified);
    expect(longestToken(guarded)).toBeLessThanOrEqual(MAX_FTS_TOKEN_LEN);
  });

  test("a base64 blob (single token, no whitespace) comes out with no token over maxLen", () => {
    const blob = "A".repeat(200);
    expect(longestToken(blob)).toBeGreaterThan(MAX_FTS_TOKEN_LEN);
    const guarded = guardFtsTokens(blob);
    expect(longestToken(guarded)).toBeLessThanOrEqual(MAX_FTS_TOKEN_LEN);
    // Split strategy: every original character survives, only whitespace
    // is inserted.
    expect(guarded.replace(/\s+/g, "")).toBe(blob);
  });

  test("ordinary text with only short tokens is left byte-for-byte unchanged", () => {
    const input = "The quick brown fox jumps over the lazy dog.";
    expect(guardFtsTokens(input)).toBe(input);
  });

  test("a token exactly at maxLen is left unchanged", () => {
    const token = "x".repeat(MAX_FTS_TOKEN_LEN);
    const input = `prefix ${token} suffix`;
    expect(guardFtsTokens(input)).toBe(input);
  });

  test("a token one char over maxLen gets split", () => {
    const token = "x".repeat(MAX_FTS_TOKEN_LEN + 1);
    const guarded = guardFtsTokens(`prefix ${token} suffix`);
    expect(longestToken(guarded)).toBeLessThanOrEqual(MAX_FTS_TOKEN_LEN);
    expect(guarded.replace(/\s+/g, "")).toBe(`prefix${token}suffix`);
  });

  test("empty string returns empty string", () => {
    expect(guardFtsTokens("")).toBe("");
  });

  test("never throws on arbitrary junk input, including invalid-UTF-8-ish sequences", () => {
    const junkInputs = [
      "𐀀\uD800",
      "%%%***???!!!" + "�".repeat(50),
      "a".repeat(100000),
      null as unknown as string,
      undefined as unknown as string,
    ];
    for (const input of junkInputs) {
      expect(() => guardFtsTokens(input)).not.toThrow();
    }
  });
});
