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
import { projectHoldsData, protectedRoots, workspaceRoot } from '../config/paths.ts';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { chain } from './shell.ts';

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
  // Codex names its namespaced sleep tool clocksleep in its own denial messages.
  'clocksleep',
  'clock__sleep',
  'clock.sleep',
  'view_image',
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

// A path in Halvard's own data outside the workspace: settings, installed copies and
// factory jobs. Agents read it but never write it.
function halvardDataPath(cwd: string, file: unknown) {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return null;
  const physical = physicalPath(resolve(realpathSync(cwd), file));
  const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);
  if (inside(real(workspaceRoot()), physical)) return null;
  return protectedRoots().some((root) => inside(real(root), physical)) ? physical : null;
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
          ].map((match) => match[1])
        : [];
    // A factory worktree lies under the factory folder; its own files are project files.
    const data = targets.flatMap((target) =>
      outsideProject(root, cwd, target) || projectHoldsData(root)
        ? (halvardDataPath(cwd, target) ?? [])
        : [],
    );
    if (data.length) return { kind: 'halvard', paths: data };
    const team = targets.map((target) => workspacePath(cwd, target));
    if (team.length && team.every(Boolean)) {
      return { kind: 'workspace', paths: team as string[] };
    }
    if (team.some(Boolean)) {
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
    const data =
      (outsideProject(root, cwd, target) || projectHoldsData(root)) && halvardDataPath(cwd, target);
    if (data) return { kind: 'halvard', paths: [data] };
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
    const data =
      (outsideProject(root, cwd, target) || projectHoldsData(root)) && halvardDataPath(cwd, target);
    if (data) return { kind: 'halvard', paths: [data] };
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

const SKILL_FILE = /(?:^|\/)skills\/([a-z0-9]+(?:-[a-z0-9]+)*)\/SKILL\.md$/;
// Codex loads a skill by printing its file; a search, an echo or a comment that only names
// one loads nothing, so only a reader's file operands count.
const SKILL_READERS = new Set(['cat', 'sed', 'head', 'tail', 'nl', 'bat', 'less']);
// Reader options whose value is the next word, or the rest of the same word.
const VALUE_OPTIONS: Record<string, string[]> = {
  head: ['-n', '-c'],
  tail: ['-n', '-c'],
  nl: ['-b', '-d', '-f', '-h', '-i', '-l', '-n', '-s', '-v', '-w'],
  bat: ['-r', '--line-range', '-l', '--language'],
};
// The short flags a reader may take and still print its files. Any other short option,
// help and version among them, may print something else, so the reader counts for none.
const SHORT_FLAGS: Record<string, RegExp> = {
  cat: /^-[benstuvAET]+$/,
  head: /^-(?:[qv]+|\d+)$/,
  tail: /^-(?:[qv]+|\d+)$/,
  bat: /^-[pnAP]+$/,
};
// A zero count: head -n 0, head -0, tail -c0, head --lines=0 and the like print nothing.
const ZERO_COUNT = /^(?:-[nc]?|--(?:lines|bytes)=)?0+$/;
// The long options a reader may take and still print its files. Any other, --help and
// --version among them, may print something else instead.
const LONG_OPTIONS: Record<string, RegExp> = {
  head: /^--(?:lines|bytes)=\d+$/,
  tail: /^--(?:lines|bytes)=\d+$/,
  bat: /^--(?:line-range=\S+|plain|paging=never|style=\S+|color=\S+)$/,
};
// sed prints a file for certain only as sed -n '<line or range>p' <file>, or several such
// prints joined by ;, one of them starting at the first or last line, which every file
// that is not empty has. A range that starts further in can start past the end.
const SED_PRINT = /^(?:(\d+|\$)(?:,(?:\d+|\$))?)?p$/;
function sedPrints(script: string) {
  const prints = script.split(';').map((command) => command.match(SED_PRINT));
  return prints.every(Boolean) && prints.some((print) => [undefined, '1', '$'].includes(print![1]));
}

// A range that starts after the first line may start past the end of the file and print
// nothing: tail -n +40, bat -r 40:60. So may a negative head count, which leaves out the
// last lines: head -n -40. A plain head or tail count and bat from line 1 do not.
function startsLate(reader: string, option: string, value: string) {
  if (reader === 'head') return value.startsWith('-');
  if (reader === 'tail') return /^\+\d+$/.test(value) && Number(value.slice(1)) > 1;
  if (reader === 'bat' && (option === '-r' || option === '--line-range')) {
    return !/^(?:1|1?:\d*)$/.test(value);
  }
  return false;
}
const SED_OPTIONS = new Set(['-n', '-E', '-r']);
const READ_PATHS = ['file_path', 'path', 'target_file', 'filePath', 'file'];
// Grok and Cursor searches reach the engine as Read; their query fields mark them.
const SEARCH_FIELDS = ['query', 'pattern', 'regex', 'glob_pattern', 'include_pattern'];

// The files a reader prints: words after it that are not options or option values. A sed
// other than a plain line print, a zero count, a range that may start past the end or an
// option outside the reader's known ones prints none of its files.
function readerFiles([reader, ...args]: string[]) {
  const option = (arg: string) => arg.startsWith('-') && arg !== '-';
  if (reader === 'sed') {
    const options = args.filter(option);
    const [script, ...files] = args.filter((arg) => !option(arg));
    // sed numbers lines across all its files, so a print counts only for a single file.
    const printing =
      files.length === 1 &&
      options.includes('-n') &&
      options.every((arg) => SED_OPTIONS.has(arg)) &&
      sedPrints(script ?? '');
    return printing ? files : [];
  }
  const valued = VALUE_OPTIONS[reader!] ?? [];
  const files: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (valued.includes(arg)) {
      const value = args[++i] ?? '';
      if (ZERO_COUNT.test(value) || startsLate(reader!, arg, value)) return [];
    } else if (arg.startsWith('--')) {
      const [name, value = ''] = arg.split('=');
      if (!LONG_OPTIONS[reader!]?.test(arg) || ZERO_COUNT.test(arg)) return [];
      if (startsLate(reader!, name!, value)) return [];
    } else if (option(arg)) {
      if (valued.length && ZERO_COUNT.test(arg)) return [];
      const attached = valued.some((name) => name.length === 2 && arg.startsWith(name));
      if (!attached && !SHORT_FLAGS[reader!]?.test(arg)) return [];
      if (attached && startsLate(reader!, arg.slice(0, 2), arg.slice(2))) return [];
    } else files.push(arg);
  }
  return files;
}

// The files a shell command printed for certain: reader segments that ran, because no ||
// or background & comes before them, whose success the command's own success proves,
// because only && follows them, or whose file is a readable regular file when ; or a
// newline follows; the command must not end in a background & and the output must not be
// sent to /dev/null. A command the guard's parser cannot read exactly
// yields nothing.
function shellReads(command: string, cwd: string) {
  const parsed = chain(command);
  if (!parsed) return [];
  const { segments, operators, silenced } = parsed;
  return segments.flatMap((segment, i) => {
    if (
      !SKILL_READERS.has(segment[0]!) ||
      silenced.has(i) ||
      operators.at(-1) === '&' ||
      !operators.slice(0, i).every((op) => op !== '||' && op !== '&')
    ) {
      return [];
    }
    const following = operators.slice(i, -1);
    if (following.every((op) => op === '&&')) return readerFiles(segment);
    // After ; or a newline the next command runs whatever the reader's status, so the
    // command's success proves nothing about it. A reader of a regular file it may read
    // does not fail, so such a file counts; a missing or unreadable one does not. A
    // relative path counts only while no earlier cd or pushd moved the shell.
    if (!following.every((op) => op === '&&' || SEQUENCE.has(op))) return [];
    const moved = segments.slice(0, i).some((s) => s[0] === 'cd' || s[0] === 'pushd');
    return readerFiles(segment).filter((file) => readableFile(file, cwd, moved));
  });
}

const SEQUENCE = new Set([';', '\n']);

function readableFile(file: string, cwd: string, moved: boolean) {
  // The parser drops quotes, so a ~ path may be literal; it never counts.
  if (moved && !isAbsolute(file)) return false;
  const path = resolve(cwd, file);
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

// The skills a tool call loads: Claude's Skill tool, or a read of a skill's SKILL.md
// through a file tool or a shell reader.
export function loadedSkills(payload: HookPayload): string[] {
  const name = payload.tool_name;
  const input = payload.tool_input;
  if (!input || typeof input !== 'object') return [];
  if (name === 'Skill') {
    return typeof input.skill === 'string' && input.skill ? [input.skill.split(':').pop()!] : [];
  }
  let paths: unknown[] = [];
  if (['read', 'Read'].includes(name as string) && !SEARCH_FIELDS.some((key) => key in input)) {
    paths = READ_PATHS.map((key) => input[key]);
  }
  if (['bash', 'Bash', 'exec_command', 'shell_command'].includes(name as string)) {
    const command = input.command ?? input.cmd;
    if (typeof command === 'string') paths = shellReads(command, payload.cwd);
  }
  const names = paths.flatMap((path) => {
    const match = typeof path === 'string' ? path.match(SKILL_FILE) : null;
    return match ? [match[1]!] : [];
  });
  return [...new Set(names)];
}

function resolveDirectory(root: string, cwd: string, path: unknown) {
  const relative = projectPath(root, cwd, path);
  return relative ? `${root}/${relative}` : root;
}
