#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { claudeAgent } from './agents/claude.js';
import { codexAgent } from './agents/codex.js';
import {
  cacheVolumeNames,
  errorMessage,
  imageName,
  labels,
  loadConfig,
  randomNameSuffix,
} from './config.js';
import {
  baseStatusLine,
  clean,
  diskContainerLines,
  diskContainersArgs,
  diskImageLines,
  diskImagesArgs,
  diskVolumeLines,
  diskVolumesArgs,
  dockerExec,
  overlayStatusLine,
  packageDockerDir,
} from './docker.js';
import {
  environmentLines,
  launchRequirements,
  loadEnvFiles,
  mergeEnv,
} from './env.js';
import { realExec } from './exec.js';
import { runLaunch } from './launch.js';
import { realPortDeps } from './ports.js';
import { maybeSweep, retentionStatusLines } from './retention.js';
import { packageTemplatesDir, runInit } from './scaffold.js';
import type { AgentAuthDeps, AgentConfig, CliDeps } from './types.js';

const KNOWN = ['claude', 'codex', 'shell', 'clean', 'init', 'doctor'] as const;
type Command = (typeof KNOWN)[number];

const USAGE = `agent — isolated-agent-container tooling (@couetilc/agentic-coding)

Usage: agent <command> [args...]

Commands:
  claude [args...]   launch Claude Code in the project's agent container
  codex  [args...]   launch Codex in the project's agent container
  shell  [cmd...]    open a shell in the container instead of an agent
  clean              remove this project's exited containers + rebuild images
  init               scaffold/upgrade .agent/ in the current repo
  doctor             print resolved config, image/disk status, and env preflight

Options:
  -h, --help         show this help
`;

function isKnown(command: string): command is Command {
  return (KNOWN as readonly string[]).includes(command);
}

export async function run(deps: CliDeps): Promise<number> {
  const command = deps.argv[0];

  if (command === '--help' || command === '-h') {
    deps.out(USAGE);
    return 0;
  }
  if (command === undefined) {
    deps.err(`error: missing command\n\n${USAGE}`);
    return 1;
  }
  if (!isKnown(command)) {
    deps.err(`error: unknown command '${command}'\n\n${USAGE}`);
    return 1;
  }

  // No docker-in-docker: every command refuses inside an agent container
  // (PLAN.md §2). The shims carry the same guard so they no-op politely.
  if (deps.env.IS_SANDBOX === '1') {
    deps.err(
      `error: 'agent ${command}' cannot run inside an agent container (IS_SANDBOX=1)\n`,
    );
    return 1;
  }

  if (command === 'doctor') {
    return doctor(deps);
  }
  if (command === 'init') {
    return runInit(deps);
  }
  if (command === 'clean') {
    return runClean(deps);
  }
  // claude | codex | shell
  return runLaunch(deps);
}

// `agent clean` — resolve config for the project label, then remove this
// project's exited containers and rebuild images from scratch. A docker spawn
// failure (docker not installed) surfaces as one actionable line, not an
// unhandled-rejection stack trace.
async function runClean(deps: CliDeps): Promise<number> {
  let config: AgentConfig;
  try {
    config = await loadConfig(deps);
  } catch (err) {
    deps.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }
  try {
    const code = await clean(deps, config, deps.version);
    // Unthrottled retention sweep AFTER the rm + rebuild, when superseded
    // image tags are least likely to still be pinned by kept containers.
    await maybeSweep(deps, config, deps.version, true);
    return code;
  } catch (err) {
    deps.err(`error: ${errorMessage(err)}\n`);
    return 1;
  }
}

interface Section {
  title: string;
  lines: string[];
}

function renderSections(sections: Section[]): string {
  return `${sections
    .map((s) => `${s.title}\n${s.lines.map((l) => `  ${l}`).join('\n')}`)
    .join('\n\n')}\n`;
}

function configSection(config: AgentConfig, version: string): Section {
  const ports = Object.entries(config.ports).map(
    ([name, port]) => `${name} → ${port} (as $DEV_HOST_${name.toUpperCase()})`,
  );
  return {
    title: 'Config',
    lines: [
      `project        ${config.project}`,
      `repo           ${config.repo}`,
      `defaultBranch  ${config.defaultBranch}`,
      `image          ${imageName(config.project)}`,
      `labels         ${labels(config.project, version).join(', ')}`,
      `claude         ${config.agents.claude.model} (effort: ${config.agents.claude.effort})`,
      `codex          ${config.agents.codex.model} (effort: ${config.agents.codex.effort})`,
      `ports          ${ports.length > 0 ? ports.join('; ') : '(none)'}`,
      `caches         ${cacheVolumeNames(config).join(', ')}`,
      `requiredEnv    ${config.requiredEnv.length > 0 ? config.requiredEnv.join(', ') : '(none)'}`,
    ],
  };
}

// doctor assembles named sections so phase 2 slots real image-status and
// env-preflight checks in place of the placeholders without a rewrite.
async function doctor(deps: CliDeps): Promise<number> {
  const sections: Section[] = [];
  let code = 0;

  let config: AgentConfig | undefined;
  try {
    config = await loadConfig(deps);
  } catch (err) {
    sections.push({ title: 'Config', lines: [`error: ${errorMessage(err)}`] });
    code = 1;
  }

  if (config !== undefined) {
    sections.push(configSection(config, deps.version));
  }
  sections.push(await imagesSection(deps, config));
  sections.push(await diskSection(deps, config));
  sections.push(environmentSection(deps, config));
  sections.push({
    title: 'Timing',
    lines: [
      'AGENT_TIMING=1 agent <claude|codex|shell> — per-stage launch timings on stderr (host launcher + container entrypoint), issue #8 baselines',
    ],
  });

  deps.out(renderSections(sections));
  return code;
}

// Real image status: the versioned base tag, and the overlay when a project has
// a .agent/Dockerfile (PLAN.md §5). doctor is exactly what a fresh-machine user
// runs, so a missing docker binary renders as a status line here — the other
// sections still print.
async function imagesSection(
  deps: CliDeps,
  config: AgentConfig | undefined,
): Promise<Section> {
  try {
    const lines = [await baseStatusLine(deps, deps.version)];
    lines.push(
      config !== undefined
        ? await overlayStatusLine(deps, config, deps.version)
        : 'overlay  (config not loaded)',
    );
    return { title: 'Images', lines };
  } catch (err) {
    return { title: 'Images', lines: [errorMessage(err)] };
  }
}

// What this project's artifacts cost on disk (issue #5): kept containers,
// image tags, and cache volume sizes — plus the retention/sweep status and the
// one reclaim this tool deliberately does NOT run itself (build cache is
// daemon-global and unlabeled, so pruning it would touch other projects).
async function diskSection(
  deps: CliDeps,
  config: AgentConfig | undefined,
): Promise<Section> {
  if (config === undefined) {
    return { title: 'Disk', lines: ['(config not loaded)'] };
  }
  const lines: string[] = [];
  try {
    const ps = await dockerExec(deps.exec, diskContainersArgs(config.project), {
      stdio: 'pipe',
    });
    lines.push(...diskContainerLines(ps.stdout));
    for (const repo of ['agentic-coding-base', imageName(config.project)]) {
      const images = await dockerExec(deps.exec, diskImagesArgs(repo), {
        stdio: 'pipe',
      });
      lines.push(...diskImageLines(images.stdout));
    }
    const df = await dockerExec(deps.exec, diskVolumesArgs(), {
      stdio: 'pipe',
    });
    if (df.code === 0) {
      lines.push(...diskVolumeLines(df.stdout, cacheVolumeNames(config)));
    } else {
      lines.push('volumes     (sizes unavailable — run `docker system df -v`)');
    }
  } catch (err) {
    lines.push(errorMessage(err));
  }
  lines.push(...retentionStatusLines(deps, config));
  lines.push(
    'build cache is daemon-global — reclaim with `docker builder prune` (not run by this tool)',
  );
  return { title: 'Disk', lines };
}

function agentAuthDeps(
  deps: CliDeps,
  merged: Record<string, string>,
): AgentAuthDeps {
  return {
    merged,
    env: deps.env,
    home: deps.home,
    readTextFile: deps.readTextFile,
  };
}

// Real env preflight (§7): the two env files, the merged key names (values
// redacted), the GH_TOKEN/requiredEnv verdicts, and each agent's credential
// presence — never a value.
function environmentSection(
  deps: CliDeps,
  config: AgentConfig | undefined,
): Section {
  const files = loadEnvFiles(deps);
  const merged = mergeEnv(files);
  const lines = environmentLines(
    files,
    merged,
    launchRequirements(config !== undefined ? config.requiredEnv : []),
  );
  const authDeps = agentAuthDeps(deps, merged);
  lines.push(
    `claude cred    ${
      claudeAgent.resolveAuth(authDeps).ok
        ? 'present'
        : 'MISSING (CLAUDE_CODE_OAUTH_TOKEN → ~/.config/agentic-coding/env)'
    }`,
  );
  lines.push(
    `codex cred     ${
      codexAgent.resolveAuth(authDeps).ok
        ? 'present'
        : 'MISSING (codex login on host, or OPENAI_API_KEY)'
    }`,
  );
  return { title: 'Environment', lines };
}

// Is this module the process entrypoint (bin run) rather than an import (a
// test)? Node resolves symlinks when computing the entry module's
// import.meta.url but process.argv[1] keeps the invoked path — and npm bin
// stubs ARE symlinks (node_modules/.bin/agentic-coding → dist/cli.js) — so
// argv[1] must be realpath'd before the URL comparison or npx/global/shim
// invocations never match and the CLI silently does nothing.
export function isEntry(metaUrl: string, argv1: string | undefined): boolean {
  if (argv1 === undefined) {
    return false;
  }
  let resolved = argv1;
  try {
    resolved = realpathSync(argv1);
  } catch {
    // argv1 doesn't exist on disk — compare it unresolved as the fallback.
  }
  return metaUrl === pathToFileURL(resolved).href;
}

// The real-world wiring of every seam. Kept in a function (not inlined at the
// entrypoint) so a test can call it and cover each closure without the CLI
// running on import. Exit is expressed via the returned code (see below), so no
// process.exit closure is needed here.
export function makeRealDeps(): CliDeps {
  const version = (
    JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
  ).version;
  return {
    argv: process.argv.slice(2),
    env: process.env,
    cwd: process.cwd(),
    version,
    home: homedir(),
    // `true` when attached to a terminal; `process.stdout.isTTY` is `true` or
    // undefined, so coerce. Drives whether `docker run` gets `-t` (launch.ts).
    isTTY: process.stdout.isTTY === true,
    now: () => new Date(),
    nameSuffix: randomNameSuffix,
    packageDockerDir: packageDockerDir(),
    packageTemplatesDir: packageTemplatesDir(),
    port: realPortDeps,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    fileExists: (path) => existsSync(path),
    readTextFile: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        // Missing (or unreadable) file → treated as absent by callers.
        return undefined;
      }
    },
    writeTextFile: (path, content) => {
      writeFileSync(path, content);
    },
    makeExecutable: (path) => {
      chmodSync(path, 0o755);
    },
    mkdirp: (path) => {
      mkdirSync(path, { recursive: true });
    },
    importModule: (spec) => import(spec),
    exec: realExec,
  };
}

// Bootstrap. `run` returns the exit code and we set process.exitCode (rather
// than force-exiting) so buffered output flushes. AGENTIC_FORCE_MAIN lets a test
// exercise this branch in-process; otherwise it fires only when this file is the
// actual entrypoint, never on a plain import.
if (
  process.env.AGENTIC_FORCE_MAIN === '1' ||
  isEntry(import.meta.url, process.argv[1])
) {
  process.exitCode = await run(makeRealDeps());
}
