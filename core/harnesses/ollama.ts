import type { Driver } from './types.ts';

// Ollama only reviews. Through Pi it runs with tools, extensions, skills and context
// discovery off, and reads the evidence from the input file.
export const ollama: Driver = {
  name: 'ollama',
  review: {
    command: ({ settings, input }) => {
      if (!settings.model) throw new Error('unsupported or unconfigured reviewer');
      if (settings.transport === 'pi') {
        return [
          'pi',
          '-p',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--provider',
          'ollama',
          '--model',
          settings.model,
          '--thinking',
          'off',
          `@${input}`,
        ];
      }
      return ['ollama', 'run', settings.model];
    },
    stdin: (settings) => settings.transport !== 'pi',
    result: (stdout) => ({ text: stdout, models: [] }),
  },
};
