import type { Driver, Marketplace, TranscriptItem } from './types.ts';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';
import { object, texts } from './transcript.ts';

const CODEX_DENIAL = 'Command blocked by PreToolUse hook: ';
const CODEX_SCRIPT_ERROR = `Script error:\n${CODEX_DENIAL}`;

// Codex code-mode output nests command results inside JSON strings. A rejected entry
// holds the blocked command, which never ran, so its text is not command output.
function unwrap(text: string, depth = 0): string[] {
  if (depth > 3 || !/^\s*[[{]/.test(text)) return [text];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [text];
  }
  const leaves: string[] = [];
  const walk = (value: unknown) => {
    if (typeof value === 'string') {
      leaves.push(...unwrap(value, depth + 1));
    } else if (value && typeof value === 'object' && object(value).status !== 'rejected') {
      Object.values(value).forEach(walk);
    }
  };
  walk(parsed);
  return leaves;
}

// Codex rejects a call as a script error block or as a rejected entry at the top of its
// result envelope, alone or in a parallel-call array. Nothing below that is searched,
// since command output can hold any value. Codex appends the blocked command, which
// can carry anything the agent typed.
function codexDenials(text: string): string[] {
  const reason = (value: string) => value.slice(CODEX_DENIAL.length).split(/\.? Command: /)[0]!;
  if (text.startsWith(CODEX_SCRIPT_ERROR)) return [reason(text.slice('Script error:\n'.length))];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return (Array.isArray(parsed) ? parsed : [parsed])
    .map(object)
    .flatMap((entry) =>
      entry.status === 'rejected' &&
      typeof entry.reason === 'string' &&
      entry.reason.startsWith(CODEX_DENIAL)
        ? [reason(entry.reason)]
        : [],
    );
}

// The plugin table in config.toml that enables Halvard, in either quoting.
function pluginTable(toml: string, market: string) {
  const heading = `[plugins."halvard@${market}"]`;
  const headings = [heading, `[plugins.'halvard@${market}']`];
  const table = toml
    .split(/(?=^\s*\[)/m)
    .find((part) => headings.some((key) => part.trimStart().startsWith(key)));
  return {
    heading,
    table,
    enabled: Boolean(table && /^\s*enabled\s*=\s*true\s*(?:#.*)?$/m.test(table)),
  };
}

// Codex writes its final message to the file named by -o.
export const codex: Driver = {
  name: 'codex',
  settingsDir: '.codex',
  hooks: {
    payload: claudeShaped,
    // Codex does not enforce ask, so a request for approval denies.
    output: (event, result) => standardOutput(event, result, { askAsDeny: true }),
  },
  agent: {
    command: ({ stage, output, extra }) => [
      'codex',
      'exec',
      '--sandbox',
      stage === 'plan' ? 'read-only' : 'workspace-write',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      output,
      ...extra,
      '-',
    ],
    stdin: true,
    result: (_stdout, output) => ({ text: readFileSync(output, 'utf8'), costUsd: 0, error: null }),
  },
  review: {
    command: ({ settings, output }) => [
      'codex',
      'exec',
      '--ignore-user-config',
      '--ignore-rules',
      '--sandbox',
      'read-only',
      '--ephemeral',
      '--skip-git-repo-check',
      '--color',
      'never',
      '-o',
      output,
      ...(settings.model ? ['--model', settings.model] : []),
      '-',
    ],
    stdin: () => true,
    result: (_stdout, output) => ({ text: readFileSync(output, 'utf8'), models: [] }),
  },
  install: {
    project: ({ root, installedRoot, market, json, stage, stageJSON }) => {
      const codexPath = '.agents/plugins/marketplace.json';
      const codex = json<Marketplace>(resolve(root, codexPath), { name: market, plugins: [] });
      if (typeof codex.name !== 'string' || !Array.isArray(codex.plugins)) {
        throw new Error('invalid Codex marketplace');
      }
      const local = './' + relative(root, installedRoot).split('\\').join('/').replace(/\/$/, '');
      const entry = {
        name: 'halvard',
        source: { source: 'local', path: local },
        interface: {
          displayName: 'Halvard',
          shortDescription: 'Shared repository workflow guards',
        },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Productivity',
      };
      const found = codex.plugins.find((plugin) => plugin.name === entry.name);
      if (found && JSON.stringify(found.source) !== JSON.stringify(entry.source)) {
        throw new Error('Codex plugin name already belongs to another source');
      }
      if (!found) {
        codex.plugins.push(entry);
      } else {
        Object.assign(found, { policy: entry.policy, category: entry.category });
      }
      stageJSON(codexPath, codex);
      const configPath = resolve(root, '.codex/config.toml');
      const toml = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
      const { heading, table, enabled } = pluginTable(toml, codex.name);
      if (table && !enabled) {
        throw new Error(
          'Codex plugin table already exists without enabled = true; resolve it before installing',
        );
      }
      if (!table) stage('.codex/config.toml', toml + `\n${heading}\nenabled = true\n`);
    },
    personal: ({ home, destination, market, description, stage }) => {
      stage(resolve(destination, '.agents/plugins/marketplace.json'), {
        name: market,
        plugins: [
          {
            name: 'halvard',
            source: { source: 'local', path: './package' },
            interface: { displayName: 'Halvard', shortDescription: description },
            policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
            category: 'Productivity',
          },
        ],
      });
      const codexPath = resolve(home, '.codex/config.toml');
      const toml = existsSync(codexPath) ? readFileSync(codexPath, 'utf8') : '';
      const { heading, table, enabled } = pluginTable(toml, 'ghulando');
      if (table && !enabled) {
        throw new Error(
          'personal Codex plugin is disabled; resolve configuration before installing',
        );
      }
      if (!table) stage(codexPath, toml + `\n${heading}\nenabled = true\n`);
    },
    commands: ({ destination, reinstall }) => [
      ['codex', 'plugin', 'marketplace', 'add', destination],
      ...(reinstall ? [['codex', 'plugin', 'remove', 'halvard@ghulando']] : []),
      ['codex', 'plugin', 'add', 'halvard@ghulando'],
    ],
    workspace: (path) =>
      `Add ${JSON.stringify(path)} to writable_roots under [sandbox_workspace_write] in ~/.codex/config.toml`,
    projectFiles: ['.agents/plugins/marketplace.json', '.codex/config.toml'],
    homeFiles: ['.codex/config.toml'],
  },
  history: {
    root: () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex')),
    transcripts: ['sessions', 'archived_sessions'],
    item: (record) => {
      const payload = object(record.payload);
      const item: TranscriptItem = { time: record.timestamp, prompts: [], results: [] };
      if (['session_meta', 'turn_context'].includes(record.type as string)) item.cwd = payload.cwd;
      if (
        record.type === 'event_msg' &&
        payload.type === 'user_message' &&
        typeof payload.message === 'string'
      ) {
        item.prompts.push(payload.message);
      }
      if (
        record.type === 'response_item' &&
        ['function_call_output', 'custom_tool_call_output'].includes(payload.type as string)
      ) {
        const output = texts(payload.output);
        item.results.push({
          texts: output
            .filter((text) => !text.startsWith(CODEX_SCRIPT_ERROR))
            .flatMap((text) => unwrap(text)),
          denials: output.flatMap(codexDenials),
        });
      }
      return item;
    },
  },
};
