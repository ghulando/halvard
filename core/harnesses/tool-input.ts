import type { HookPayload, ToolInput } from '../types.ts';
import type { Raw } from './types.ts';

// Grok and Cursor name their tools and fields their own way. This maps one call onto the
// Claude tool name and input the engine knows, so core policy stays the same for every host.

// Claude, Codex and Pi already send the payload the engine reads.
export const claudeShaped = (raw: Raw) => raw as unknown as HookPayload;

export const text = (...values: unknown[]) =>
  values.find((value) => typeof value === 'string') as string | undefined;
// Canonical file-tool input, whatever each host calls its fields.
function fileInput(input: Raw): ToolInput {
  return {
    file_path: text(input.file_path, input.path, input.target_file, input.filePath, input.file),
    old_string: text(input.old_string, input.old_str, input.oldText, input.old),
    new_string: text(input.new_string, input.new_str, input.newText, input.new),
    content: text(input.content, input.contents, input.file_text, input.text),
    ...((input.replace_all ?? input.replaceAll) === true ? { replace_all: true } : {}),
  };
}

export function shellInput(input: Raw): ToolInput {
  return {
    command: text(input.command, input.cmd),
    ...(text(input.cwd, input.workdir, input.working_directory) !== undefined
      ? { cwd: text(input.cwd, input.workdir, input.working_directory) }
      : {}),
  };
}

// An edit the guard cannot preview: the host sent no exact old and new text.
function editTool(input: ToolInput): [string, ToolInput] {
  if (input.old_string && input.new_string !== undefined) return ['Edit', input];
  // An empty old string creates the file with the new text.
  if (input.old_string === '' && input.new_string !== undefined) {
    return ['Write', { file_path: input.file_path, content: input.new_string }];
  }
  if (input.content !== undefined && !input.old_string) return ['Write', input];
  return ['OpaqueEdit', { file_path: input.file_path }];
}

const SHELL = new Set(['run_terminal_command', 'run_terminal_cmd', 'Shell', 'shell']);
const READS = new Set([
  'read_file',
  'grep',
  'grep_search',
  'list_dir',
  'list_directory',
  'glob',
  'glob_file_search',
  'file_search',
  'find_files',
  'codebase_search',
  'semantic_search',
  'web_search',
  'web_fetch',
  'todo_write',
  'update_todos',
  'read_lints',
]);
const WRITES = new Set(['write_file', 'create_file', 'Write']);
const EDITS = new Set(['search_replace', 'edit_file', 'StrReplace', 'MultiEdit', 'Edit']);
const DELETES = new Set(['delete_file', 'Delete']);
const AGENTS = new Set(['spawn_subagent', 'Task', 'task']);

// Maps one host tool call onto the Claude tool name and input the engine knows.
export function canonicalTool(name: string, raw: unknown): [string, ToolInput | string] {
  // A host may send the input as a JSON string.
  if (typeof raw === 'string' && /^\s*\{/.test(raw)) {
    try {
      raw = JSON.parse(raw) as unknown;
    } catch {}
  }
  if (typeof raw === 'string') return [name, raw];
  const input = (raw && typeof raw === 'object' ? raw : {}) as Raw;
  if (SHELL.has(name)) return ['Bash', shellInput(input)];
  if (READS.has(name) || name === 'Read' || name === 'Grep') return ['Read', input];
  if (WRITES.has(name)) {
    const file = fileInput(input);
    return file.content === undefined
      ? ['OpaqueEdit', { file_path: file.file_path }]
      : ['Write', file];
  }
  if (EDITS.has(name)) return editTool(fileInput(input));
  // A delete has no preview; the guard checks its path like an edit it cannot preview.
  if (DELETES.has(name)) return ['OpaqueEdit', { file_path: fileInput(input).file_path }];
  if (AGENTS.has(name)) {
    return [
      'Task',
      { subagent_type: text(input.subagent_type, input.subagentType, input.agent_type) },
    ];
  }
  return [name, input];
}
