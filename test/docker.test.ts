import { describe, expect, it } from 'vitest';
import {
  DockerUnavailableError,
  baseStatusLine,
  baseTag,
  buildArgs,
  clean,
  cleanListArgs,
  cleanRmArgs,
  dockerExec,
  ensureBaseImage,
  ensureOverlayImage,
  hasOverlay,
  imagePresent,
  inspectArgs,
  overlayBuildArgs,
  overlayContextDir,
  overlayDockerfilePath,
  overlayStatusLine,
  overlayTag,
  packageDockerDir,
} from '../src/docker.js';
import type {
  AgentConfig,
  DockerDeps,
  ExecFn,
  ExecOptions,
  ExecResult,
} from '../src/types.js';

const CONFIG = { project: 'couetil-com' } as AgentConfig;
const V = '1.2.3';

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

function makeDeps(over: Partial<DockerDeps> = {}): {
  deps: DockerDeps;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  const deps: DockerDeps = {
    exec: fakeExec().exec,
    fileExists: () => false,
    cwd: '/proj',
    packageDockerDir: '/pkg/docker',
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    ...over,
  };
  return { deps, out, err };
}

describe('pure argv builders', () => {
  it('tags', () => {
    expect(baseTag('1.2.3')).toBe('agentic-coding-base:1.2.3');
    expect(overlayTag('couetil-com', '1.2.3')).toBe('agentic-couetil-com:1.2.3');
  });

  it('inspectArgs', () => {
    expect(inspectArgs('t')).toEqual(['image', 'inspect', 't']);
  });

  it('buildArgs, plain and fresh', () => {
    expect(buildArgs('/pkg/docker', 'base:1')).toEqual([
      'build',
      '-t',
      'base:1',
      '/pkg/docker',
    ]);
    expect(buildArgs('/pkg/docker', 'base:1', true)).toEqual([
      'build',
      '--pull',
      '--no-cache',
      '-t',
      'base:1',
      '/pkg/docker',
    ]);
  });

  it('overlayBuildArgs passes BASE build-arg and context, plain and fresh', () => {
    expect(overlayBuildArgs('/proj/.agent', 'ov:1', 'base:1')).toEqual([
      'build',
      '--build-arg',
      'BASE=base:1',
      '-t',
      'ov:1',
      '/proj/.agent',
    ]);
    expect(overlayBuildArgs('/proj/.agent', 'ov:1', 'base:1', true)).toEqual([
      'build',
      '--pull',
      '--no-cache',
      '--build-arg',
      'BASE=base:1',
      '-t',
      'ov:1',
      '/proj/.agent',
    ]);
  });

  it('cleanListArgs is scoped to the project label AND status=exited', () => {
    expect(cleanListArgs('couetil-com')).toEqual([
      'ps',
      '-aq',
      '--filter',
      'label=agentic-coding.project=couetil-com',
      '--filter',
      'status=exited',
    ]);
  });

  it('cleanRmArgs prefixes rm', () => {
    expect(cleanRmArgs(['a', 'b'])).toEqual(['rm', 'a', 'b']);
  });

  it('overlay paths', () => {
    expect(overlayDockerfilePath('/proj')).toBe('/proj/.agent/Dockerfile');
    expect(overlayContextDir('/proj')).toBe('/proj/.agent');
  });

  it('packageDockerDir resolves the package docker/ directory', () => {
    expect(packageDockerDir().replace(/\\/g, '/')).toMatch(/\/docker$/);
  });
});

describe('hasOverlay', () => {
  it('reflects presence of .agent/Dockerfile', () => {
    const yes = makeDeps({
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    const no = makeDeps();
    expect(hasOverlay(yes.deps)).toBe(true);
    expect(hasOverlay(no.deps)).toBe(false);
  });
});

describe('dockerExec + DockerUnavailableError', () => {
  it('passes command/args/options through to the exec seam', async () => {
    const f = fakeExec(() => ({ code: 0, stdout: 'ok' }));
    const result = await dockerExec(f.exec, ['ps'], { stdio: 'pipe' });
    expect(result.stdout).toBe('ok');
    expect(f.calls[0]).toEqual({
      command: 'docker',
      args: ['ps'],
      options: { stdio: 'pipe' },
    });
  });

  it('converts a spawn rejection into an actionable DockerUnavailableError', async () => {
    const exec: ExecFn = async () => {
      throw new Error('spawn docker ENOENT');
    };
    const promise = dockerExec(exec, ['ps']);
    await expect(promise).rejects.toBeInstanceOf(DockerUnavailableError);
    await expect(promise).rejects.toThrow(
      /docker is not available \(spawn docker ENOENT\).*install Docker/,
    );
  });
});

describe('imagePresent', () => {
  it('is true on exit 0 and false otherwise', async () => {
    const present = makeDeps({ exec: fakeExec(() => ({ code: 0 })).exec });
    const absent = makeDeps({ exec: fakeExec(() => ({ code: 1 })).exec });
    expect(await imagePresent(present.deps, 't')).toBe(true);
    expect(await imagePresent(absent.deps, 't')).toBe(false);
  });
});

describe('ensureBaseImage', () => {
  it('present → cached message, no build, exit 0', async () => {
    const f = fakeExec(() => ({ code: 0 }));
    const d = makeDeps({ exec: f.exec });
    expect(await ensureBaseImage(d.deps, V)).toBe(0);
    expect(f.calls).toHaveLength(1); // inspect only
    expect(d.err.join('')).toContain('present (cached)');
  });

  it('absent → first-build message then build with the package context', async () => {
    const f = fakeExec((c) => ({ code: c.args[1] === 'inspect' ? 1 : 0 }));
    const d = makeDeps({ exec: f.exec });
    expect(await ensureBaseImage(d.deps, V)).toBe(0);
    expect(d.err.join('')).toContain('for the first time');
    expect(f.calls[1].args).toEqual(
      buildArgs('/pkg/docker', baseTag(V)),
    );
    expect(f.calls[1].options?.stdio).toBe('inherit');
  });

  it('propagates a non-zero build code (and null → 1)', async () => {
    const f = fakeExec((c) => ({ code: c.args[1] === 'inspect' ? 1 : null }));
    const d = makeDeps({ exec: f.exec });
    expect(await ensureBaseImage(d.deps, V)).toBe(1);
  });
});

describe('ensureOverlayImage', () => {
  it('no overlay → base tag, no build', async () => {
    const f = fakeExec();
    const d = makeDeps({ exec: f.exec });
    expect(await ensureOverlayImage(d.deps, CONFIG, V)).toEqual({
      code: 0,
      image: baseTag(V),
    });
    expect(f.calls).toHaveLength(0);
  });

  it('overlay present → builds it and returns the overlay tag', async () => {
    const f = fakeExec();
    const d = makeDeps({
      exec: f.exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    const result = await ensureOverlayImage(d.deps, CONFIG, V);
    expect(result.image).toBe(overlayTag('couetil-com', V));
    expect(f.calls[0].args).toEqual(
      overlayBuildArgs('/proj/.agent', overlayTag('couetil-com', V), baseTag(V)),
    );
  });

  it('propagates a null overlay build code as 1', async () => {
    const f = fakeExec(() => ({ code: null }));
    const d = makeDeps({
      exec: f.exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect((await ensureOverlayImage(d.deps, CONFIG, V)).code).toBe(1);
  });
});

describe('clean', () => {
  it('rm the project-scoped exited ids, then rebuild base + overlay fresh', async () => {
    const f = fakeExec((c) =>
      c.args[0] === 'ps' ? { stdout: 'id1\nid2\n' } : { code: 0 },
    );
    const d = makeDeps({
      exec: f.exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect(await clean(d.deps, CONFIG, V)).toBe(0);
    // 1) label-scoped list
    expect(f.calls[0].args).toEqual(cleanListArgs('couetil-com'));
    // 2) rm the listed ids
    expect(f.calls[1].args).toEqual(cleanRmArgs(['id1', 'id2']));
    // 3) fresh base build
    expect(f.calls[2].args).toEqual(buildArgs('/pkg/docker', baseTag(V), true));
    // 4) fresh overlay build
    expect(f.calls[3].args).toEqual(
      overlayBuildArgs('/proj/.agent', overlayTag('couetil-com', V), baseTag(V), true),
    );
  });

  it('reports when there are no exited containers and rebuilds base only', async () => {
    const f = fakeExec((c) => (c.args[0] === 'ps' ? { stdout: '\n' } : { code: 0 }));
    const d = makeDeps({ exec: f.exec });
    expect(await clean(d.deps, CONFIG, V)).toBe(0);
    expect(d.out.join('')).toContain('no exited containers for couetil-com');
    // no rm call; base build follows the list
    expect(f.calls[1].args).toEqual(buildArgs('/pkg/docker', baseTag(V), true));
    expect(f.calls).toHaveLength(2);
  });

  it('bails with the base build code before touching the overlay', async () => {
    const f = fakeExec((c) => {
      if (c.args[0] === 'ps') return { stdout: '' };
      if (c.args[0] === 'build') return { code: 7 };
      return { code: 0 };
    });
    const d = makeDeps({
      exec: f.exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect(await clean(d.deps, CONFIG, V)).toBe(7);
    // list + failed base build only — no overlay build
    expect(f.calls).toHaveLength(2);
  });

  it('coerces a null overlay build code to 1', async () => {
    let build = 0;
    const f = fakeExec((c) => {
      if (c.args[0] === 'ps') return { stdout: '' };
      if (c.args[0] === 'build') {
        build += 1;
        return { code: build === 1 ? 0 : null };
      }
      return { code: 0 };
    });
    const d = makeDeps({
      exec: f.exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect(await clean(d.deps, CONFIG, V)).toBe(1);
  });

  it('coerces a null base build code to 1', async () => {
    const f = fakeExec((c) =>
      c.args[0] === 'ps' ? { stdout: '' } : { code: null },
    );
    const d = makeDeps({ exec: f.exec });
    expect(await clean(d.deps, CONFIG, V)).toBe(1);
  });
});

describe('doctor image status lines', () => {
  it('baseStatusLine reflects presence', async () => {
    const present = makeDeps({ exec: fakeExec(() => ({ code: 0 })).exec });
    const absent = makeDeps({ exec: fakeExec(() => ({ code: 1 })).exec });
    expect(await baseStatusLine(present.deps, V)).toContain('present');
    expect(await baseStatusLine(absent.deps, V)).toContain('missing');
  });

  it('overlayStatusLine describes absent, present, and not-yet-built overlays', async () => {
    const none = makeDeps();
    expect(await overlayStatusLine(none.deps, CONFIG, V)).toContain(
      '.agent/Dockerfile absent',
    );

    const built = makeDeps({
      exec: fakeExec(() => ({ code: 0 })).exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect(await overlayStatusLine(built.deps, CONFIG, V)).toContain('present');

    const unbuilt = makeDeps({
      exec: fakeExec(() => ({ code: 1 })).exec,
      fileExists: (p) => p === '/proj/.agent/Dockerfile',
    });
    expect(await overlayStatusLine(unbuilt.deps, CONFIG, V)).toContain(
      'built on next launch',
    );
  });
});
