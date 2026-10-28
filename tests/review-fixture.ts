import type { TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../core/project.ts';
import { startTask } from '../core/workflow/tasks.ts';
import { runReview as rawReview } from '../core/workflow/review.ts';
import { sessionKey } from '../core/state.ts';
import { runGate } from '../core/workflow/gate.ts';

export function fixture(t: TestContext, workflow = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-pack-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({
      version: 1,
      gate: [process.execPath, '-e', 'process.exit(0)'],
      workflow: {
        reviewers: {
          claude: {},
          codex: {},
          grok: {},
          cursor: {},
          ollama: { model: 'test-model' },
        },
        ...workflow,
      },
    }),
  );
  writeFileSync(join(root, 'source.txt'), 'original\n');
  git(root, ['add', '.']);
  git(root, [
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'fixture',
  ]);
  return root;
}

export async function runReview(
  root: string,
  path: string,
  args: { author: string; reviewer: string; round: number },
) {
  const gateSession = sessionKey(root, args.author, 'review-test');
  await runGate(root, gateSession);
  return rawReview(root, path, { ...args, gateSession });
}

export function fakeReviewers(t: TestContext, mode = 'pass') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-review-cli-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.PATH;
  process.env.PATH = `${dir}:${previous}`;
  t.after(() => {
    process.env.PATH = previous;
  });
  const record = join(dir, 'invocation.json');
  const script = `#!${process.execPath}
const fs = require('fs');
const path = require('path');
let input = '';
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => {
 const name = path.basename(process.argv[1]), args = process.argv.slice(2);
 fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({name,args,input,cwd:process.cwd()}));
 const result = JSON.stringify({verdict:'${mode === 'blocked' ? 'blocked' : 'pass'}', standards:'Checked project rules and concrete source.',spec:'Checked the stated acceptance criteria.',findings:${mode === 'blocked' ? "[{severity:'blocking',location:'source.txt:1',problem:'Wrong behavior',suggestion:'Fix it'}]" : '[]'}});
 ${mode === 'timeout' ? 'setInterval(() => {}, 1000); return;' : ''}
 ${mode === 'mutate' ? "const root = input.match(/MUTATE_ROOT=(.+)/)[1]; fs.writeFileSync(path.join(root,'source.txt'),'outside edit');" : ''}
 if (name === 'codex') fs.writeFileSync(args[args.indexOf('-o')+1], result);
 else if (name === 'claude' || name === 'cursor-agent') process.stdout.write(JSON.stringify({result:${mode === 'malformed' ? "'not-json'" : 'result'},is_error:false}));
 else if (name === 'grok') process.stdout.write(JSON.stringify({text:fs.readFileSync(args[args.indexOf('--prompt-file')+1],'utf8').includes('original') ? result : 'missing evidence'}));
 else process.stdout.write(result);
});
`;
  for (const name of ['claude', 'codex', 'ollama', 'grok', 'cursor-agent']) {
    const file = join(dir, name);
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
  return record;
}

export const start = (root: string, author = 'codex') =>
  startTask(root, { id: 'example', title: 'Build example', author });
