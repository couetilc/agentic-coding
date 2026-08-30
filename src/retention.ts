import { dirname, join } from 'node:path';
import { errorMessage, imageName } from './config.js';
import { dockerExec } from './docker.js';
import type { AgentConfig, RetentionDeps } from './types.js';

// Age-based retention of the tool's OWN artifacts (issue #5): this project's
// stopped containers and superseded base/overlay image tags older than
// `retentionDays` are removed. The sweep runs best-effort at every launch,
// throttled to once per 24h by a marker file, and unthrottled from `agent
// clean`. It is an optimization, so failures are silent here: the marker
// records the last error and `agent doctor`'s Disk section surfaces it.
//
// Concurrent sweeps from parallel launches are safe without a lock: the
// deletions are idempotent (the loser gets "No such container/image", which is
// swallowed), docker refuses to rm a running container or rmi an image any
// container still references, and only tags ≠ the current version are
// candidates — never the image a concurrent launch uses.

const DAY_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = DAY_MS;

export interface SweepMarker {
  lastSweepAt?: number;
  lastError?: string;
}

export function sweepMarkerPath(home: string, project: string): string {
  return join(home, '.config', 'agentic-coding', `sweep-${project}.json`);
}

// Missing, unparseable, or wrongly-typed marker content all read as "never
// swept" — the worst outcome of a corrupt marker is one extra sweep.
export function readMarker(
  read: (path: string) => string | undefined,
  path: string,
): SweepMarker {
  const text = read(path);
  if (text === undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return {};
  }
  const m = parsed as Record<string, unknown>;
  return {
    ...(typeof m.lastSweepAt === 'number' ? { lastSweepAt: m.lastSweepAt } : {}),
    ...(typeof m.lastError === 'string' ? { lastError: m.lastError } : {}),
  };
}

// At most once per 24h. A marker from the future (clock rollback) counts as
// stale rather than suppressing sweeps until the clock catches up.
export function shouldSweep(marker: SweepMarker, nowMs: number): boolean {
  if (marker.lastSweepAt === undefined) {
    return true;
  }
  const age = nowMs - marker.lastSweepAt;
  return age < 0 || age >= SWEEP_INTERVAL_MS;
}

// --- Pure argv builders / parsers (golden-tested) ---------------------------

export function sweepPsArgs(project: string): string[] {
  return [
    'ps',
    '-a',
    '--filter',
    `label=agentic-coding.project=${project}`,
    '--format',
    '{{.ID}}\t{{.CreatedAt}}\t{{.Status}}',
  ];
}

export function sweepImagesArgs(repo: string): string[] {
  return ['images', repo, '--format', '{{.Tag}}\t{{.CreatedAt}}'];
}

// Docker's CreatedAt is `2026-08-29 12:34:56 -0400 EDT`; the trailing zone
// NAME is not Date-parseable but the first three tokens are.
export function parseDockerDate(value: string): number | undefined {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length < 3) {
    return undefined;
  }
  const ms = Date.parse(tokens.slice(0, 3).join(' '));
  return Number.isNaN(ms) ? undefined : ms;
}

// Only never-started (Created) and stopped (Exited/Dead) containers past the
// horizon; a running container is never a candidate (docker would refuse the
// rm anyway). Unparseable rows are skipped — never delete on a guess.
export function expiredContainerIds(
  stdout: string,
  nowMs: number,
  retentionDays: number,
): string[] {
  const ids: string[] = [];
  for (const line of stdout.split('\n')) {
    const [id, createdAt, status] = line.split('\t');
    if (id === undefined || id === '' || createdAt === undefined || status === undefined) {
      continue;
    }
    if (!/^(Created|Exited|Dead)/.test(status)) {
      continue;
    }
    const created = parseDockerDate(createdAt);
    if (created === undefined) {
      continue;
    }
    if (nowMs - created >= retentionDays * DAY_MS) {
      ids.push(id);
    }
  }
  return ids;
}

// Superseded tags only: the current version's tag is never a candidate, so a
// concurrent launch can't lose the image it is about to run.
export function expiredImageRefs(
  stdout: string,
  repo: string,
  currentVersion: string,
  nowMs: number,
  retentionDays: number,
): string[] {
  const refs: string[] = [];
  for (const line of stdout.split('\n')) {
    const [tag, createdAt] = line.split('\t');
    if (tag === undefined || tag === '' || createdAt === undefined) {
      continue;
    }
    if (tag === currentVersion || tag === '<none>') {
      continue;
    }
    const created = parseDockerDate(createdAt);
    if (created === undefined) {
      continue;
    }
    if (nowMs - created >= retentionDays * DAY_MS) {
      refs.push(`${repo}:${tag}`);
    }
  }
  return refs;
}

// --- Orchestration ----------------------------------------------------------

async function sweep(
  deps: RetentionDeps,
  config: AgentConfig,
  version: string,
  nowMs: number,
): Promise<string | undefined> {
  const errors: string[] = [];
  let removedContainers = 0;
  let removedImages = 0;

  const ps = await dockerExec(deps.exec, sweepPsArgs(config.project), {
    stdio: 'pipe',
  });
  const ids = expiredContainerIds(ps.stdout, nowMs, config.retentionDays);
  if (ids.length > 0) {
    const rm = await dockerExec(deps.exec, ['rm', ...ids], { stdio: 'pipe' });
    if (rm.code === 0) {
      removedContainers = ids.length;
    } else {
      errors.push(
        `docker rm exited ${rm.code}${rm.stderr !== '' ? `: ${rm.stderr.trim()}` : ''}`,
      );
    }
  }

  for (const repo of ['agentic-coding-base', imageName(config.project)]) {
    const images = await dockerExec(deps.exec, sweepImagesArgs(repo), {
      stdio: 'pipe',
    });
    const refs = expiredImageRefs(
      images.stdout,
      repo,
      version,
      nowMs,
      config.retentionDays,
    );
    if (refs.length === 0) {
      continue;
    }
    const rmi = await dockerExec(deps.exec, ['rmi', ...refs], { stdio: 'pipe' });
    if (rmi.code === 0) {
      removedImages += refs.length;
    } else {
      errors.push(
        `docker rmi exited ${rmi.code}${rmi.stderr !== '' ? `: ${rmi.stderr.trim()}` : ''}`,
      );
    }
  }

  // The one thing worth saying out loud: the tool deleted something.
  if (removedContainers + removedImages > 0) {
    deps.err(
      `retention: removed ${removedContainers} container(s), ${removedImages} image tag(s) older than ${config.retentionDays}d\n`,
    );
  }
  return errors.length > 0 ? errors.join('; ') : undefined;
}

// The launch/clean entry point. Never throws, never prints on failure — a
// failed sweep must not disturb a launch. `force` (agent clean) skips the
// throttle.
export async function maybeSweep(
  deps: RetentionDeps,
  config: AgentConfig,
  version: string,
  force = false,
): Promise<void> {
  if (config.retentionDays === 0) {
    return;
  }
  const path = sweepMarkerPath(deps.home, config.project);
  const nowMs = deps.now().getTime();
  if (!force && !shouldSweep(readMarker(deps.readTextFile, path), nowMs)) {
    return;
  }
  let lastError: string | undefined;
  try {
    lastError = await sweep(deps, config, version, nowMs);
  } catch (cause) {
    lastError = errorMessage(cause);
  }
  try {
    deps.mkdirp(dirname(path));
    deps.writeTextFile(
      path,
      `${JSON.stringify({
        lastSweepAt: nowMs,
        ...(lastError === undefined ? {} : { lastError }),
      })}\n`,
    );
  } catch {
    // The marker is only a throttle + doctor breadcrumb; losing it costs at
    // worst one extra sweep tomorrow.
  }
}

// --- doctor Disk lines --------------------------------------------------

export function retentionStatusLines(
  deps: Pick<RetentionDeps, 'home' | 'readTextFile'>,
  config: AgentConfig,
): string[] {
  if (config.retentionDays === 0) {
    return ['retention   disabled (retentionDays: 0)'];
  }
  const marker = readMarker(
    deps.readTextFile,
    sweepMarkerPath(deps.home, config.project),
  );
  const lines = [
    `retention   ${config.retentionDays}d — stopped containers + superseded image tags, swept at launch (≤ once per 24h)`,
    `last sweep  ${
      marker.lastSweepAt === undefined
        ? '(never)'
        : new Date(marker.lastSweepAt).toISOString()
    }`,
  ];
  if (marker.lastError !== undefined) {
    lines.push(`WARNING     last sweep failed: ${marker.lastError}`);
  }
  return lines;
}
