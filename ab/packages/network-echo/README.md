# @ab/network-echo

Dev-only fetch interceptor. Prints a one-line summary of each request via
`console.log` in a format `ab console-tail` already understands. No extra ab
config needed.

## Install

```bash
# From a sibling checkout (typical for workspace / file: dep):
bun add -d file:../../../tools/ab/packages/network-echo
```

## Use

```ts
if (import.meta.env.DEV) {
  import("@ab/network-echo").then((m) =>
    m.install({ urlMatch: /\/api\// })
  );
}
```

Output (captured by `ab console-tail`):

```
[network] POST /api/accounts 200 142ms {"req":{"name":"x"},"res":{"id":42}}
[network] GET /api/foo 500 ERROR 89ms {"req":null,"res":{"error":"..."}}
```

## Options

| Option         | Default      | What it does                                       |
| -------------- | ------------ | -------------------------------------------------- |
| `urlMatch`     | `() => true` | RegExp or predicate; only echo matching URLs       |
| `bodies`       | `true`       | Include request / response bodies                  |
| `bodyMaxBytes` | `2048`       | Per-line truncation for the combined body JSON     |
| `methods`      | all          | Restrict to e.g. `["GET", "POST"]`                 |
| `log`          | `console.log`| Override the sink (rarely needed)                  |

`install()` returns an `uninstall` function that restores the original `fetch`.

## Scope

- Fetch only. XHR / WebSocket are not intercepted. Add if you need them.
- Response bodies are read via `res.clone().text()` so the caller still gets an
  untouched body.
- Gated on `typeof window !== "undefined"` so SSR-safe, but you should still
  guard the import behind a dev flag — this is not meant for production.
