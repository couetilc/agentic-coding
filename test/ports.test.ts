import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EPHEMERAL_MAX,
  EPHEMERAL_MIN,
  pickPorts,
  realPortDeps,
} from '../src/ports.js';
import type { PortDeps } from '../src/types.js';

// A fake seam: `randomInt` replays a scripted sequence of candidate ports and
// `occupied` marks which of them are "in use", so the retry/distinctness logic
// runs without real sockets.
function fakeDeps(
  sequence: number[],
  occupied: Set<number> = new Set(),
): PortDeps {
  let i = 0;
  return {
    randomInt: () => {
      const value = sequence[i % sequence.length];
      i += 1;
      return value;
    },
    tryListen: async (port) => !occupied.has(port),
  };
}

describe('pickPorts', () => {
  it('returns the first free port', async () => {
    const deps = fakeDeps([50000]);
    expect(await pickPorts(deps, 1)).toEqual([50000]);
  });

  it('retries past an occupied port', async () => {
    const deps = fakeDeps([50000, 50001], new Set([50000]));
    expect(await pickPorts(deps, 1)).toEqual([50001]);
  });

  it('picks distinct ports even when the RNG repeats a value', async () => {
    // RNG offers 50000, 50000 (dup — skipped without a listen), then 50001.
    const deps = fakeDeps([50000, 50000, 50001]);
    expect(await pickPorts(deps, 2)).toEqual([50000, 50001]);
  });

  it('returns [] for a count of 0', async () => {
    const deps = fakeDeps([50000]);
    expect(await pickPorts(deps, 0)).toEqual([]);
  });
});

describe('realPortDeps', () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(() => {
    for (const s of servers) {
      s.close();
    }
    servers.length = 0;
  });

  it('randomInt stays within the ephemeral range', () => {
    for (let i = 0; i < 200; i++) {
      const port = realPortDeps.randomInt(EPHEMERAL_MIN, EPHEMERAL_MAX);
      expect(port).toBeGreaterThanOrEqual(EPHEMERAL_MIN);
      expect(port).toBeLessThanOrEqual(EPHEMERAL_MAX);
    }
  });

  it('tryListen reports a free port as free and an occupied one as taken', async () => {
    // Bind a server to a kernel-chosen port, then probe that exact port.
    const held = createServer();
    servers.push(held);
    const taken = await new Promise<number>((resolve) => {
      held.listen(0, '127.0.0.1', () =>
        resolve((held.address() as AddressInfo).port),
      );
    });
    expect(await realPortDeps.tryListen(taken)).toBe(false);

    // Now free it and confirm the probe flips to free.
    await new Promise<void>((resolve) => held.close(() => resolve()));
    servers.length = 0;
    expect(await realPortDeps.tryListen(taken)).toBe(true);
  });
});
