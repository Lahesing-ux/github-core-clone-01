// The entry the grader runs: start the forge, tell the env which port it bound, and stay up until the
// env says the trial is over. The server itself lives in app.ts; this file is only the lifecycle.

import { createApp } from './app.ts';

/** The env's origin. Without it there is nothing to register with, so the process exits 1. */
const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_START_MS = 200;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_START_MS * 2 ** Math.min(attempt, 6));
}

/** POST the bound port to the env until it takes it (200) or another entry already did (409). */
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(envUrl + '/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.status === 200 || response.status === 409) return;
      if (response.status === 400 || response.status === 405) {
        throw new Error('register answered HTTP ' + response.status + ': ' + (await response.text()));
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP')) throw err;
    }
    await sleep(backoff(attempt));
  }
}

/** Poll GET /done; the env answers at once, so this is a poll and never a held request. */
async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(envUrl + '/done', { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not up yet, or the poll timed out: keep polling, never exit early.
    }
    await sleep(backoff(attempt));
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write('[entry] listening on port ' + address.port + '\n');
  await register(address.port);
  process.stdout.write('[entry] registered, waiting for done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write('[entry] ' + (err instanceof Error ? err.message : String(err)) + '\n');
  process.exit(1);
}
