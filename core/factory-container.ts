import type { ContainerConfig } from './types.ts';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pluginRoot } from './runtime.ts';

export interface Box {
  // Host paths mounted at the same path, so Git and Halvard see one tree in both. A
  // source mounts another host path there, such as the target of a linked file.
  mounts: { path: string; readonly: boolean; source?: string }[];
  workdir: string;
  // Variables set inside the container, by name; their values come from the spawn env.
  env: string[];
}

// A container name Docker accepts and a person can read: repository, job and step, and a
// random suffix that a long name never cuts off.
export const boxName = (parts: string[]) =>
  `${['halvard', ...parts]
    .join('-')
    .replace(/[^A-Za-z0-9_.-]/g, '-')
    .slice(0, 100)}-${randomUUID().slice(0, 8)}`;

// --mount refuses a missing source, where -v would create it as a root-owned folder, and
// its comma-separated syntax cannot take a path with a comma.
function bind(source: string, target: string, readonly: boolean) {
  if ([source, target].some((path) => path.includes(','))) {
    throw new Error(`cannot mount a path with a comma: ${source}`);
  }
  return ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`];
}

// docker run for one step: no capabilities, no privilege gain, the host user, a bounded
// process count, the configured network, and only the listed mounts and variables.
export function boxCommand(config: ContainerConfig, name: string, box: Box, argv: string[]) {
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  return [
    'docker',
    'run',
    '--rm',
    '-i',
    '--init',
    '--name',
    name,
    '--user',
    user,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '1024',
    ...(config.memory ? ['--memory', config.memory] : []),
    ...(config.cpus ? ['--cpus', String(config.cpus)] : []),
    '--network',
    config.network,
    '-w',
    box.workdir,
    ...box.mounts.flatMap(({ path, readonly, source }) => bind(source ?? path, path, readonly)),
    ...config.mounts.flatMap(({ host, container, readonly }) => bind(host, container, readonly)),
    ...[...new Set([...box.env, ...config.env])].flatMap((key) => ['-e', key]),
    config.image,
    ...argv,
  ];
}

// Killing the docker client does not stop its container; this does.
export function removeBox(name: string) {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore', timeout: 60000 });
}

// The image's id, so a rebuild under the same tag is checked again.
export function imageId(image: string) {
  const run = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8',
    timeout: 60000,
  });
  return run.status === 0 ? run.stdout.trim() : null;
}

const versions = new Map<string, string>();

// The image must carry the same Halvard as the runner, because both read the same task
// files and state and compute the same tree fingerprint. The id it returns is what every
// step then runs, so a rebuild under the same tag cannot slip in an unchecked image.
// The version is read from the image by its id, so a rebuild between the two checks cannot
// pin an image whose version was never read.
export function checkImage(config: ContainerConfig): { problem: string | null; id: string | null } {
  const id = imageId(config.image);
  if (!id) {
    return { problem: `the image ${config.image} is not available; build or pull it first`, id };
  }
  const problem = imageMismatch(config, id);
  return { problem, id: problem ? null : id };
}

function imageMismatch(config: ContainerConfig, id: string) {
  const own = (
    JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8')) as { version: string }
  ).version;
  const key = `${id}\0${config.runner}`;
  if (!versions.has(key)) {
    const pkg = resolve(config.runner, '../../package.json');
    const run = spawnSync(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        id,
        'node',
        '-p',
        `require(${JSON.stringify(pkg)}).version`,
      ],
      { encoding: 'utf8', timeout: 120000 },
    );
    if (run.status !== 0) {
      return `the image ${config.image} cannot run its Halvard runner: ${(run.stderr || run.error?.message || '').trim().slice(-500)}`;
    }
    versions.set(key, run.stdout.trim());
  }
  const theirs = versions.get(key)!;
  return theirs === own ? null : `the image has Halvard ${theirs}, the runner ${own}`;
}
