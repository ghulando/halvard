import type { TestContext } from 'node:test';
import './environment.ts';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  applyBootstrap,
  bootstrapReport,
  parseRecord,
  stacksDirectory,
} from '../core/setup/bootstrap.ts';
import { flowConfig } from '../core/flow-config.ts';
import { git, loadProject } from '../core/project.ts';
import { proposeSetup } from '../core/setup/setup.ts';
import { doctor } from '../core/setup/doctor.ts';
import { handle, pluginRoot, quote } from '../core/runtime.ts';

const commit = (root: string) =>
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);

const record = (
  kind = 'backend',
  concerns = '- architecture (always-on): every change\n- storage (on-demand): data access',
) =>
  `# Example\n\nKind: ${kind}\n\n## Summary\n\nAn example stack.\n\nSecond paragraph.\n\n## Architecture\n\nLayers.\n\n## Libraries\n\nOne.\n\n## Data\n\nNone.\n\n## Messaging\n\nNone.\n\n## Errors\n\nResults.\n\n## Naming\n\nPlain.\n\n## Testing\n\nUnit.\n\n## Gate\n\n- build: tool build --strict\n- test: tool test\n\n## Open choices\n\n- queue: yes, no (default no)\n\n## Concerns\n\n${concerns}\n`;

function stacksRepo(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-stacks-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: dir });
  mkdirSync(join(dir, 'alpha'));
  writeFileSync(join(dir, 'alpha/stack.md'), record());
  mkdirSync(join(dir, 'broken'));
  writeFileSync(join(dir, 'broken/stack.md'), '# Broken\n\n## Summary\n\nNo kind.\n');
  mkdirSync(join(dir, 'notes'));
  git(dir, ['add', '.']);
  commit(dir);
  return dir;
}

function fixture(t: TestContext, stacks: string | null, extra: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-bootstrap-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=feature/bootstrap'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({ version: 1, workflow: { requireReview: false, stacks }, ...extra }),
  );
  writeFileSync(join(root, 'go.mod'), 'module example.invalid/app\n');
  return root;
}

const skill = (name: string, description = 'Use when touching storage.') =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nRules for ${name}.\n`;

function plan(t: TestContext, root: string, overrides: Record<string, unknown> = {}) {
  const report = bootstrapReport(root);
  const file = join(tmpdir(), `bootstrap-plan-${process.pid}-${Math.random()}.json`);
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      root: report.root,
      tree: report.tree,
      stack: {
        name: 'alpha',
        commit: report.stacks?.commit ?? null,
        modified: false,
        gate: [
          ['tool', 'build'],
          ['tool', 'test'],
        ],
      },
      agents: '## Stack\n\nAlpha decisions.',
      skills: [
        { name: 'architecture', content: skill('architecture'), required: true },
        { name: 'storage', content: skill('storage'), required: false },
      ],
      ...overrides,
    }),
  );
  return file;
}

test('stack records parse kind, summary, concerns and gate, and format problems name the file', (t) => {
  const parsed = parseRecord('alpha', record());
  assert.equal(parsed.kind, 'backend');
  assert.equal(parsed.summary, 'An example stack.');
  assert.deepEqual(parsed.concerns, [
    { name: 'architecture', required: true, when: 'every change' },
    { name: 'storage', required: false, when: 'data access' },
  ]);
  assert.deepEqual(parsed.gate, [
    ['tool', 'build', '--strict'],
    ['tool', 'test'],
  ]);
  assert.deepEqual(parsed.openChoices, [{ name: 'queue', options: 'yes, no', default: 'no' }]);
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parseRecord('bad', record('mobile', '- Storage (sometimes): data')).problems, [
    'needs exactly one Kind: backend or Kind: frontend line',
    'invalid Concerns line: - Storage (sometimes): data',
  ]);
  // Structured sections reject prose, so a line missing its bullet cannot drop a decision.
  const adversarial = record(
    'backend',
    '- storage (on-demand): data\nweb (on-demand): pages\n- storage (always-on): again',
  )
    .replace('- test: tool test', 'test: tool test')
    .replace(
      '- queue: yes, no (default no)',
      '- queue name: yes, no (default no)\n- cache: yes, no',
    )
    .replace('## Naming\n\nPlain.', '## Naming\n\nPlain.\n\n## Naming\n\nAgain.');
  assert.deepEqual(parseRecord('adversarial', adversarial).problems, [
    'repeated heading: Naming',
    'invalid Concerns line: web (on-demand): pages',
    'repeated concern: storage',
    'invalid Gate line: test: tool test',
    'invalid Open choices line: - queue name: yes, no (default no)',
    'invalid Open choices line: - cache: yes, no',
  ]);
  const none = parseRecord(
    'none',
    record('backend', 'None.').replace(
      /## Gate\n\n[\s\S]*?\n\n## Open/,
      '## Gate\n\nNone.\n\n## Open',
    ),
  );
  assert.deepEqual(none.gate, []);
  assert.deepEqual(none.problems, ['invalid Concerns line: None.']);

  const stacks = stacksRepo(t);
  const root = fixture(t, stacks);
  const report = bootstrapReport(root);
  assert.deepEqual(
    report.stacks!.records.map((r) => r.name),
    ['alpha'],
  );
  assert.equal(report.stacks!.invalid.length, 1);
  assert.equal(report.stacks!.invalid[0]!.file, join(stacks, 'broken/stack.md'));
  assert.ok(report.stacks!.invalid[0]!.problems.includes('missing or empty heading: Concerns'));
  assert.equal(report.stacks!.commit, git(stacks, ['rev-parse', 'HEAD']).trim());
  assert.equal(report.stacks!.records[0]!.modified, false);
  assert.deepEqual(report.detected, [{ path: '.', stacks: ['go'] }]);
  assert.equal(report.agentsSection, null);
  assert.equal(report.branch, 'feature/bootstrap');
  assert.equal(report.protectedBranch, false);
  assert.equal(report.stamp, null);
  assert.deepEqual(report.skills, []);

  // A stacks clone's own configuration must not run code during this read.
  const marker = join(stacks, '..', `fsmonitor-${process.pid}-${Math.random()}`);
  const hook = join(stacks, '.git/fsmonitor-hook');
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(stacks, ['config', 'core.fsmonitor', hook]);
  mkdirSync(join(stacks, 'alpha/skills'));
  writeFileSync(join(stacks, 'alpha/skills/storage.md'), 'Template.\n');
  const untracked = bootstrapReport(root).stacks!.records[0]!;
  assert.equal(untracked.modified, true);
  rmSync(join(stacks, 'alpha/skills'), { recursive: true });
  writeFileSync(join(stacks, 'alpha/stack.md'), record().replace('Second paragraph.', 'Edited.'));
  assert.equal(bootstrapReport(root).stacks!.records[0]!.modified, true);
  assert.equal(existsSync(marker), false);
  assert.equal(bootstrapReport(fixture(t, null)).stacks, null);
});

test('bootstrap-apply writes the section, skills, required skills and stamp, then refuses a stale plan', (t) => {
  const stacks = stacksRepo(t);
  const root = fixture(t, stacks, { requiredSkills: ['existing'] });
  mkdirSync(join(root, '.agents/skills/existing'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/existing/SKILL.md'), skill('existing'));
  assert.deepEqual(bootstrapReport(root).skills, ['existing']);
  const before = 'Project rules.\nNo trailing newline';
  writeFileSync(join(root, 'AGENTS.md'), before);
  const file = plan(t, root);
  const result = applyBootstrap(root, file);
  assert.deepEqual(result.skills, [
    '.agents/skills/architecture/SKILL.md',
    '.agents/skills/storage/SKILL.md',
  ]);
  assert.equal(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    `${before}\n\n<!-- halvard stack -->\n## Stack\n\nAlpha decisions.\n<!-- /halvard stack -->\n`,
  );
  assert.equal(
    readFileSync(join(root, '.agents/skills/storage/SKILL.md'), 'utf8'),
    skill('storage'),
  );
  const { config } = loadProject(root);
  assert.deepEqual(config.requiredSkills, ['existing', 'architecture']);
  assert.equal(config.stack!.name, 'alpha');
  assert.equal(config.stack!.commit, git(stacks, ['rev-parse', 'HEAD']).trim());
  assert.equal(config.workflow.stacks, stacks);
  assert.throws(() => applyBootstrap(root, file), /stale/);

  // A second bootstrap replaces only the delimited section.
  writeFileSync(
    join(root, 'AGENTS.md'),
    readFileSync(join(root, 'AGENTS.md'), 'utf8') + '\nAfter the section.\n',
  );
  assert.throws(() => applyBootstrap(root, plan(t, root)), /architecture already exists/);
  applyBootstrap(
    root,
    plan(t, root, {
      agents: 'Replaced.',
      skills: [{ name: 'architecture', content: skill('architecture', 'New.'), required: true }],
      overwrite: ['architecture'],
    }),
  );
  assert.equal(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    `${before}\n\n<!-- halvard stack -->\nReplaced.\n<!-- /halvard stack -->\n\nAfter the section.\n`,
  );
  assert.deepEqual(loadProject(root).config.requiredSkills, ['existing', 'architecture']);
  assert.equal(
    bootstrapReport(root).agentsSection,
    '<!-- halvard stack -->\nReplaced.\n<!-- /halvard stack -->',
  );
});

test('bootstrap-apply creates AGENTS.md and refuses invalid plans before writing anything', (t) => {
  const root = fixture(t, null);
  const refusals: [Record<string, unknown>, RegExp][] = [
    [{ agents: 'x <!-- halvard stack --> y' }, /without section markers/],
    [{ agents: '  ' }, /nonempty Markdown/],
    [{ skills: [] }, /nonempty array/],
    [{ skills: [{ name: 'storage', content: skill('other'), required: false }] }, /own name/],
    [{ skills: [{ name: 'storage', content: 'no frontmatter', required: false }] }, /own name/],
    [
      { skills: [{ name: '../escape', content: skill('../escape'), required: false }] },
      /invalid plan skill/,
    ],
    [
      {
        skills: [
          { name: 'storage', content: skill('storage'), required: false },
          { name: 'storage', content: skill('storage'), required: false },
        ],
      },
      /twice/,
    ],
    [{ overwrite: ['missing'] }, /overwrite/],
    [
      { stack: { name: 'alpha', commit: 'not-a-sha', modified: false, gate: [] } },
      /invalid stack entry/,
    ],
    [
      { stack: { name: 'alpha', commit: null, modified: false, gate: [[]] } },
      /stack gate step is empty/,
    ],
    [{ root: '/elsewhere' }, /another repo/],
  ];
  for (const [overrides, pattern] of refusals) {
    assert.throws(() => applyBootstrap(root, plan(t, root, overrides)), pattern, String(pattern));
  }
  assert.deepEqual(
    execFileSync('git', ['status', '--porcelain', '-uall'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort(),
    ['?? .halvard.json', '?? go.mod'],
  );

  writeFileSync(join(root, 'AGENTS.md'), '<!-- /halvard stack -->\n<!-- halvard stack -->\n');
  assert.throws(() => bootstrapReport(root), /unmatched or repeated/);
  rmSync(join(root, 'AGENTS.md'));
  applyBootstrap(root, plan(t, root));
  assert.equal(
    readFileSync(join(root, 'AGENTS.md'), 'utf8'),
    '<!-- halvard stack -->\n## Stack\n\nAlpha decisions.\n<!-- /halvard stack -->\n',
  );
});

test('a skills-only plan leaves AGENTS.md alone, Claude gets an AGENTS.md bridge, and hard links are refused', (t) => {
  const root = fixture(t, null);
  writeFileSync(join(root, 'AGENTS.md'), 'Hand-written rules.\n');
  const result = applyBootstrap(root, plan(t, root, { agents: null }));
  assert.equal(result.agents, null);
  assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), 'Hand-written rules.\n');
  assert.equal(readFileSync(join(root, 'CLAUDE.md'), 'utf8'), '@AGENTS.md\n');
  assert.equal(result.claude, 'CLAUDE.md created with @AGENTS.md');
  assert.ok(existsSync(join(root, '.agents/skills/storage/SKILL.md')));

  const bare = fixture(t, null);
  applyBootstrap(bare, plan(t, bare, { agents: null }));
  assert.equal(existsSync(join(bare, 'AGENTS.md')), false);
  assert.equal(existsSync(join(bare, 'CLAUDE.md')), false);

  const own = fixture(t, null);
  writeFileSync(join(own, 'CLAUDE.md'), 'Own instructions.\n');
  const owned = applyBootstrap(own, plan(t, own));
  assert.equal(readFileSync(join(own, 'CLAUDE.md'), 'utf8'), 'Own instructions.\n');
  assert.match(owned.claude!, /does not import AGENTS\.md/);

  const linked = fixture(t, null);
  const outside = join(linked, '..', `outside-${process.pid}-${Math.random()}.json`);
  t.after(() => rmSync(outside, { force: true }));
  linkSync(join(linked, '.halvard.json'), outside);
  const before = readFileSync(outside, 'utf8');
  assert.throws(() => applyBootstrap(linked, plan(t, linked)), /multiple hard links/);
  assert.equal(readFileSync(outside, 'utf8'), before);
  assert.equal(existsSync(join(linked, '.agents')), false);
  rmSync(outside);

  mkdirSync(join(linked, '.agents/skills/storage'), { recursive: true });
  writeFileSync(join(linked, '.agents/skills/storage/SKILL.md'), skill('storage'));
  linkSync(join(linked, '.agents/skills/storage/SKILL.md'), outside);
  assert.throws(
    () => applyBootstrap(linked, plan(t, linked, { overwrite: ['storage'] })),
    /multiple hard links/,
  );
  assert.equal(readFileSync(outside, 'utf8'), skill('storage'));
});

test('records need one title, one kind and known headings, and apply preflights every target', (t) => {
  assert.deepEqual(
    parseRecord(
      'twice',
      record()
        .replace('Kind: backend', 'Kind: backend\nKind: frontend')
        .replace('# Example\n', '') + '\n## Extras\n\nMore.\n',
    ).problems,
    [
      'unknown heading: Extras',
      'needs exactly one level-one title',
      'needs exactly one Kind: backend or Kind: frontend line',
    ],
  );

  const root = fixture(t, null);
  mkdirSync(join(root, 'src'));
  // Content the report can read, so the refusal under test is apply's own.
  writeFileSync(join(root, 'src/app.txt'), skill('storage'));
  mkdirSync(join(root, '.agents/skills/storage'), { recursive: true });
  symlinkSync(join(root, 'src/app.txt'), join(root, '.agents/skills/storage/SKILL.md'));
  assert.throws(
    () => applyBootstrap(root, plan(t, root, { overwrite: ['storage'] })),
    /not a plain directory and file/,
  );
  assert.equal(readFileSync(join(root, 'src/app.txt'), 'utf8'), skill('storage'));
  assert.equal(existsSync(join(root, '.agents/skills/architecture')), false);

  rmSync(join(root, '.agents/skills/storage'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/storage'), 'a file where a directory belongs\n');
  assert.throws(
    () => applyBootstrap(root, plan(t, root, { overwrite: ['storage'] })),
    /not a plain directory and file/,
  );
  assert.equal(existsSync(join(root, '.agents/skills/architecture')), false);
  assert.equal(existsSync(join(root, 'AGENTS.md')), false);

  const linked = fixture(t, null);
  mkdirSync(join(linked, 'src'));
  symlinkSync(join(linked, 'src'), join(linked, '.agents'));
  assert.throws(() => applyBootstrap(linked, plan(t, linked)), /resolves through a symlink/);
  assert.deepEqual(readdirSync(join(linked, 'src')), []);
});

test('the repository stack records are valid and stay out of the package', () => {
  const directory = new URL('../stacks/', import.meta.url);
  // AGENTS.md is not packaged, so its absence means this suite runs from the packed install.
  if (!existsSync(new URL('../AGENTS.md', import.meta.url))) {
    assert.equal(existsSync(directory), false);
    return;
  }
  const names = readdirSync(directory).sort();
  assert.deepEqual(names, ['dotnet', 'go', 'python', 'vue']);
  for (const name of names) {
    const parsed = parseRecord(name, readFileSync(new URL(`${name}/stack.md`, directory), 'utf8'));
    assert.deepEqual(parsed.problems, [], name);
    assert.equal(parsed.kind, name === 'vue' ? 'frontend' : 'backend', name);
    assert.ok(
      parsed.concerns.some((concern) => concern.required),
      name,
    );
  }
});

test('an invalid Kind, symlinked instruction files and demoted skills are handled', (t) => {
  assert.ok(
    parseRecord(
      'mixed',
      record().replace('Kind: backend', 'Kind: backend\nKind: mobile'),
    ).problems.includes('needs exactly one Kind: backend or Kind: frontend line'),
  );
  assert.ok(
    parseRecord('mobile', record('mobile')).problems.includes(
      'needs exactly one Kind: backend or Kind: frontend line',
    ),
  );

  const root = fixture(t, null);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src/app.md'), 'application\n');
  symlinkSync(join(root, 'src/app.md'), join(root, 'AGENTS.md'));
  assert.throws(() => applyBootstrap(root, plan(t, root)), /AGENTS\.md is a symlink/);
  assert.equal(readFileSync(join(root, 'src/app.md'), 'utf8'), 'application\n');
  assert.equal(existsSync(join(root, '.agents')), false);

  const demote = fixture(t, null);
  applyBootstrap(demote, plan(t, demote));
  assert.deepEqual(loadProject(demote).config.requiredSkills, ['architecture']);
  applyBootstrap(
    demote,
    plan(t, demote, {
      skills: [{ name: 'architecture', content: skill('architecture'), required: false }],
      overwrite: ['architecture'],
    }),
  );
  assert.deepEqual(loadProject(demote).config.requiredSkills, []);
});

test('records in a subdirectory of a checkout compare against that subdirectory', (t) => {
  const checkout = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-checkout-')));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: checkout });
  mkdirSync(join(checkout, 'stacks/alpha'), { recursive: true });
  writeFileSync(join(checkout, 'stacks/alpha/stack.md'), record());
  git(checkout, ['add', '.']);
  commit(checkout);
  const root = fixture(t, join(checkout, 'stacks'));
  assert.equal(bootstrapReport(root).stacks!.records[0]!.modified, false);
  writeFileSync(join(checkout, 'stacks/alpha/stack.md'), record().replace('Layers.', 'Edited.'));
  assert.equal(bootstrapReport(root).stacks!.records[0]!.modified, true);
});

test('stacks setting validates paths, doctor reports a missing directory and setup proposes the stack gate', (t) => {
  assert.throws(() => flowConfig({ stacks: 'relative/path' }), /absolute or ~\//);
  assert.throws(() => flowConfig({ stacks: '/a\nb' }), /absolute or ~\//);
  assert.throws(() => flowConfig({ stacks: 3 }), /absolute or ~\//);
  assert.equal(stacksDirectory(flowConfig({ stacks: '~/stacks' })), resolve(homedir(), 'stacks'));
  assert.equal(stacksDirectory(flowConfig({})), null);

  const missing = fixture(t, '/nonexistent/workflow-stacks');
  assert.ok(
    doctor(missing).issues.some((issue) =>
      issue.includes('Stacks directory /nonexistent/workflow-stacks'),
    ),
  );
  assert.throws(() => bootstrapReport(missing), /stacks directory not found/);

  const gate = [
    ['tool', 'build'],
    ['tool', 'test'],
  ];
  const stamped = fixture(t, null, {
    stack: { name: 'alpha', commit: null, modified: true, gate },
  });
  assert.deepEqual(proposeSetup(stamped).config.gate, gate);
  const chosen = fixture(t, null, {
    gate: ['make', 'check'],
    stack: { name: 'alpha', commit: null, modified: true, gate },
  });
  assert.deepEqual(proposeSetup(chosen).config.gate, ['make', 'check']);
  assert.equal(proposeSetup(fixture(t, null)).config.gate, null);
});

test('bootstrap reads on protected branches and bootstrap-apply does not', async (t) => {
  const root = fixture(t, null);
  execFileSync('git', ['checkout', '-q', '-b', 'main'], { cwd: root });
  const runner = `node ${quote(resolve(pluginRoot, 'bin/halvard.ts'))}`;
  const decision = async (command: string) =>
    (
      await handle('claude', {
        cwd: root,
        session_id: 'bootstrap',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command },
      })
    ).decision;
  assert.equal(bootstrapReport(root).protectedBranch, true);
  assert.equal(await decision(`${runner} bootstrap .`), undefined);
  assert.equal(await decision(`${runner} bootstrap-apply . /tmp/plan.json`), 'deny');
});

test('the bootstrap engine and skill name no framework or library', () => {
  const sources = ['../core/setup/bootstrap.ts', '../skills/halvard-bootstrap/SKILL.md'].map(
    (path) => readFileSync(new URL(path, import.meta.url), 'utf8').toLowerCase(),
  );
  const names = [
    'dotnet',
    '.net',
    'csharp',
    'python',
    'golang',
    'typescript',
    'javascript',
    'vue',
    'react',
    'angular',
    'nest',
    'fastapi',
    'django',
    'flask',
    'fastendpoints',
    'mediatr',
    'ef core',
    'entity framework',
    'xunit',
    'nunit',
    'nsubstitute',
    'moq',
    'pytest',
    'sqlalchemy',
    'pydantic',
    'celery',
    'chi',
    'gin',
    'pgx',
    'testify',
    'vitest',
    'jest',
    'pinia',
    'vite',
    'npm',
    'pnpm',
    'nuget',
    'pip',
    'uv ',
    'cargo',
    'maven',
    'gradle',
    'spring',
  ];
  for (const source of sources) {
    for (const name of names) {
      assert.equal(
        new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(source),
        false,
        name,
      );
    }
  }
});
