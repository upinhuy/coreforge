// CoreForge's entrypoint: the lifecycle the trial env expects, nothing more.
// The env names itself in MAKEFUN_ENV_URL; this process binds an ephemeral
// port (never 8080 — the env owns that one), tells the env the port, then
// polls the env's /done until the trial is over, closes the server and exits
// 0. All of the forge itself lives behind createApp() in app.ts.

import { createApp } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

if (ENV_URL === '') {
  process.stderr.write('[coreforge] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_FIRST_MS = 250;
const RETRY_CAP_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff between retries of a register or poll request. */
function backoff(attempt: number): number {
  return Math.min(RETRY_CAP_MS, RETRY_FIRST_MS * 2 ** Math.min(attempt, 8));
}

/**
 * POST {"port": N} to the env until it accepts. 200 is the normal answer and
 * 409 means another registration already won — both end the loop. A 400 or 405
 * is a contract error and ends the program; anything else (including a
 * network failure while the env is still starting) is retried.
 */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done until the env answers {"done": true}; never return early. */
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done.
    }
    await sleep(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  // A signal from the harness is a stop, not a crash: close and exit cleanly.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      server.close();
      process.exit(0);
    });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[coreforge] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[coreforge] registered; waiting for the env to say done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[coreforge] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[coreforge] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
