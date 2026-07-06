import { afterEach, expect, test, vi } from 'vitest';

// Isolated in its own file: it mutates process globals and evaluates cli.ts's
// top-level bootstrap. AGENTIC_FORCE_MAIN forces the entry branch so it is
// covered in-process without cli.ts ever running on a plain import elsewhere.
const origArgv = process.argv;
const origExitCode = process.exitCode;

afterEach(() => {
  process.argv = origArgv;
  process.exitCode = origExitCode;
  delete process.env.AGENTIC_FORCE_MAIN;
  vi.restoreAllMocks();
  vi.resetModules();
});

test('bootstraps and runs when AGENTIC_FORCE_MAIN=1', async () => {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  process.env.AGENTIC_FORCE_MAIN = '1';
  process.argv = [process.execPath, 'cli.js', '--help'];

  await import('../src/cli.js');

  expect(writes.join('')).toContain('Usage: agent');
  expect(process.exitCode).toBe(0);
});
