import { test, expect, describe } from "bun:test";
import { autoAuthOrigin, decideAutoAuth } from "../cli";

const KEY = { CLERK_SECRET_KEY: "sk_test_abc" };

describe("autoAuthOrigin", () => {
  const cases: Array<[string, string | undefined]> = [
    ["http://localhost:5173/", "http://localhost:5173"],
    ["http://localhost:5173/accounts/1?x=2", "http://localhost:5173"],
    ["https://my-wt.terra.localhost/accounts", "https://my-wt.terra.localhost"],
    ["https://terra.localhost/", "https://terra.localhost"],
    ["https://slack-feedback-staging.onrender.com/x", "https://slack-feedback-staging.onrender.com"],
    ["https://slack-feedback-development.onrender.com/", "https://slack-feedback-development.onrender.com"],
    ["https://terra.clay.com/", undefined],
    ["https://google.com/", undefined],
    ["http://localhost:3000/", undefined],
    ["http://localhost/", undefined],
    ["http://my-wt.terra.localhost/", undefined],
    ["https://terra.localhost.evil.com/", undefined],
    ["https://evilterra.localhost/", undefined],
    ["https://slack-feedback-staging.onrender.com.evil.com/", undefined],
    ["about:blank", undefined],
    ["not a url", undefined],
    ["", undefined],
  ];
  for (const [url, expected] of cases) {
    test(`${JSON.stringify(url)} -> ${expected ?? "undefined"}`, () => {
      expect(autoAuthOrigin(url)).toBe(expected);
    });
  }
});

describe("decideAutoAuth", () => {
  test("non-dev origin skips even when unauthenticated with a key", () => {
    expect(
      decideAutoAuth({ url: "https://terra.clay.com/", env: KEY, status: { authenticated: false } }),
    ).toEqual({ kind: "skip", reason: "not-dev-origin" });
  });

  test("malformed URL skips", () => {
    expect(
      decideAutoAuth({ url: "nope", env: KEY, status: { authenticated: false } }),
    ).toEqual({ kind: "skip", reason: "not-dev-origin" });
  });

  test("authenticated skips", () => {
    expect(
      decideAutoAuth({ url: "http://localhost:5173/", env: KEY, status: { authenticated: true } }),
    ).toEqual({ kind: "skip", reason: "authenticated" });
  });

  test("unauthenticated without key skips with no-key", () => {
    expect(
      decideAutoAuth({ url: "http://localhost:5173/", env: {}, status: { authenticated: false } }),
    ).toEqual({ kind: "skip", reason: "no-key" });
  });

  test("empty key counts as absent", () => {
    expect(
      decideAutoAuth({ url: "http://localhost:5173/", env: { CLERK_SECRET_KEY: "" }, status: { authenticated: false } }),
    ).toEqual({ kind: "skip", reason: "no-key" });
  });

  test("unauthenticated with key logs in against the origin", () => {
    expect(
      decideAutoAuth({ url: "https://wt.terra.localhost/a/b", env: KEY, status: { authenticated: false } }),
    ).toEqual({ kind: "login", appBaseUrl: "https://wt.terra.localhost" });
  });
});
