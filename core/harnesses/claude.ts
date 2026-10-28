import type { Driver, HarnessSettings, TranscriptItem } from './types.ts';
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { pluginRoot } from '../shared/plugin.ts';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';
import { object, texts } from './transcript.ts';

// Claude reports a hook denial as an error tool result in this shape.
const CLAUDE_DENIAL = /^PreToolUse:[\w.-]+ hook error: ([\s\S]*)$/;

interface Envelope {
  result?: unknown;
  is_error?: unknown;
  total_cost_usd?: unknown;
  modelUsage?: Record<string, unknown>;
}

export const claude: Driver = {
  name: 'claude',
  settingsDir: '.claude',
  hooks: {
    payload: claudeShaped,
    output: (event, result) => standardOutput(event, result),
  },
  agent: {
    command: ({ stage, workspace, budgetUsd, auth, extra }) => [
      'claude',
      '-p',
      '--output-format',
      'json',
      '--permission-prompts',
      'none',
      '--max-budget-usd',
      budgetUsd.toFixed(2),
      // Bare mode loads only Halvard and reads only an API key; a subscription token
      // needs the normal startup, which also loads the user's own Claude settings.
      ...(auth === 'api' ? ['--bare', '--plugin-dir', pluginRoot] : []),
      ...(stage === 'plan'
        ? ['--permission-mode', 'dontAsk', '--allowedTools', 'Read,Grep,Glob,Bash']
        : ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep']),
      // --add-dir and --allowedTools take lists and would swallow a trailing prompt, so
      // Claude reads it on stdin.
      '--add-dir',
      workspace,
      ...extra,
    ],
    stdin: true,
    result: (stdout) => {
      const envelope = JSON.parse(stdout) as Envelope;
      const costUsd = typeof envelope.total_cost_usd === 'number' ? envelope.total_cost_usd : 0;
      if (envelope.is_error || typeof envelope.result !== 'string') {
        return { text: '', costUsd, error: `Claude reported an error: ${String(envelope.result)}` };
      }
      return { text: envelope.result, costUsd, error: null };
    },
  },
  review: {
    command: ({ settings }) => [
      'claude',
      '-p',
      '--output-format',
      'json',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--setting-sources',
      'user',
      '--settings',
      '{"disableAllHooks":true}',
      '--no-session-persistence',
      ...(settings.model ? ['--model', settings.model] : []),
      'Review the supplied evidence and return only the requested JSON verdict.',
    ],
    stdin: () => true,
    result: (stdout) => {
      const envelope = JSON.parse(stdout) as Envelope;
      if (envelope.is_error || typeof envelope.result !== 'string') {
        throw new Error('Claude did not produce a successful review');
      }
      return { text: envelope.result, models: Object.keys(envelope.modelUsage ?? {}) };
    },
  },
  install: {
    project: ({ root, installedRoot, market, json, stage, stageJSON, link }) => {
      const claude = json<HarnessSettings>(resolve(root, '.claude/settings.json'));
      claude.extraKnownMarketplaces ??= {};
      const existing = claude.extraKnownMarketplaces[market];
      const location = './' + relative(root, installedRoot).replace(/\/$/, '');
      const directory = { source: { source: 'directory', path: location } };
      if (existing && JSON.stringify(existing) !== JSON.stringify(directory)) {
        throw new Error('Claude marketplace name already belongs to another source');
      }
      claude.extraKnownMarketplaces[market] = directory;
      claude.enabledPlugins ??= {};
      claude.enabledPlugins[`halvard@${market}`] = true;
      stageJSON('.claude/settings.json', claude);
      if (!existsSync(resolve(root, 'CLAUDE.md')) && existsSync(resolve(root, 'AGENTS.md'))) {
        stage('CLAUDE.md', '@AGENTS.md\n');
      }
      const linkPath = resolve(root, '.claude/skills');
      const skillsPath = resolve(root, '.agents/skills');
      const stat = lstatSync(linkPath, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink() && !existsSync(linkPath)) {
        throw new Error('.claude/skills is a dangling symlink; resolve it before installing');
      }
      if (existsSync(skillsPath) && !stat) link('.claude/skills', '../.agents/skills');
      if (stat && !stat.isDirectory() && !stat.isSymbolicLink()) {
        throw new Error('.claude/skills is not a directory');
      }
    },
    personal: ({ home, source, market, json, stage }) => {
      const claudePath = resolve(home, '.claude/settings.json');
      const claude = json<HarnessSettings>(claudePath);
      claude.extraKnownMarketplaces ??= {};
      const marketplace = { source: { source: 'directory', path: source } };
      const existing = claude.extraKnownMarketplaces[market];
      if (
        existing &&
        JSON.stringify(existing) !== JSON.stringify(marketplace) &&
        !(
          existing.source?.source === 'directory' &&
          resolve(existing.source.path) === resolve(pluginRoot)
        )
      ) {
        throw new Error('user Claude marketplace already belongs to another source');
      }
      claude.extraKnownMarketplaces[market] = marketplace;
      claude.enabledPlugins ??= {};
      claude.enabledPlugins[`halvard@${market}`] = true;
      stage(claudePath, claude);
    },
    commands: ({ source }) => [
      ['claude', 'plugin', 'marketplace', 'add', source],
      ['claude', 'plugin', 'install', 'halvard@ghulando'],
    ],
    workspace: (path) =>
      `Add ${JSON.stringify(path)} to permissions.additionalDirectories in ~/.claude/settings.json`,
    projectFiles: ['CLAUDE.md', '.claude/settings.json'],
    homeFiles: ['.claude/settings.json'],
  },
  history: {
    root: () => resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')),
    transcripts: ['projects'],
    item: (record) => {
      const item: TranscriptItem = {
        cwd: record.cwd,
        time: record.timestamp,
        prompts: [],
        results: [],
      };
      if (record.type !== 'user' || record.isMeta) return item;
      const content = object(record.message).content;
      if (typeof content === 'string') item.prompts.push(content);
      if (!Array.isArray(content)) return item;
      for (const block of content.map(object)) {
        if (block.type === 'tool_result') {
          const output = texts(block.content);
          item.results.push({
            texts: output,
            denials:
              block.is_error === true
                ? output.flatMap((text) => text.match(CLAUDE_DENIAL)?.slice(1) ?? [])
                : [],
          });
        } else if (block.type === 'text' && typeof block.text === 'string') {
          item.prompts.push(block.text);
        }
      }
      return item;
    },
  },
};
