import type { Project } from '../types.ts';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { CONFIG, gateSteps, inside, projectPath } from '../project.ts';

// Edits that could rewrite the agent's own permissions, Git internals or the checks
// behind the done proof still ask.
export function protectedPatterns(project: Project) {
  const { root, config } = project;
  const patterns = [
    CONFIG,
    `**/${CONFIG}`,
    '.git',
    '.git/**',
    '**/.git',
    '**/.git/**',
    '.pi/**',
    '.claude/**',
    '.codex/**',
    '.grok/**',
    '.cursor/**',
    '.agents/plugins/**',
    ...config.extensions,
  ];
  for (const command of [...(config.gate ? gateSteps(config.gate) : []), config.review]) {
    if (command && command[0]!.includes('/') && inside(root, resolve(root, command[0]!))) {
      patterns.push(projectPath(root, root, command[0]!));
    }
    // Scripts handed to an interpreter, as in ["node", "scripts/check.ts"].
    for (const arg of command?.slice(1) ?? []) {
      const file = resolve(root, arg);
      if (inside(root, file) && existsSync(file) && statSync(file).isFile()) {
        patterns.push(projectPath(root, root, arg));
      }
    }
  }
  return patterns;
}
