import { createApp } from './app.ts';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

try {
  const baseUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl) {
    process.stderr.write('MAKEFUN_ENV_URL is required\n');
    process.exit(1);
  }

  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Server did not expose a numeric port');
  }

  let delay = 200;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: address.port }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      await sleep(delay);
      delay = Math.min(delay * 2, 2_000);
      continue;
    }

    if (response.status === 200 || response.status === 409) break;

    const text = await response.text().catch(() => '');
    if (response.status === 400 || response.status === 405) {
      throw new Error(`Registration failed (${response.status}): ${text}`);
    }

    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }

  delay = 200;
  for (;;) {
    let done = false;
    try {
      const response = await fetch(`${baseUrl}/done`, {
        method: 'GET',
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 200) {
        const body = (await response.json()) as { done?: unknown };
        done = body.done === true;
      } else {
        await response.text();
      }
    } catch {
      done = false;
    }

    if (done) break;
    await sleep(delay);
    delay = Math.min(delay * 2, 2_000);
  }

  server.close();
  process.stdout.write('Trial complete\n');
  process.exit(0);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
