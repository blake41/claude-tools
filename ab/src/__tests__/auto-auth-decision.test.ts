import { test, expect, describe } from "bun:test";
import { autoAuthOrigin } from "../app-origins";

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
