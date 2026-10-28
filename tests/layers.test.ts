import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));

function files(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

// Static and dynamic relative imports, as repository paths.
function imports(file: string) {
  const text = readFileSync(join(root, file), 'utf8');
  return [...text.matchAll(/(?:from|import)\s*\(?\s*'(\.{1,2}\/[^']+)'/g)].map((match) =>
    relative(root, resolve(root, dirname(file), match[1]!)),
  );
}

const sources = ['core', 'adapters', 'bin', 'scripts'].flatMap(files);

// Each rule names the files it applies to and the imports they may not make.
const rules: { name: string; from: (file: string) => boolean; to: (target: string) => boolean }[] =
  [
    {
      // The hook dispatcher is an entry point; core modules take what they need from below it.
      name: 'only entry points import core/runtime.ts',
      from: (file) => file.startsWith('core/'),
      to: (target) => target === 'core/runtime.ts',
    },
    {
      name: 'core/shared imports only core/shared and core/types.ts',
      from: (file) => file.startsWith('core/shared/'),
      to: (target) => !target.startsWith('core/shared/') && target !== 'core/types.ts',
    },
    {
      // Each tool's driver knows only its own tool; the engine decides what to do with it.
      name: 'core/harnesses imports only core/harnesses, core/shared and core/types.ts',
      from: (file) => file.startsWith('core/harnesses/'),
      to: (target) => !/^core\/(harnesses|shared)\//.test(target) && target !== 'core/types.ts',
    },
    {
      name: 'core/guard does not import workflow, factory, install, setup or the CLI',
      from: (file) => file.startsWith('core/guard/'),
      to: (target) => /^core\/(workflow|factory|install|setup)\/|^core\/cli\.ts$/.test(target),
    },
    {
      name: 'only the factory and entry points import core/factory',
      from: (file) => file.startsWith('core/') && !file.startsWith('core/factory/'),
      to: (target) => target.startsWith('core/factory/'),
    },
  ];

test('imports point down the layers', () => {
  const violations = sources.flatMap((file) =>
    rules.flatMap((rule) =>
      rule.from(file)
        ? imports(file)
            .filter(rule.to)
            .map((target) => `${rule.name}: ${file} imports ${target}`)
        : [],
    ),
  );
  assert.deepEqual(violations, []);
});

test('the import scan sees relative imports', () => {
  assert.ok(imports('bin/hook.ts').includes('core/runtime.ts'));
  assert.ok(imports('bin/halvard.ts').includes('core/workflow/complete.ts'));
});
