import { test, expect, describe } from "bun:test";
import { autoAuthOrigin } from "../app-origins";
import { needsLogin } from "../auto-auth";

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

describe("needsLogin", () => {
  test("authenticated skips even with a key", () => {
    expect(needsLogin({ authenticated: true }, KEY)).toBe("skip");
  });

  test("authenticated skips without a key", () => {
    expect(needsLogin({ authenticated: true }, {})).toBe("skip");
  });

  test("unauthenticated without key is no-key", () => {
    expect(needsLogin({ authenticated: false }, {})).toBe("no-key");
  });

  test("empty key counts as absent", () => {
    expect(needsLogin({ authenticated: false }, { CLERK_SECRET_KEY: "" })).toBe("no-key");
  });

  test("unauthenticated with key needs login", () => {
    expect(needsLogin({ authenticated: false }, KEY)).toBe("login");
  });
});
