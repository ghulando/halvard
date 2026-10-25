import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A gh CLI stand-in over a JSON state file: issues with labels, label events, collaborator
// permissions, comments and pull requests. Only the calls the factory makes are known.
const ghStub = `#!${process.execPath}
const fs = require('fs');
const file = process.env.STUB_GH_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const save = () => fs.writeFileSync(file, JSON.stringify(state));
const issue = (n) => state.issues.find((i) => i.number === Number(n));
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };
const [a, b, c] = args;
if (a === 'issue' && b === 'list') {
  const label = args[args.indexOf('--label') + 1];
  process.stdout.write(JSON.stringify(state.issues.filter((i) => i.state === 'OPEN' && i.labels.includes(label))
    .map((i) => ({ number: i.number, labels: i.labels.map((name) => ({ name })) }))));
} else if (a === 'issue' && b === 'view') {
  const i = issue(c) || fail('no issue ' + c);
  process.stdout.write(JSON.stringify({ ...i, labels: i.labels.map((name) => ({ name })) }));
} else if (a === 'issue' && b === 'comment') {
  state.comments.push({ issue: Number(c), body: fs.readFileSync(args[args.indexOf('--body-file') + 1], 'utf8') });
  save();
} else if (a === 'issue' && b === 'edit') {
  const i = issue(c) || fail('no issue ' + c);
  args.forEach((arg, k) => {
    if (arg === '--add-label' && !i.labels.includes(args[k + 1])) i.labels.push(args[k + 1]);
    if (arg === '--remove-label') i.labels = i.labels.filter((name) => name !== args[k + 1]);
  });
  save();
} else if (a === 'api' && args.some((arg) => /\\/events$/.test(arg))) {
  const n = args.find((arg) => /\\/events$/.test(arg)).match(/issues\\/(\\d+)\\/events/)[1];
  const label = args[args.indexOf('--jq') + 1].match(/label\\.name == "([^"]+)"/)[1];
  process.stdout.write((state.events[n] || []).filter((e) => e.label === label).map((e) => e.actor + '\\t' + e.at + '\\n').join(''));
} else if (a === 'api' && args.some((arg) => /\\/permission$/.test(arg))) {
  const login = args.find((arg) => /\\/permission$/.test(arg)).match(/collaborators\\/([^/]+)\\/permission/)[1];
  process.stdout.write((state.permissions[login] || 'none') + '\\n');
} else if (a === 'pr' && b === 'create') {
  const url = 'https://github.com/example/repo/pull/' + (state.prs.length + 1);
  state.prs.push({ args, url });
  save();
  process.stdout.write(url + '\\n');
} else {
  fail('unknown gh call: ' + args.join(' '));
}
`;

export interface GithubState {
  issues: {
    number: number;
    title: string;
    body: string;
    url: string;
    state: string;
    labels: string[];
  }[];
  events: Record<string, { label: string; actor: string; at: string }[]>;
  permissions: Record<string, string>;
  comments: { issue: number; body: string }[];
  prs: { args: string[]; url: string }[];
}

// Read and change the gh stub's state. label() adds a label and its event, as GitHub would.
function github(file: string) {
  const read = () => JSON.parse(readFileSync(file, 'utf8')) as GithubState;
  const write = (state: GithubState) => writeFileSync(file, JSON.stringify(state));
  return {
    read,
    write,
    issue(number: number, title: string, body = 'Make source.txt say implemented.') {
      const state = read();
      state.issues.push({
        number,
        title,
        body,
        url: `https://github.com/example/repo/issues/${number}`,
        state: 'OPEN',
        labels: [],
      });
      write(state);
    },
    label(
      number: number,
      label: string,
      actor: string,
      at = new Date(Date.now() + 1000).toISOString(),
    ) {
      const state = read();
      const issue = state.issues.find((entry) => entry.number === number)!;
      if (!issue.labels.includes(label)) issue.labels.push(label);
      (state.events[String(number)] ??= []).push({ label, actor, at });
      write(state);
    },
    permission(login: string, level: string) {
      const state = read();
      state.permissions[login] = level;
      write(state);
    },
  };
}

export const commit = (root: string, message = 'fixture') =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-qm',
      message,
    ],
    { cwd: root },
  );

export function repo(t: TestContext, config: Record<string, unknown> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      version: 1,
      gate: [process.execPath, '-e', 'process.exit(0)'],
      workflow: { reviewers: { grok: {}, cursor: {} } },
      factory: { author: 'claude', reviewers: ['grok', 'cursor'] },
      ...config,
    }),
  );
  writeFileSync(join(root, 'source.txt'), 'original\n');
  execFileSync('git', ['add', '.'], { cwd: root });
  commit(root);
  return root;
}

// Restores each variable to its value before the test, however often the test changed it.
const originals = new WeakMap<TestContext, Map<string, string | undefined>>();
export function env(t: TestContext, values: Record<string, string | undefined>) {
  let saved = originals.get(t);
  if (!saved) {
    const map = new Map<string, string | undefined>();
    saved = map;
    originals.set(t, map);
    t.after(() => {
      for (const [key, value] of map) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
  }
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// Stub agent and reviewer CLIs. The agent appends to source.txt and reports READY unless
// STUB_AGENT says otherwise; the reviewer passes unless STUB_REVIEW is blocked. Each run
// records its environment and prompt in STUB_LOG.
export function stubs(t: TestContext) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, 'calls.jsonl');
  writeFileSync(log, '');
  const script = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log(name + ' 1.0.0'); process.exit(0); }
const prompt = name === 'grok' ? fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8') : args[args.length - 1];
const reviewer = args.includes('--tools') || prompt.includes('independent read-only reviewer') || prompt.startsWith('Review the evidence');
const reply = (text, cost) => process.stdout.write(JSON.stringify(name === 'grok' ? { text } : { result: text, total_cost_usd: cost, is_error: false }));
fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
  name, reviewer, args, cwd: process.cwd(), prompt: prompt.slice(0, 4000),
  unattended: process.env.HALVARD_UNATTENDED ?? null, readonly: process.env.HALVARD_READONLY ?? null,
  ghToken: process.env.GH_TOKEN ?? null, gitConfig: process.env.GIT_CONFIG_COUNT ?? null,
}) + '\\n');
if (reviewer) {
  const blocked = process.env.STUB_REVIEW === 'blocked';
  const verdict = JSON.stringify({ verdict: blocked ? 'blocked' : 'pass', standards: 'Walked the project rules.', spec: 'Checked the acceptance criteria.',
    findings: blocked ? [{ severity: 'blocking', location: 'source.txt:1', problem: 'Wrong text', suggestion: 'Fix it' }] : [] });
  reply(verdict, 0);
  process.exit(0);
}
if (prompt.includes('test-writing agent')) {
  const dir = prompt.match(/under (\\S+)\\/ and nowhere else/)[1];
  fs.mkdirSync(path.join(process.cwd(), dir), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), dir, 'acceptance.txt'), 'source.txt says implemented\\n');
  if (process.env.STUB_TESTS === 'outside') fs.writeFileSync(path.join(process.cwd(), 'source.txt'), 'test writer edit\\n');
  reply('Tests written.\\nSTATUS: READY', 0.1);
  process.exit(0);
}
if (process.env.STUB_AGENT === 'parent-link') {
  const dir = prompt.match(/Acceptance tests in (\\S+)\\/ were written/)[1];
  fs.renameSync(path.join(process.cwd(), dir), path.join(process.cwd(), 'moved'));
  fs.symlinkSync(path.relative(path.dirname(path.join(process.cwd(), dir)), path.join(process.cwd(), 'moved')), path.join(process.cwd(), dir));
}
if (process.env.STUB_AGENT === 'fifo' || process.env.STUB_AGENT === 'symlink') {
  const dir = prompt.match(/Acceptance tests in (\\S+)\\/ were written/)[1];
  const target = path.join(process.cwd(), dir, 'extra');
  if (process.env.STUB_AGENT === 'fifo') require('child_process').execFileSync('mkfifo', [target]);
  else fs.symlinkSync('..', target);
}
if (process.env.STUB_AGENT === 'edit-tests') {
  const dir = prompt.match(/Acceptance tests in (\\S+)\\/ were written/)[1];
  fs.appendFileSync(path.join(process.cwd(), dir, 'acceptance.txt'), 'weakened\\n');
}
if (prompt.includes('planning agent')) {
  process.stdout.write(JSON.stringify({ result: '## Acceptance criteria\\n\\n1. source.txt says implemented.\\n\\n## Plan\\n\\n1. Edit source.txt.\\n\\n## Out of scope\\n\\nNothing else.\\n\\n## Assumptions\\n\\nNone.', total_cost_usd: 0.05, is_error: false }));
  process.exit(0);
}
if (process.env.STUB_AGENT === 'gitconfig') {
  require('child_process').execFileSync('git', ['config', 'credential.helper', '!echo stolen'], { cwd: process.cwd() });
}
if (process.env.STUB_AGENT === 'config') {
  fs.writeFileSync(path.join(process.cwd(), '.halvard.json'), JSON.stringify({ version: 1, gate: ['true'], workflow: { requireReview: false } }));
}
if (process.env.STUB_AGENT === 'blocked') {
  process.stdout.write(JSON.stringify({ result: 'STATUS: BLOCKED: the brief contradicts itself', total_cost_usd: 0.02, is_error: false }));
  process.exit(0);
}
fs.appendFileSync(path.join(process.cwd(), 'source.txt'), 'implemented\\n');
process.stdout.write(JSON.stringify({ result: 'Done.\\nSTATUS: READY', total_cost_usd: 0.25, is_error: false }));
`;
  for (const name of ['claude', 'grok', 'cursor-agent']) {
    writeFileSync(join(dir, name), script);
    chmodSync(join(dir, name), 0o755);
  }
  writeFileSync(join(dir, 'gh'), ghStub);
  chmodSync(join(dir, 'gh'), 0o755);
  const state = join(dir, 'gh-state.json');
  writeFileSync(
    state,
    JSON.stringify({ issues: [], events: {}, permissions: {}, comments: [], prs: [] }),
  );
  // A parked job sets a failing exit code for scripts; the suite's own result must not inherit it.
  t.after(() => {
    process.exitCode = 0;
  });
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-factory-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  env(t, {
    PATH: `${dir}:${process.env.PATH}`,
    STUB_LOG: log,
    STUB_GH_STATE: state,
    HALVARD_FACTORY_HOME: home,
    GH_TOKEN: 'secret-test-token',
  });
  const calls = () =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            name: string;
            reviewer: boolean;
            args: string[];
            cwd: string;
            prompt: string;
            unattended: string | null;
            readonly: string | null;
            ghToken: string | null;
            gitConfig: string | null;
          },
      );
  return Object.assign(calls, { github: github(state) });
}
