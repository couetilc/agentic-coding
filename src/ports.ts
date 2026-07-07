import { createServer } from 'node:net';
import type { PortDeps } from './types.js';

// Free host-port picking (port of news's pick_port/port_free). news probed with
// bash's /dev/tcp; here we bind a throwaway TCP server on 127.0.0.1 in the
// ephemeral range and keep a port only if the bind succeeded. A fresh random
// port per launch means parallel containers never collide, and picking N ports
// keeps them distinct so two named dev servers never map to the same host port.
export const EPHEMERAL_MIN = 49152;
export const EPHEMERAL_MAX = 65535;

// One free port not already in `exclude`. Retries occupied/duplicate picks —
// the ephemeral range is 16384 wide, so collisions are rare and the loop is
// bounded in practice by how many ports the host actually holds open.
async function pickOne(deps: PortDeps, exclude: Set<number>): Promise<number> {
  for (;;) {
    const port = deps.randomInt(EPHEMERAL_MIN, EPHEMERAL_MAX);
    if (exclude.has(port)) {
      continue;
    }
    if (await deps.tryListen(port)) {
      return port;
    }
  }
}

// `count` distinct free ports.
export async function pickPorts(
  deps: PortDeps,
  count: number,
): Promise<number[]> {
  const chosen: number[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    const port = await pickOne(deps, used);
    used.add(port);
    chosen.push(port);
  }
  return chosen;
}

// Real seam: bind a server to test occupancy, and Math.random for the pick.
export const realPortDeps: PortDeps = {
  tryListen: (port) =>
    new Promise<boolean>((resolve) => {
      const server = createServer();
      // EADDRINUSE (or any bind error) → occupied.
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close(() => resolve(true));
      });
      server.listen(port, '127.0.0.1');
    }),
  randomInt: (min, max) => min + Math.floor(Math.random() * (max - min + 1)),
};
