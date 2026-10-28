import type { ContainerConfig } from '../types.ts';

// Model credentials the harnesses read. Agents keep them while every other credential is
// scrubbed, and containers get them by default.
export const MODEL_KEY_NAMES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'XAI_API_KEY',
  'GROK_CODE_XAI_API_KEY',
  'CURSOR_API_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

// Names the runner sets itself or that would change how a container finds its tools.
// GitHub and SSH credentials stay with the runner even when a configuration lists them.
const RESERVED =
  /^(?:PATH|HOME|USER|TMPDIR|PWD|SHELL|HALVARD_\w*|GIT_\w*|DOCKER_\w*|NODE_OPTIONS|GH_\w*|GITHUB_\w*|SSH_\w*)$/;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const absolute = (path: string) =>
  path.startsWith('/') && !path.split('/').includes('..') && !/[:\0\r\n,]/.test(path);

export function containerConfig(input: unknown): ContainerConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('factory container must be an object');
  }
  const value = input as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!['image', 'network', 'env', 'mounts', 'runner', 'memory', 'cpus'].includes(key)) {
      throw new Error(`unknown factory container option: ${key}`);
    }
  }
  if (typeof value.image !== 'string' || !/^[a-z0-9][\w.\-/:@]*$/.test(value.image)) {
    throw new Error('factory container needs an image name');
  }
  const network = value.network ?? 'none';
  if (typeof network !== 'string' || !/^[A-Za-z0-9][\w.-]*$/.test(network) || network === 'host') {
    throw new Error('factory container network must name a Docker network other than host');
  }
  const env = value.env ?? MODEL_KEY_NAMES;
  if (
    !Array.isArray(env) ||
    env.some((name) => typeof name !== 'string' || !ENV_NAME.test(name) || RESERVED.test(name))
  ) {
    throw new Error(
      'factory container env must list variable names other than PATH, HOME, TMPDIR and HALVARD_, GIT_, DOCKER_, GH_, GITHUB_ or SSH_ ones',
    );
  }
  const mounts = (value.mounts ?? []) as unknown[];
  if (!Array.isArray(mounts)) throw new Error('factory container mounts must be a list');
  const runner = value.runner ?? '/opt/halvard/bin/halvard.ts';
  if (typeof runner !== 'string' || !absolute(runner)) {
    throw new Error('factory container runner must be an absolute path');
  }
  const memory = value.memory ?? null;
  if (memory !== null && (typeof memory !== 'string' || !/^[0-9]+[kmg]$/i.test(memory))) {
    throw new Error('factory container memory takes a size such as 4g');
  }
  const cpus = value.cpus ?? null;
  if (cpus !== null && (typeof cpus !== 'number' || !(cpus > 0) || cpus > 64)) {
    throw new Error('factory container cpus must be a positive number');
  }
  return {
    image: value.image,
    network,
    env: [...new Set(env as string[])],
    mounts: mounts.map((mount) => {
      const parts = typeof mount === 'string' ? mount.split(':') : [];
      if (
        parts.length < 2 ||
        parts.length > 3 ||
        !absolute(parts[0]!) ||
        !absolute(parts[1]!) ||
        (parts[2] !== undefined && parts[2] !== 'ro')
      ) {
        throw new Error('factory container mounts take /host/path:/container/path[:ro]');
      }
      return { host: parts[0]!, container: parts[1]!, readonly: parts[2] === 'ro' };
    }),
    runner,
    memory,
    cpus,
  };
}
