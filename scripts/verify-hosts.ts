#!/usr/bin/env node
import type { PackedArchive } from '../core/install/types.ts';
import type { NativeHookOutput } from '../core/types.ts';
// Optional native-loader checks. No model prompts, user configuration or trust changes.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../', import.meta.url));
const [flag, loaderPath, ...extra] = process.argv.slice(2);

if (flag && (flag !== '--pi-loader' || !loaderPath || extra.length)) {
  throw new Error(
    'Usage: node scripts/verify-hosts.ts [--pi-loader /path/to/pi/dist/core/extensions/loader.js]',
  );
}

const root = realpathSync(mkdtempSync(join(tmpdir(), 'workflow-native-hosts-')));
const previous = { pi: process.env.PI_CODING_AGENT_DIR, workflow: process.env.HALVARD_HOME };

try {
  process.env.PI_CODING_AGENT_DIR = join(root, 'pi');
  process.env.HALVARD_HOME = join(root, 'workflow');
  execFileSync('git', ['init', '-q', '--initial-branch=main'], { cwd: root });
  writeFileSync(
    join(root, '.halvard.json'),
    JSON.stringify({ version: 1, workflow: { requireReview: false } }),
  );
  if (loaderPath) {
    const { loadExtensions } = (await import(pathToFileURL(resolve(loaderPath)).href)) as {
      loadExtensions(
        paths: string[],
        cwd: string,
      ): Promise<{
        errors: unknown[];
        extensions: {
          handlers: Map<string, ((event: unknown, ctx: unknown) => Promise<unknown>)[]>;
        }[];
      }>;
    };
    const adapter = join(source, 'adapters/pi.ts');
    const loaded = await loadExtensions([adapter, adapter], root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 2);
    assert.equal(loaded.extensions[1]!.handlers.size, 0);
    const extension = loaded.extensions[0]!;
    const ctx = {
      cwd: root,
      hasUI: false,
      sessionManager: { getSessionId: () => 'native-host-check' },
    };
    const messages = [];
    for (const handler of extension.handlers.get('before_agent_start') ?? []) {
      const result = await handler({}, ctx);
      if (result) messages.push(result);
    }
    assert.match(JSON.stringify(messages), /Halvard is active/);
    for (const handler of extension.handlers.get('tool_call') ?? []) {
      assert.equal(
        await handler(
          { toolName: 'bash', input: { command: 'ps -axo pid,ppid,etime,command' } },
          ctx,
        ),
        undefined,
      );
      const denial = (await handler(
        { toolName: 'write', input: { path: 'source.txt', content: 'change' } },
        ctx,
      )) as { block: boolean; reason: string };
      assert.equal(denial.block, true);
      assert.match(denial.reason, /^halvard blocked: No work on protected branch main/);
    }
    execFileSync('git', ['checkout', '-q', '-b', 'feature/host-check'], { cwd: root });
    const choices: string[][] = [];
    const ui = {
      ...ctx,
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          choices.push(options);
          return options[1];
        },
      },
    };
    for (const handler of extension.handlers.get('tool_call') ?? []) {
      const pack = { toolName: 'bash', input: { command: 'npm pack --dry-run' } };
      assert.equal(await handler(pack, ui), undefined);
      assert.equal(await handler(pack, ui), undefined);
    }
    assert.equal(choices.length, 1);
    assert.match(choices[0]![1]!, /for this session/);
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: root });
    console.log(
      'Pi native loader: peer imports, duplicate suppression, startup context, read allowance, write denial and session approval passed.',
    );
  } else {
    console.log('Pi loader check skipped; supply --pi-loader for your installed Pi.');
  }
  // Validate a real tarball so repository-only instructions do not confuse plugin validation.
  const packed = (
    JSON.parse(
      execFileSync('npm', ['pack', '--json', '--pack-destination', root], {
        cwd: source,
        encoding: 'utf8',
      }),
    ) as PackedArchive[]
  )[0]!;
  execFileSync('tar', ['-xzf', join(root, packed.filename), '-C', root]);
  const validation = spawnSync(
    'claude',
    ['plugin', 'validate', join(root, 'package'), '--json', '--strict'],
    { encoding: 'utf8' },
  );
  if ((validation.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    console.log('Claude native manifest check skipped; Claude CLI is not installed.');
  } else {
    assert.equal(validation.status, 0, validation.stdout + validation.stderr);
    assert.equal((JSON.parse(validation.stdout) as { success: boolean }).success, true);
    console.log('Claude strict native validation of the packed plugin passed.');
  }
  // Codex hooks are exercised through their subprocess protocol, without a model run.
  const result = spawnSync(process.execPath, [join(root, 'package/bin/hook.ts'), 'codex'], {
    encoding: 'utf8',
    input: JSON.stringify({
      cwd: root,
      session_id: 'native-host-check',
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'source.txt', content: 'change' },
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    (JSON.parse(result.stdout) as NativeHookOutput).hookSpecificOutput!.permissionDecision,
    'deny',
  );
  console.log(
    'Codex packed hook protocol passed; native loading/trust must be confirmed in the client after registration.',
  );
} finally {
  if (previous.pi === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previous.pi;
  }
  if (previous.workflow === undefined) {
    delete process.env.HALVARD_HOME;
  } else {
    process.env.HALVARD_HOME = previous.workflow;
  }
  rmSync(root, { recursive: true, force: true });
}
