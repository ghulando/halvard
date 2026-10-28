import type {
  Project,
  HookPayload,
  ToolInput,
  EditPairInput,
  FileChange,
  Action,
} from '../types.ts';
import {
  inside,
  matches,
  outsideProject,
  physicalPath,
  projectPath,
  readText,
  singleLink,
} from '../project.ts';
import { workspaceRoot } from '../config/paths.ts';
import { existsSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const REBUILD = 're-read each file in the patch and rebuild the hunks from its current text';

const FILE_TOOLS = new Set(['write', 'edit', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const READ_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'Read',
  'Grep',
  'Glob',
  'LS',
  'update_plan',
  'request_user_input',
  'request_user_input_async',
  // Host bookkeeping and network reads have no project-file side effects.
  'get_goal',
  'create_goal',
  'update_goal',
  'webrun',
  'web.run',
  'web__run',
  'web_search',
  'clock__curr_time',
  'clock.curr_time',
  'ExitPlanMode',
  'EnterPlanMode',
  'TodoWrite',
  'Skill',
  'WebFetch',
  'WebSearch',
  'AskUserQuestion',
  'ToolSearch',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
]);

// A subagent's own tool calls pass through the same hooks, so spawning one
// changes nothing. Plan mode admits only these, which have no edit tools.
const READ_AGENTS = new Set(['Explore', 'Plan']);

function edits(input: ToolInput) {
  if (Array.isArray(input.edits)) {
    return input.edits.map((raw: unknown) => {
      const e = raw as EditPairInput;
      return {
        old: e.oldText ?? e.old_string,
        next: e.newText ?? e.new_string,
      };
    });
  }
  if (input.old_string !== undefined || input.oldText !== undefined) {
    return [
      {
        old: input.old_string ?? input.oldText,
        next: input.new_string ?? input.newText,
      },
    ];
  }
  return [];
}

function applyEdits(
  content: string,
  changes: { old: unknown; next: unknown }[],
  replaceAll: boolean,
) {
  for (const { old, next } of changes) {
    if (typeof old !== 'string' || !old || typeof next !== 'string') {
      throw new Error('invalid edit pair');
    }
    const first = content.indexOf(old);
    if (first < 0 || (!replaceAll && content.indexOf(old, first + old.length) >= 0)) {
      throw new Error('edit preview is missing or ambiguous');
    }
    content = replaceAll
      ? content.split(old).join(next)
      : content.slice(0, first) + next + content.slice(first + old.length);
  }
  return content;
}

function workspacePath(cwd: string, file: unknown) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return null;
  const physical = physicalPath(resolve(realpathSync(cwd), file));
  const base = workspaceRoot();
  if (!inside(existsSync(base) ? realpathSync(base) : base, physical)) return null;
  singleLink(physical);
  return physical;
}

// Preview the same patch paths and hunks without changing the tool input.
export function previewPatch(
  root: string,
  cwd: string,
  patch: unknown,
  post = false,
): FileChange[] {
  if (typeof patch !== 'string' || patch.length > 8 * 1024 * 1024) {
    throw new Error('missing or oversized patch');
  }
  const lines = patch.replace(/\r\n/g, '\n').trimEnd().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') {
    throw new Error('invalid patch envelope');
  }
  if (post) {
    const paths = lines.flatMap((line) => {
      const match = line.match(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/);
      return match ? [projectPath(root, cwd, match[1]!)] : [];
    });
    return [...new Set(paths)].map((path) => ({
      path,
      before: '',
      after: existsSync(resolve(root, path)) ? readText(root, path) : null,
    }));
  }
  const files: FileChange[] = [];
  for (let i = 0; i < lines.length;) {
    const header = lines[i++]!.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/);
    if (!header) throw new Error('unsupported patch directive');
    const [, kind, rawPath] = header;
    const path = projectPath(root, cwd, rawPath!);
    const before = readText(root, path);
    let destination = path;
    if (kind === 'Update' && lines[i]!?.startsWith('*** Move to: ')) {
      destination = projectPath(root, cwd, lines[i++]!.slice(13));
      files.push({ path, before, after: null });
    }
    const body = [];
    while (i < lines.length && !/^\*\*\* (Add|Update|Delete) File: /.test(lines[i]!)) {
      body.push(lines[i++]!);
    }
    if (kind === 'Delete') {
      if (body.length) throw new Error('delete patch has unexpected content');
      files.push({ path, before, after: null });
    } else if (kind === 'Add') {
      if (body.some((line) => !line.startsWith('+'))) throw new Error('invalid added-file patch');
      files.push({ path, before, after: body.map((line) => line.slice(1)).join('\n') + '\n' });
    } else {
      const source = before.replace(/\r\n/g, '\n').split('\n');
      if (source.at(-1) === '') source.pop();
      let cursor = 0;
      let hunk: string[] = [];
      let anchor: string | undefined;
      let eof = false;
      const replacements: { at: number; count: number; next: string[] }[] = [];
      const applyHunk = () => {
        if (!hunk.length) return;
        if (anchor !== undefined) {
          const at = source.indexOf(anchor, cursor);
          if (at < 0) throw new Error(`patch context does not match the file; ${REBUILD}`);
          cursor = at + 1;
        }
        const old = hunk.filter((line) => line[0] !== '+').map((line) => line.slice(1));
        const next = hunk.filter((line) => line[0] !== '-').map((line) => line.slice(1));
        let found = old.length ? -1 : source.length;
        const start = eof ? Math.max(cursor, source.length - old.length) : cursor;
        for (let at = start; old.length && at <= source.length - old.length; at++) {
          if (old.every((line, n) => source[at + n] === line)) {
            found = at;
            break;
          }
        }
        if (found < 0) throw new Error(`patch hunk does not match the file; ${REBUILD}`);
        replacements.push({ at: found, count: old.length, next });
        if (old.length) cursor = found + old.length;
        hunk = [];
        anchor = undefined;
        eof = false;
      };
      for (const line of body) {
        if (line === '@@' || line.startsWith('@@ ')) {
          applyHunk();
          anchor = line === '@@' ? undefined : line.slice(3);
          continue;
        }
        if (line === '*** End of File') {
          eof = true;
          applyHunk();
          continue;
        }
        if (!/^[ +\-]/.test(line)) throw new Error('unsupported patch hunk');
        hunk.push(line);
      }
      applyHunk();
      if (!replacements.length) throw new Error('update patch has no hunks');
      // Match against the original file, then apply backward so edits cannot
      // move the context of later chunks. Addition-only chunks append at EOF.
      const content = [...source];
      replacements.sort((a, b) => a.at - b.at).reverse();
      for (const change of replacements) content.splice(change.at, change.count, ...change.next);
      files.push({
        path: destination,
        before: destination === path ? before : readText(root, destination),
        after: content.join('\n') + '\n',
      });
    }
  }
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error(
      'patch touches the same path more than once; put all changes to each file in one section',
    );
  }
  if (!files.length) throw new Error('empty patch');
  return files;
}

export function normalize(project: Project, payload: HookPayload): Action {
  const { root, config } = project;
  const name = payload.tool_name as string;
  const input = (payload.tool_input ?? {}) as ToolInput;
  const cwd = payload.cwd ?? root;
  if (['bash', 'Bash', 'exec_command', 'shell_command'].includes(name)) {
    const command = input.command ?? input.cmd;
    if (typeof command !== 'string' || !command || command.length > 1024 * 1024) {
      throw new Error('missing or oversized shell command');
    }
    const workdir = input.workdir ?? input.cwd ?? cwd;
    // Resolve against the original session root; changing cwd must not change the policy.
    const dir = resolveDirectory(root, cwd, workdir);
    return { kind: 'shell', command, cwd: dir, input };
  }
  if (name === 'apply_patch') {
    const patch = typeof input === 'string' ? input : (input.command ?? input.patch ?? input.input);
    const targets =
      typeof patch === 'string'
        ? [
            ...patch
              .replace(/\r\n/g, '\n')
              .matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm),
          ].map((match) => workspacePath(cwd, match[1]))
        : [];
    if (targets.length && targets.every(Boolean)) {
      return { kind: 'workspace', paths: targets as string[] };
    }
    if (targets.some(Boolean)) {
      throw new Error(
        'patch mixes task workspace and other files; send workspace files and repository files as separate patches',
      );
    }
    return {
      kind: 'files',
      files: previewPatch(root, cwd, patch, payload.hook_event_name === 'PostToolUse'),
    };
  }
  if (FILE_TOOLS.has(name)) {
    const target = input.path ?? input.file_path ?? input.notebook_path;
    const team = outsideProject(root, cwd, target) && workspacePath(cwd, target);
    if (team) return { kind: 'workspace', paths: [team] };
    // Harness plans, memory and scratch files are governed by the harness's own permissions.
    if (outsideProject(root, cwd, target)) return { kind: 'outside' };
    const path = projectPath(root, cwd, target);
    const before = readText(root, path);
    let after;
    if (['write', 'Write'].includes(name)) {
      if (typeof input.content !== 'string' || input.content.length > 4 * 1024 * 1024) {
        throw new Error('missing or oversized file content');
      }
      after = input.content;
    } else if (name === 'NotebookEdit') {
      // Notebook serialization belongs to the host. Inspect the proposed cell too.
      after = JSON.stringify(input.new_source)!;
    } else if (payload.hook_event_name === 'PostToolUse') {
      after = before;
    } else {
      const pairs = edits(input);
      if (!pairs.length) throw new Error('missing edit pairs');
      after = applyEdits(before, pairs, input.replace_all === true);
    }
    return { kind: 'files', files: [{ path, before, after }] };
  }
  // Grok and Cursor edits without exact old and new text cannot be previewed. The path
  // still gets the branch and protected-file checks; a task file needs a previewable edit
  // so a completion claim cannot slip past the done proof.
  if (name === 'OpaqueEdit') {
    const target = input.file_path;
    const team = outsideProject(root, cwd, target) && workspacePath(cwd, target);
    if (team) return { kind: 'workspace', paths: [team] };
    if (outsideProject(root, cwd, target)) return { kind: 'outside' };
    const path = projectPath(root, cwd, target);
    if (matches(path, config.taskFiles)) {
      throw new Error('edit task files with an exact replacement or a whole-file write');
    }
    const before = readText(root, path);
    return { kind: 'files', files: [{ path, before, after: before }] };
  }
  // MCP servers act outside the hook's view of the project and the host
  // prompts for them natively; gate passes stay bound to the tree fingerprint.
  if (name.startsWith('mcp__')) return { kind: 'outside' };
  if (READ_TOOLS.has(name) || matches(name, config.readOnlyTools)) return { kind: 'read' };
  // Codex polls a long command with empty input; any input could start a new command.
  if (name === 'write_stdin' && input.chars === '') return { kind: 'read' };
  if (
    ['Agent', 'Task'].includes(name) &&
    (payload.permission_mode !== 'plan' || READ_AGENTS.has(input.subagent_type as string))
  ) {
    return { kind: 'read' };
  }
  return { kind: 'unknown' };
}

function resolveDirectory(root: string, cwd: string, path: unknown) {
  const relative = projectPath(root, cwd, path);
  return relative ? `${root}/${relative}` : root;
}
