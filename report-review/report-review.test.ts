/**
 * Drives the REAL `report-review` bash script (sibling file) against a loopback
 * `Bun.serve` stub (ops-hub plan 2026-11-06-report-item-review-status, U6). Async
 * `Bun.spawn`, not `spawnSync`: spawnSync blocks the event loop the in-process
 * stub needs (a blocked loop never serves the request). HOME is a fresh mkdtemp per test so
 * the real `~/.config/report-review/token` is never read.
 */
import { describe, it, expect } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dir, 'report-review');
const CLI_ENVELOPE_SH = join(import.meta.dir, '../cli-envelope.sh');

const MISSING_PREREQUISITES = [
  ...(Bun.which('jq') === null ? ['jq'] : []),
  ...(Bun.which('curl') === null ? ['curl'] : []),
  ...(Bun.which('bash') === null ? ['bash'] : []),
  ...(existsSync(CLI_ENVELOPE_SH) ? [] : [CLI_ENVELOPE_SH]),
];
const CAN_RUN = MISSING_PREREQUISITES.length === 0;
const describeMaybe = CAN_RUN ? describe : describe.skip;

// Locally a missing tool skips the suite; in CI that would turn a broken
// runner into a silent green, so CI fails loudly instead.
const itInCi = process.env.CI ? it : it.skip;
describe('report-review CLI test prerequisites', () => {
  itInCi('jq, curl, bash and cli-envelope.sh are all present', () => {
    expect(MISSING_PREREQUISITES).toEqual([]);
  });
});

interface Recorded {
  method: string;
  path: string;
  search: string;
  authorization: string | null;
  bodyText: string;
}

function startStub(respond: (req: Request) => Response) {
  const requests: Recorded[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      requests.push({
        method: req.method,
        path: new URL(req.url).pathname,
        search: new URL(req.url).search,
        authorization: req.headers.get('authorization'),
        bodyText: await req.text(),
      });
      return respond(req);
    },
  });
  return { server, url: `http://127.0.0.1:${server.port}`, requests };
}

function env(url: string, token?: string): Record<string, string> {
  const e: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: mkdtempSync(join(tmpdir(), 'report-review-home-')),
    CLI_ENVELOPE_SH,
    REPORT_REVIEW_URL: url,
  };
  if (token !== undefined) e.REPORT_REVIEW_TOKEN = token;
  return e;
}

async function run(args: string[], childEnv: Record<string, string>) {
  const proc = Bun.spawn(['bash', SCRIPT, ...args], { env: childEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

const ok = (body: unknown) => Response.json(body);
const problemResponse = (status: number, detail: string) =>
  new Response(JSON.stringify({ title: 'x', status, detail }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

describeMaybe('report-review', () => {
  it('passes bash -n', () => {
    expect(Bun.spawnSync(['bash', '-n', SCRIPT]).exitCode).toBe(0);
  });

  it('ticketed POSTs item, status and ref with the bearer token', async () => {
    const stub = startStub(() => ok({ ok: true, review: { status: 'ticketed' } }));
    try {
      const r = await run(['ticketed', '2026-11-06#3:a1b2c3', 'ENG-1234'], env(stub.url, 'tok-abc'));
      expect(r.exitCode).toBe(0);
      const envelope = JSON.parse(r.stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.result.review.status).toBe('ticketed');
      expect(stub.requests).toHaveLength(1);
      const req = stub.requests[0];
      expect(req.method).toBe('POST');
      expect(req.path).toBe('/api/admin/report-reviews');
      expect(req.authorization).toBe('Bearer tok-abc');
      expect(JSON.parse(req.bodyText)).toEqual({ item: '2026-11-06#3:a1b2c3', status: 'ticketed', ref: 'ENG-1234' });
    } finally {
      stub.server.stop(true);
    }
  });

  it('wontfix POSTs item, status and note', async () => {
    const stub = startStub(() => ok({ ok: true, review: { status: 'wontfix' } }));
    try {
      const r = await run(['wontfix', '2026-11-06#3:a1b2c3', 'expected during deploys'], env(stub.url, 'tok'));
      expect(r.exitCode).toBe(0);
      const req = stub.requests[0];
      expect(req.method).toBe('POST');
      expect(JSON.parse(req.bodyText)).toEqual({
        item: '2026-11-06#3:a1b2c3',
        status: 'wontfix',
        note: 'expected during deploys',
      });
    } finally {
      stub.server.stop(true);
    }
  });

  it('list GETs with no body', async () => {
    const stub = startStub(() => ok({ ok: true, reviews: [] }));
    try {
      const r = await run(['list'], env(stub.url, 'tok'));
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).result).toEqual({ ok: true, reviews: [] });
      const req = stub.requests[0];
      expect(req.method).toBe('GET');
      expect(req.path).toBe('/api/admin/report-reviews');
      expect(req.bodyText).toBe('');
      expect(req.authorization).toBe('Bearer tok');
    } finally {
      stub.server.stop(true);
    }
  });

  it('clear DELETEs with the item body', async () => {
    const stub = startStub(() => ok({ ok: true, deleted: 1 }));
    try {
      const r = await run(['clear', '2026-11-06#3:a1b2c3'], env(stub.url, 'tok'));
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).result.deleted).toBe(1);
      const req = stub.requests[0];
      expect(req.method).toBe('DELETE');
      expect(JSON.parse(req.bodyText)).toEqual({ item: '2026-11-06#3:a1b2c3' });
    } finally {
      stub.server.stop(true);
    }
  });

  describe('show', () => {
    const SHOWN = {
      ok: true,
      item: {
        item: '2026-11-06#3',
        serviceId: 'srv-d6gc0ga4d50c738i614g',
        title: 'pg-boss job enrich-account timing out',
        severity: 'high',
        signature: 'Job enrich-account timed out after <n>ms',
        reviewRef: '2026-11-06#3:a1b2c3',
        review: null,
      },
    };

    it('GETs /item with # encoded as %23, no body, the bearer token, and hints at the reviewRef', async () => {
      const stub = startStub(() => ok(SHOWN));
      try {
        const r = await run(['show', '2026-11-06#3'], env(stub.url, 'tok-abc'));
        expect(r.exitCode).toBe(0);
        expect(stub.requests).toHaveLength(1);
        const req = stub.requests[0];
        expect(req.method).toBe('GET');
        expect(req.path).toBe('/api/admin/report-reviews/item');
        expect(req.search).toBe('?item=2026-11-06%233');
        expect(req.bodyText).toBe('');
        expect(req.authorization).toBe('Bearer tok-abc');

        const envelope = JSON.parse(r.stdout);
        expect(envelope.ok).toBe(true);
        expect(envelope.command).toBe('report-review show');
        expect(envelope.result).toEqual(SHOWN);
        const commands = envelope.next_actions.map((a: { command: string }) => a.command);
        expect(commands).toEqual([
          'report-review ticketed 2026-11-06#3:a1b2c3 <ref>',
          'report-review fixed 2026-11-06#3:a1b2c3 <ref>',
          'report-review wontfix 2026-11-06#3:a1b2c3 <note>',
        ]);
      } finally {
        stub.server.stop(true);
      }
    });

    it('explains a null signature in next_actions and suggests no ticketed or wontfix command', async () => {
      const stub = startStub(() =>
        ok({ ok: true, item: { ...SHOWN.item, signature: null, reviewRef: null, review: null } }),
      );
      try {
        const r = await run(['show', '2026-11-06#3'], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(0);
        const envelope = JSON.parse(r.stdout);
        expect(envelope.result.item.reviewRef).toBeNull();
        expect(envelope.next_actions).toHaveLength(1);
        expect(envelope.next_actions[0].command).not.toMatch(/ticketed|wontfix/);
        expect(envelope.next_actions[0].description).toContain('no signature');
        expect(envelope.next_actions[0].description).toContain('cannot be reviewed');
      } finally {
        stub.server.stop(true);
      }
    });

    it('rejects a malformed or tag-bearing ref locally with zero requests', async () => {
      const stub = startStub(() => ok({}));
      try {
        for (const bad of [
          '',
          '2026-11-06',
          '2026-11-06#',
          '2026-11-06#x',
          '2026-11-06#3:a1b2c3',
          '2026-11-06#3#4',
          '11-06#3',
          '2026-11-06#3 ',
        ]) {
          const r = await run(['show', bad], env(stub.url, 'tok'));
          expect(r.exitCode).toBe(1);
          const code = JSON.parse(r.stdout).error.code;
          expect(code).toBe(bad === '' ? 'MISSING_ARG' : 'INVALID_ARG');
        }
        expect(stub.requests).toHaveLength(0);
      } finally {
        stub.server.stop(true);
      }
    });

    it('turns a 404 into NOT_FOUND echoing the server detail', async () => {
      const stub = startStub(() => problemResponse(404, 'Report 2026-11-06 has no needs-human item 9'));
      try {
        const r = await run(['show', '2026-11-06#9'], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(1);
        const err = JSON.parse(r.stdout).error;
        expect(err.code).toBe('NOT_FOUND');
        expect(err.message).toContain('no needs-human item 9');
      } finally {
        stub.server.stop(true);
      }
    });

    it('fails with AUTH_MISSING and no request when there is no token', async () => {
      const stub = startStub(() => ok({}));
      try {
        const r = await run(['show', '2026-11-06#3'], env(stub.url));
        expect(JSON.parse(r.stdout).error.code).toBe('AUTH_MISSING');
        expect(stub.requests).toHaveLength(0);
      } finally {
        stub.server.stop(true);
      }
    });
  });

  it('reads the token from ~/.config/report-review/token when the env var is unset', async () => {
    const stub = startStub(() => ok({ ok: true, reviews: [] }));
    try {
      const e = env(stub.url);
      mkdirSync(join(e.HOME, '.config', 'report-review'), { recursive: true });
      writeFileSync(join(e.HOME, '.config', 'report-review', 'token'), 'file-tok\n');
      const r = await run(['list'], e);
      expect(r.exitCode).toBe(0);
      expect(stub.requests[0].authorization).toBe('Bearer file-tok');
    } finally {
      stub.server.stop(true);
    }
  });

  it('fails with AUTH_MISSING and makes no request when there is no token', async () => {
    const stub = startStub(() => ok({}));
    try {
      const r = await run(['list'], env(stub.url));
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).error.code).toBe('AUTH_MISSING');
      expect(stub.requests).toHaveLength(0);
    } finally {
      stub.server.stop(true);
    }
  });

  it('rejects a bad ref form locally without calling the server', async () => {
    const stub = startStub(() => ok({}));
    try {
      for (const bad of [
        '2026-11-06',
        '2026-11-06#',
        '11-06#3:a1b2c3',
        '2026-11-06#x:a1b2c3',
        '2026-11-06#3',
        '2026-11-06#3:',
        '2026-11-06#3:a1b2c',
        '2026-11-06#3:zzzzzz',
        '2026-11-06#3:A1B2C3',
        '2026-11-06#3:a1b2c3#4',
        '',
      ]) {
        const r = await run(['clear', bad], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(1);
        const code = JSON.parse(r.stdout).error.code;
        expect(['INVALID_ARG', 'MISSING_ARG']).toContain(code);
      }
      expect(stub.requests).toHaveLength(0);
    } finally {
      stub.server.stop(true);
    }
  });

  it('refuses wontfix with an empty or blank note locally', async () => {
    const stub = startStub(() => ok({}));
    try {
      for (const args of [['wontfix', '2026-11-06#3:a1b2c3'], ['wontfix', '2026-11-06#3:a1b2c3', ''], ['wontfix', '2026-11-06#3:a1b2c3', '   ']]) {
        const r = await run(args, env(stub.url, 'tok'));
        expect(r.exitCode).toBe(1);
        expect(JSON.parse(r.stdout).error.code).toBe('MISSING_ARG');
      }
      expect(stub.requests).toHaveLength(0);
    } finally {
      stub.server.stop(true);
    }
  });

  describe('fixed', () => {
    const ITEM = '2026-11-06#3:a1b2c3';

    it('POSTs item, status fixed and ref (no note key) with the bearer token', async () => {
      const stub = startStub(() => ok({ ok: true, review: { status: 'fixed' } }));
      try {
        const r = await run(['fixed', ITEM, 'clay-run/terra#123'], env(stub.url, 'tok-abc'));
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(r.stdout).result.review.status).toBe('fixed');
        expect(stub.requests).toHaveLength(1);
        const req = stub.requests[0];
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/api/admin/report-reviews');
        expect(req.authorization).toBe('Bearer tok-abc');
        expect(JSON.parse(req.bodyText)).toEqual({ item: ITEM, status: 'fixed', ref: 'clay-run/terra#123' });
      } finally {
        stub.server.stop(true);
      }
    });

    it('passes an optional note through', async () => {
      const stub = startStub(() => ok({ ok: true }));
      try {
        const r = await run(['fixed', ITEM, '#42', 'shipped in the retry fix'], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(0);
        expect(JSON.parse(stub.requests[0].bodyText)).toEqual({
          item: ITEM,
          status: 'fixed',
          ref: '#42',
          note: 'shipped in the retry fix',
        });
      } finally {
        stub.server.stop(true);
      }
    });

    it('accepts a PR URL and a ticket id as ref, and a 200-char ref and 500-char note', async () => {
      const stub = startStub(() => ok({ ok: true }));
      try {
        for (const ref of ['https://github.com/clay-run/terra/pull/9', 'ENG-1234', 'x'.repeat(200)]) {
          const r = await run(['fixed', ITEM, ref], env(stub.url, 'tok'));
          expect(r.exitCode).toBe(0);
        }
        const r = await run(['fixed', ITEM, 'ENG-1', 'n'.repeat(500)], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(0);
        expect(stub.requests).toHaveLength(4);
      } finally {
        stub.server.stop(true);
      }
    });

    it('rejects a missing, blank, or 201-char ref locally with zero requests', async () => {
      const stub = startStub(() => ok({}));
      try {
        const cases: Array<[string[], string]> = [
          [['fixed', ITEM], 'MISSING_ARG'],
          [['fixed', ITEM, ''], 'MISSING_ARG'],
          [['fixed', ITEM, '   '], 'MISSING_ARG'],
          [['fixed', ITEM, 'x'.repeat(201)], 'INVALID_ARG'],
        ];
        for (const [args, code] of cases) {
          const r = await run(args, env(stub.url, 'tok'));
          expect(r.exitCode).toBe(1);
          expect(JSON.parse(r.stdout).error.code).toBe(code);
        }
        expect(stub.requests).toHaveLength(0);
      } finally {
        stub.server.stop(true);
      }
    });

    it('rejects a 501-char note and a bad item ref locally with zero requests', async () => {
      const stub = startStub(() => ok({}));
      try {
        const long = await run(['fixed', ITEM, 'ENG-1', 'n'.repeat(501)], env(stub.url, 'tok'));
        expect(long.exitCode).toBe(1);
        expect(JSON.parse(long.stdout).error.code).toBe('INVALID_ARG');
        const bad = await run(['fixed', '2026-11-06#3', 'ENG-1'], env(stub.url, 'tok'));
        expect(bad.exitCode).toBe(1);
        expect(JSON.parse(bad.stdout).error.code).toBe('INVALID_ARG');
        expect(stub.requests).toHaveLength(0);
      } finally {
        stub.server.stop(true);
      }
    });
  });

  it('passes the server detail through on 422 (no signature)', async () => {
    const detail = 'this item has no signature, so it cannot be tracked across days';
    const stub = startStub(() => problemResponse(422, detail));
    try {
      const r = await run(['ticketed', '2026-11-06#3:a1b2c3', 'ENG-1'], env(stub.url, 'tok'));
      expect(r.exitCode).toBe(1);
      const envelope = JSON.parse(r.stdout);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.code).toBe('UNPROCESSABLE');
      expect(envelope.error.message).toContain(detail);
    } finally {
      stub.server.stop(true);
    }
  });

  it('maps 409 (stale ref) to CONFLICT and echoes the detail', async () => {
    const detail = 'The report changed since you loaded it: item 3 of 2026-11-06 is now "Other"';
    const stub = startStub(() => problemResponse(409, detail));
    try {
      const r = await run(['clear', '2026-11-06#3:a1b2c3'], env(stub.url, 'tok'));
      expect(r.exitCode).toBe(1);
      const envelope = JSON.parse(r.stdout);
      expect(envelope.error.code).toBe('CONFLICT');
      expect(envelope.error.message).toContain(detail);
    } finally {
      stub.server.stop(true);
    }
  });

  it('maps 401, 403 and 404 to distinct error codes that echo the detail', async () => {
    const cases: Array<[number, string]> = [
      [401, 'UNAUTHORIZED'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
    ];
    for (const [status, code] of cases) {
      const stub = startStub(() => problemResponse(status, `detail-${status}`));
      try {
        const r = await run(['list'], env(stub.url, 'tok'));
        expect(r.exitCode).toBe(1);
        const envelope = JSON.parse(r.stdout);
        expect(envelope.error.code).toBe(code);
        expect(envelope.error.message).toContain(`detail-${status}`);
      } finally {
        stub.server.stop(true);
      }
    }
  });

  it('has no api passthrough and rejects unknown subcommands', async () => {
    const r = await run(['api', 'GET', '/x'], env('http://127.0.0.1:1', 'tok'));
    expect(r.exitCode).toBe(1);
    expect(JSON.parse(r.stdout).error.code).toBe('UNKNOWN_COMMAND');
  });

  it('root invocation lists exactly the six subcommands', async () => {
    const r = await run([], env('http://127.0.0.1:1'));
    expect(r.exitCode).toBe(0);
    const names = JSON.parse(r.stdout).result.commands.map((c: { name: string }) => c.name);
    expect(names).toEqual(['ticketed', 'fixed', 'wontfix', 'list', 'show', 'clear']);
  });

  it('refuses a non-https REPORT_REVIEW_URL unless the host is localhost or 127.0.0.1, before any request', async () => {
    const bad = [
      'http://example.com',
      'http://localhost.evil.example',
      'http://localhost@evil.example',
      'http://127.0.0.1.evil.example',
      'ftp://127.0.0.1',
      'example.com',
    ];
    for (const url of bad) {
      const r = await run(['list'], env(url, 'tok'));
      expect(r.exitCode).toBe(1);
      expect(JSON.parse(r.stdout).error.code).toBe('INVALID_URL');
    }
  });

  it('accepts https URLs and loopback http URLs (the check is not what fails them)', async () => {
    // Nothing listens on port 1, so these fail at the network, not at INVALID_URL.
    for (const url of ['https://127.0.0.1:1', 'https://ops-hub.invalid', 'http://localhost:1', 'http://127.0.0.1:1']) {
      const r = await run(['list'], env(url, 'tok'));
      expect(JSON.parse(r.stdout).error.code).toBe('NETWORK_ERROR');
    }
  });

  it('warns on stderr, and still runs, when the token file is group or world readable', async () => {
    const stub = startStub(() => ok({ ok: true, reviews: [] }));
    try {
      const e = env(stub.url);
      const tokenFile = join(e.HOME, '.config', 'report-review', 'token');
      mkdirSync(join(e.HOME, '.config', 'report-review'), { recursive: true });
      writeFileSync(tokenFile, 'file-tok\n');

      chmodSync(tokenFile, 0o644);
      const loose = await run(['list'], e);
      expect(loose.exitCode).toBe(0);
      expect(loose.stderr).toContain('readable by group or others');
      expect(stub.requests[0].authorization).toBe('Bearer file-tok');

      chmodSync(tokenFile, 0o600);
      const strict = await run(['list'], e);
      expect(strict.exitCode).toBe(0);
      expect(strict.stderr).not.toContain('readable by group or others');
    } finally {
      stub.server.stop(true);
    }
  });

  describe('token file mode check with a shadowed stat on PATH', () => {
    function withStatStub(body: string) {
      const e = env('http://127.0.0.1:1');
      const bin = mkdtempSync(join(tmpdir(), 'report-review-stat-'));
      const writeStub = (stubBody: string) => {
        writeFileSync(join(bin, 'stat'), `#!/bin/bash\n${stubBody}\n`);
        chmodSync(join(bin, 'stat'), 0o755);
      };
      writeStub(body);
      e.PATH = `${bin}:${e.PATH}`;
      const tokenFile = join(e.HOME, '.config', 'report-review', 'token');
      mkdirSync(join(e.HOME, '.config', 'report-review'), { recursive: true });
      writeFileSync(tokenFile, 'file-tok\n');
      return { e, tokenFile, writeStub };
    }

    // Emulates GNU coreutils without calling the host stat, so it behaves the
    // same on macOS and Linux runners: -c '%a' prints a fixed octal mode, -f is
    // filesystem status (exits 0, prints a non-mode line).
    const gnuStat = (mode: string) => `
if [ "$1" = "-c" ] && [ "$2" = "%a" ]; then echo '${mode}'; exit 0; fi
if [ "$1" = "-f" ]; then echo '  File: "x"  ID: 0 Namelen: 255 Type: ext2/ext3'; exit 0; fi
exit 1`;

    it('GNU stat: warns on a loose token file and stays quiet on a strict one', async () => {
      const { e, tokenFile, writeStub } = withStatStub(gnuStat('644'));
      chmodSync(tokenFile, 0o644);
      const loose = await run(['list'], e);
      expect(loose.stderr).toContain('readable by group or others');
      expect(loose.stderr).toContain('mode 644');

      writeStub(gnuStat('600'));
      chmodSync(tokenFile, 0o600);
      const strict = await run(['list'], e);
      expect(strict.stderr).not.toContain('readable by group or others');
    });

    it('does not warn, and does not crash, when stat prints something that is not an octal mode', async () => {
      for (const output of ['garbage', '7777777']) {
        const { e, tokenFile } = withStatStub(`echo '${output}'; exit 0`);
        chmodSync(tokenFile, 0o644);
        const r = await run(['list'], e);
        expect(r.stderr).not.toContain('readable by group or others');
        // The token still loads: the request is attempted (nothing listens on port 1).
        expect(JSON.parse(r.stdout).error.code).toBe('NETWORK_ERROR');
      }
    });
  });

  it('removes its temp files (token config, body, response) when terminated mid-request', async () => {
    const received: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        received.push(req.method);
        return new Promise<Response>(() => {}); // never answers
      },
    });
    const tmp = mkdtempSync(join(tmpdir(), 'report-review-tmp-'));
    try {
      const e = { ...env(`http://127.0.0.1:${server.port}`, 'tok'), TMPDIR: tmp };
      const proc = Bun.spawn(['bash', SCRIPT, 'ticketed', '2026-11-06#3:a1b2c3', 'ENG-1'], {
        env: e,
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: 'ignore',
      });
      const deadline = Date.now() + 10_000;
      while (received.length === 0 && Date.now() < deadline) await Bun.sleep(25);
      expect(received).toEqual(['POST']);
      // Precondition: the files exist while the request is in flight, so an
      // empty directory afterwards proves the trap removed them.
      expect(readdirSync(tmp).length).toBeGreaterThan(0);

      proc.kill('SIGTERM');
      const exitCode = await proc.exited;

      expect(exitCode).toBe(143);
      expect(readdirSync(tmp)).toEqual([]);
    } finally {
      server.stop(true);
    }
  });
});
