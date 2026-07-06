import { spawn } from 'node:child_process';
import type { ExecFn, ExecResult } from './types.js';

// The one real child_process implementation of the ExecFn seam. Kept thin: it
// spawns, collects (or inherits) stdio, and resolves with the exit code. All
// higher-level docker orchestration composes this in later phases; tests inject
// a fake ExecFn instead.
export const realExec: ExecFn = (command, args, options = {}) =>
  new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.stdio ?? 'pipe',
    });

    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString()));

    // stdin is null under `stdio: 'inherit'`; only feed/close it when piped.
    if (child.stdin) {
      if (options.input !== undefined) {
        child.stdin.write(options.input);
      }
      child.stdin.end();
    }

    child.on('error', reject);
    child.on('close', (code) =>
      resolve({ code, stdout: out.join(''), stderr: err.join('') }),
    );
  });
