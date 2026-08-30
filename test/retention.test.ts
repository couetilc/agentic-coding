import { describe, expect, it } from 'vitest';
import {
  expiredContainerIds,
  expiredImageRefs,
  maybeSweep,
  parseDockerDate,
  readMarker,
  retentionStatusLines,
  shouldSweep,
  sweepImagesArgs,
  sweepMarkerPath,
  sweepPsArgs,
} from '../src/retention.js';
import type {
  AgentConfig,
  ExecFn,
  ExecOptions,
  ExecResult,
  RetentionDeps,
} from '../src/types.js';

const CONFIG = { project: 'couetil-com', retentionDays: 30 } as AgentConfig;
const V = '1.2.3';

// A fixed "now" and docker-style CreatedAt strings around the 30d horizon.
const NOW = Date.parse('2026-08-30 12:00:00 +0000');
const OLD = '2026-07-01 12:00:00 +0000 UTC'; // 60d old — expired
const FRESH = '2026-08-29 12:00:00 +0000 UTC'; // 1d old — kept
const MARKER = '/home/me/.config/agentic-coding/sweep-couetil-com.json';

interface Call {
  command: string;
  args: string[];
  options?: ExecOptions;
}

function fakeExec(
  handler: (call: Call) => Partial<ExecResult> = () => ({}),
): { exec: ExecFn; calls: Call[] } {
  const calls: Call[] = [];
  const exec: ExecFn = async (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    return { code: 0, stdout: '', stderr: '', ...handler(call) };
  };
  return { exec, calls };
}

function makeDeps(over: Partial<RetentionDeps> = {}): {
  deps: RetentionDeps;
  calls: Call[];
  writes: Record<string, string>;
  err: () => string;
} {
  const f = fakeExec();
  const writes: Record<string, string> = {};
  const errBuf: string[] = [];
  const deps: RetentionDeps = {
    exec: f.exec,
    home: '/home/me',
    now: () => new Date(NOW),
    readTextFile: () => undefined,
    writeTextFile: (path, content) => {
      writes[path] = content;
    },
    mkdirp: () => {},
    err: (t) => errBuf.push(t),
    ...over,
  };
  return { deps, calls: f.calls, writes, err: () => errBuf.join('') };
}

describe('marker file', () => {
  it('sweepMarkerPath is per-project under ~/.config/agentic-coding', () => {
    expect(sweepMarkerPath('/home/me', 'couetil-com')).toBe(MARKER);
  });

  it('readMarker keeps only correctly-typed fields', () => {
    const read = (): string =>
      JSON.stringify({ lastSweepAt: 5, lastError: 'boom', extra: true });
    expect(readMarker(read, MARKER)).toEqual({ lastSweepAt: 5, lastError: 'boom' });
    expect(
      readMarker(() => JSON.stringify({ lastSweepAt: 'soon', lastError: 7 }), MARKER),
    ).toEqual({});
  });

  it('readMarker treats missing, unparseable, and non-object content as never swept', () => {
    expect(readMarker(() => undefined, MARKER)).toEqual({});
    expect(readMarker(() => 'not json', MARKER)).toEqual({});
    expect(readMarker(() => '5', MARKER)).toEqual({});
    expect(readMarker(() => 'null', MARKER)).toEqual({});
  });

  it('shouldSweep: never swept or ≥24h ago → yes; recent → no; future → yes', () => {
    const day = 24 * 60 * 60 * 1000;
    expect(shouldSweep({}, NOW)).toBe(true);
    expect(shouldSweep({ lastSweepAt: NOW - day }, NOW)).toBe(true);
    expect(shouldSweep({ lastSweepAt: NOW - day + 1 }, NOW)).toBe(false);
    // Clock rollback: a marker from the future counts as stale.
    expect(shouldSweep({ lastSweepAt: NOW + 1 }, NOW)).toBe(true);
  });
});

describe('pure argv builders + parsers', () => {
  it('sweepPsArgs is label-scoped with id/created/status format', () => {
    expect(sweepPsArgs('couetil-com')).toEqual([
      'ps',
      '-a',
      '--filter',
      'label=agentic-coding.project=couetil-com',
      '--format',
      '{{.ID}}\t{{.CreatedAt}}\t{{.Status}}',
    ]);
  });

  it('sweepImagesArgs lists one repo with tag/created format', () => {
    expect(sweepImagesArgs('agentic-coding-base')).toEqual([
      'images',
      'agentic-coding-base',
      '--format',
      '{{.Tag}}\t{{.CreatedAt}}',
    ]);
  });

  it('parseDockerDate handles docker CreatedAt and rejects garbage', () => {
    expect(parseDockerDate('2026-08-30 12:00:00 +0000 UTC')).toBe(NOW);
    expect(parseDockerDate('2026-08-30 12:00:00 +0000')).toBe(NOW);
    expect(parseDockerDate('yesterday')).toBeUndefined(); // too few tokens
    expect(parseDockerDate('not a date at all')).toBeUndefined(); // unparseable
  });

  it('expiredContainerIds keeps only old stopped/created rows', () => {
    const stdout = [
      `id-old-exited\t${OLD}\tExited (0) 8 weeks ago`,
      `id-old-created\t${OLD}\tCreated`,
      `id-old-dead\t${OLD}\tDead`,
      `id-old-up\t${OLD}\tUp 5 weeks`, // running — never a candidate
      `id-fresh\t${FRESH}\tExited (0) 1 day ago`, // too young
      `id-bad-date\tgarbage here now\tExited (0) 1 day ago`, // unparseable date
      `id-no-fields`, // malformed row
      '', // trailing newline
    ].join('\n');
    expect(expiredContainerIds(stdout, NOW, 30)).toEqual([
      'id-old-exited',
      'id-old-created',
      'id-old-dead',
    ]);
  });

  it('expiredImageRefs skips the current version, <none>, young and malformed rows', () => {
    const stdout = [
      `0.0.9\t${OLD}`,
      `${V}\t${OLD}`, // current version — never a candidate
      `<none>\t${OLD}`,
      `0.1.0\t${FRESH}`, // too young
      `0.0.8\tgarbage here now`, // unparseable date
      `justatag`, // malformed row
      '',
    ].join('\n');
    expect(expiredImageRefs(stdout, 'agentic-coding-base', V, NOW, 30)).toEqual([
      'agentic-coding-base:0.0.9',
    ]);
  });

  it('expiredImageRefs protects content-hashed tags of the current version (issue #8 P2)', () => {
    const stdout = [
      `${V}-a1b2c3d4e5f6\t${OLD}`, // current version, hashed overlay — protected
      `${V}-0123456789ab\t${OLD}`, // older hash, SAME version — still protected
      `0.0.9-a1b2c3d4e5f6\t${OLD}`, // superseded version, hashed — sweepable
      '',
    ].join('\n');
    expect(expiredImageRefs(stdout, 'agentic-couetil-com', V, NOW, 30)).toEqual([
      'agentic-couetil-com:0.0.9-a1b2c3d4e5f6',
    ]);
  });
});

describe('maybeSweep', () => {
  it('removes expired containers and image tags, reports once, writes the marker', async () => {
    const f = fakeExec((c) => {
      if (c.args[0] === 'ps') {
        return { stdout: `id1\t${OLD}\tExited (0) 8 weeks ago\nid2\t${OLD}\tCreated\n` };
      }
      if (c.args[0] === 'images' && c.args[1] === 'agentic-coding-base') {
        return { stdout: `0.0.9\t${OLD}\n${V}\t${OLD}\n` };
      }
      if (c.args[0] === 'images') {
        return { stdout: `0.0.7\t${OLD}\n` };
      }
      return {};
    });
    const { deps, writes, err } = makeDeps({ exec: f.exec });
    await maybeSweep(deps, CONFIG, V);

    expect(f.calls.map((c) => c.args[0])).toEqual([
      'ps',
      'rm',
      'images',
      'rmi',
      'images',
      'rmi',
    ]);
    expect(f.calls[1].args).toEqual(['rm', 'id1', 'id2']);
    expect(f.calls[3].args).toEqual(['rmi', 'agentic-coding-base:0.0.9']);
    expect(f.calls[5].args).toEqual(['rmi', 'agentic-couetil-com:0.0.7']);
    // Deletions are announced (the tool removed something)...
    expect(err()).toBe('retention: removed 2 container(s), 2 image tag(s) older than 30d\n');
    // ...and the marker records a clean sweep.
    expect(JSON.parse(writes[MARKER])).toEqual({ lastSweepAt: NOW });
  });

  it('is quiet and issues no rm/rmi when nothing is expired', async () => {
    const f = fakeExec((c) =>
      c.args[0] === 'ps'
        ? { stdout: `id\t${FRESH}\tExited (0) 1 day ago\n` }
        : { stdout: '' },
    );
    const { deps, writes, err } = makeDeps({ exec: f.exec });
    await maybeSweep(deps, CONFIG, V);
    expect(f.calls.map((c) => c.args[0])).toEqual(['ps', 'images', 'images']);
    expect(err()).toBe('');
    expect(JSON.parse(writes[MARKER])).toEqual({ lastSweepAt: NOW });
  });

  it('does nothing at all when retentionDays is 0', async () => {
    const { deps, calls, writes } = makeDeps();
    await maybeSweep(deps, { ...CONFIG, retentionDays: 0 } as AgentConfig, V);
    expect(calls).toEqual([]);
    expect(writes).toEqual({});
  });

  it('is throttled by a recent marker, and force overrides the throttle', async () => {
    const marker = JSON.stringify({ lastSweepAt: NOW - 1000 });
    const throttled = makeDeps({ readTextFile: () => marker });
    await maybeSweep(throttled.deps, CONFIG, V);
    expect(throttled.calls).toEqual([]);
    expect(throttled.writes).toEqual({});

    const forced = makeDeps({ readTextFile: () => marker });
    await maybeSweep(forced.deps, CONFIG, V, true);
    expect(forced.calls.map((c) => c.args[0])).toEqual(['ps', 'images', 'images']);
  });

  it('records rm/rmi failures (with stderr when present) in the marker, silently', async () => {
    const f = fakeExec((c) => {
      if (c.args[0] === 'ps') {
        return { stdout: `id1\t${OLD}\tExited (0) 8 weeks ago\n` };
      }
      if (c.args[0] === 'rm') {
        return { code: 1, stderr: 'container in use\n' };
      }
      if (c.args[0] === 'images' && c.args[1] === 'agentic-coding-base') {
        return { stdout: `0.0.9\t${OLD}\n` };
      }
      if (c.args[0] === 'rmi') {
        return { code: null, stderr: '' };
      }
      return { stdout: '' };
    });
    const { deps, writes, err } = makeDeps({ exec: f.exec });
    await maybeSweep(deps, CONFIG, V);
    expect(err()).toBe(''); // nothing removed, nothing said
    expect(JSON.parse(writes[MARKER])).toEqual({
      lastSweepAt: NOW,
      lastError: 'docker rm exited 1: container in use; docker rmi exited null',
    });
  });

  it('formats failures without stderr (rm) and with stderr (rmi) the other way round', async () => {
    const f = fakeExec((c) => {
      if (c.args[0] === 'ps') {
        return { stdout: `id1\t${OLD}\tExited (0) 8 weeks ago\n` };
      }
      if (c.args[0] === 'rm') {
        return { code: 2, stderr: '' };
      }
      if (c.args[0] === 'images' && c.args[1] === 'agentic-coding-base') {
        return { stdout: `0.0.9\t${OLD}\n` };
      }
      if (c.args[0] === 'rmi') {
        return { code: 1, stderr: 'image in use\n' };
      }
      return { stdout: '' };
    });
    const { deps, writes } = makeDeps({ exec: f.exec });
    await maybeSweep(deps, CONFIG, V);
    expect(JSON.parse(writes[MARKER]).lastError).toBe(
      'docker rm exited 2; docker rmi exited 1: image in use',
    );
  });

  it('swallows a docker spawn failure into the marker (launch is undisturbed)', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn docker ENOENT');
    };
    const { deps, writes, err } = makeDeps({ exec });
    await maybeSweep(deps, CONFIG, V);
    expect(err()).toBe('');
    expect(JSON.parse(writes[MARKER]).lastError).toContain(
      'docker is not available (spawn docker ENOENT)',
    );
  });

  it('stays silent when even the marker write fails', async () => {
    const { deps, err } = makeDeps({
      writeTextFile: () => {
        throw new Error('EROFS');
      },
    });
    await expect(maybeSweep(deps, CONFIG, V)).resolves.toBeUndefined();
    expect(err()).toBe('');
  });
});

describe('retentionStatusLines (doctor)', () => {
  it('renders the horizon and (never) before the first sweep', () => {
    const { deps } = makeDeps();
    expect(retentionStatusLines(deps, CONFIG)).toEqual([
      'retention   30d — stopped containers + superseded image tags, swept at launch (≤ once per 24h)',
      'last sweep  (never)',
    ]);
  });

  it('renders the last sweep time and a WARNING when the last sweep failed', () => {
    const { deps } = makeDeps({
      readTextFile: () =>
        JSON.stringify({ lastSweepAt: NOW, lastError: 'docker rm exited 1' }),
    });
    const lines = retentionStatusLines(deps, CONFIG);
    expect(lines[1]).toBe('last sweep  2026-08-30T12:00:00.000Z');
    expect(lines[2]).toBe('WARNING     last sweep failed: docker rm exited 1');
  });

  it('says disabled when retentionDays is 0', () => {
    const { deps } = makeDeps();
    expect(
      retentionStatusLines(deps, { ...CONFIG, retentionDays: 0 } as AgentConfig),
    ).toEqual(['retention   disabled (retentionDays: 0)']);
  });
});
