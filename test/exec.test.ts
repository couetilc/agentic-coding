import { describe, expect, it } from 'vitest';
import { realExec } from '../src/exec.js';

const NODE = process.execPath;

describe('realExec', () => {
  it('captures piped stdout and stderr with the exit code', async () => {
    const result = await realExec(NODE, [
      '-e',
      "process.stdout.write('OUT'); process.stderr.write('ERR')",
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('OUT');
    expect(result.stderr).toBe('ERR');
  });

  it('feeds stdin from options.input', async () => {
    const result = await realExec(
      NODE,
      [
        '-e',
        "let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>process.stdout.write('got:'+d))",
      ],
      { input: 'hello' },
    );
    expect(result.stdout).toBe('got:hello');
  });

  it('runs with default options and no input', async () => {
    const result = await realExec(NODE, ['-e', '']);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('inherits stdio when asked (no captured output)', async () => {
    const result = await realExec(NODE, ['-e', ''], { stdio: 'inherit' });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  it('rejects when the command cannot be spawned', async () => {
    await expect(
      realExec(`__no_such_cmd_${Date.now()}__`, []),
    ).rejects.toBeInstanceOf(Error);
  });
});
