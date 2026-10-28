import type { Driver, HarnessSettings, TranscriptItem } from './types.ts';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { standardOutput } from './output.ts';
import { claudeShaped } from './tool-input.ts';
import { object, texts } from './transcript.ts';

const PI_DENIAL = 'halvard blocked: ';

// Pi runs the engine in process through adapters/pi.ts; the hook section serves the
// shared hook entry point. Pi never reviews: Ollama reviews through Pi instead.
export const pi: Driver = {
  name: 'pi',
  settingsDir: '.pi',
  hooks: {
    payload: claudeShaped,
    output: (event, result) => standardOutput(event, result),
  },
  agent: {
    command: ({ promptFile, extra }) => ['pi', '-p', ...extra, `@${promptFile}`],
    stdin: false,
    result: (stdout) => ({ text: stdout, costUsd: 0, error: null }),
  },
  install: {
    project: ({ root, installedRoot, json, stageJSON }) => {
      const pi = json<HarnessSettings>(resolve(root, '.pi/settings.json'));
      const source = relative(resolve(root, '.pi'), installedRoot).split('\\').join('/');
      if (pi.packages !== undefined && !Array.isArray(pi.packages)) {
        throw new Error('Pi packages must be an array');
      }
      pi.packages = [...(pi.packages ?? [])];
      if (!pi.packages.includes(source)) pi.packages.push(source);
      stageJSON('.pi/settings.json', pi);
    },
    personal: ({ home, source, json, stage }) => {
      const piPath = resolve(home, '.pi/agent/settings.json');
      const pi = json<HarnessSettings>(piPath);
      if (pi.packages !== undefined && !Array.isArray(pi.packages)) {
        throw new Error('Pi packages must be an array');
      }
      pi.packages = [...new Set([...(pi.packages ?? []), source])];
      stage(piPath, pi);
    },
    projectFiles: ['.pi/settings.json'],
    homeFiles: ['.pi/agent/settings.json'],
  },
  history: {
    root: () => resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent')),
    transcripts: ['sessions'],
    item: (record) => {
      const message = object(record.message);
      const item: TranscriptItem = { time: record.timestamp, prompts: [], results: [] };
      if (record.type === 'session') item.cwd = record.cwd;
      if (record.type !== 'message') return item;
      if (message.role === 'user') item.prompts.push(...texts(message.content));
      if (message.role === 'toolResult') {
        const output = texts(message.content);
        item.results.push({
          texts: output,
          denials:
            message.isError === true
              ? output
                  .filter((text) => text.startsWith(PI_DENIAL))
                  .map((text) => text.slice(PI_DENIAL.length))
              : [],
        });
      }
      return item;
    },
  },
};
