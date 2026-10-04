import { test, expect, describe } from "bun:test";
import { checkAgentTaskGuards } from "../auth";

describe("checkAgentTaskGuards", () => {
  test("allows a development key against a non-prod host", () => {
    const r = checkAgentTaskGuards({ secretKey: "sk_test_abc", appBaseUrl: "https://slack-feedback-staging.onrender.com" });
    expect(r).toEqual({ ok: true });
  });

  test("refuses when no key is available and names CLERK_SECRET_KEY", () => {
    const r = checkAgentTaskGuards({ secretKey: undefined, appBaseUrl: "http://localhost:5173" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("CLERK_SECRET_KEY");
  });

  test("refuses a sk_live_ key without echoing the key", () => {
    const r = checkAgentTaskGuards({ secretKey: "sk_live_SUPERSECRET", appBaseUrl: "http://localhost:5173" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("sk_test_");
      expect(r.error).not.toContain("SUPERSECRET");
    }
  });

  test("refuses the production app host even with a test key", () => {
    const r = checkAgentTaskGuards({ secretKey: "sk_test_abc", appBaseUrl: "https://terra.clay.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("terra.clay.com");
      expect(r.error).toContain("ab import");
    }
  });

  test("production host check is by hostname, case-insensitive, any path/port", () => {
    expect(checkAgentTaskGuards({ secretKey: "sk_test_abc", appBaseUrl: "https://TERRA.clay.com:443/x" }).ok).toBe(false);
    expect(checkAgentTaskGuards({ secretKey: "sk_test_abc", appBaseUrl: "https://notterra.clay.com.evil.test" }).ok).toBe(true);
  });

  test("refuses an unparseable appBaseUrl", () => {
    expect(checkAgentTaskGuards({ secretKey: "sk_test_abc", appBaseUrl: "not a url" }).ok).toBe(false);
  });
});
