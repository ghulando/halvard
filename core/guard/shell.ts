import type { ReadCommand } from '../types.ts';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { projectHoldsData, protectedRoots, workspaceRoot } from '../config/paths.ts';
import { inside, outsideProject, physicalPath } from '../project.ts';

export type ShellKind = 'read' | 'outside' | 'branch' | 'opaque' | 'mutation';

// Redirections that discard output or merge stderr cannot write project files.
const DISCARD = /^(?:[12]?>\/dev\/null|2>&1)(?=[\s;|&]|$)/;

// Unknown shell syntax is opaque. A command classifier is not a shell sandbox.
function parse(text: string, comments = true) {
  const segments: string[][] = [];
  // The operator that follows each segment; '' after the last.
  const operators: string[] = [];
  let words: string[] = [];
  let word = '';
  let started = false;
  let quote = '';
  let glob = false;
  let comment = false;
  // Output redirections to a literal path, by the segment that writes them.
  const redirects: { segment: number; path: string }[] = [];
  // Segments whose standard output a discard redirection throws away.
  const silenced = new Set<number>();
  let redirecting = false;
  let quoted = false;
  let orphan = false;
  const pushWord = () => {
    if (started && redirecting) {
      // A ~ in a word with quotes may be literal; reading it so keeps the write in view.
      const path = quoted && word.startsWith('~') ? `./${word}` : word;
      redirects.push({ segment: segments.length, path });
      redirecting = false;
    } else if (started) {
      // A quoted ~ in a cd operand is a literal name, not the home directory.
      const literal = quoted && words.length === 1 && words[0] === 'cd' && word.startsWith('~');
      words.push(literal ? `./${word}` : word);
    }
    word = '';
    started = false;
    quoted = false;
  };
  const pushSegment = (operator = '') => {
    pushWord();
    if (redirecting) orphan = true;
    if (words.length) {
      segments.push(words);
      operators.push(operator);
    } else if (redirects.some((r) => r.segment === segments.length)) orphan = true;
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) {
        quote = '';
        continue;
      }
      // Inside double quotes a backslash escapes only these characters; before
      // anything else it is literal. A line continuation stays opaque.
      if (quote === '"' && ch === '\\') {
        const next = text[i + 1] ?? '';
        if (/["\\$`]/.test(next)) {
          word += text[++i]!;
          continue;
        }
        if (next === '\n') return null;
        word += ch;
        continue;
      }
      if (quote === '"' && /[$`]/.test(ch)) return null;
      word += ch;
      continue;
    }
    if (!started && /[12>]/.test(ch)) {
      const discard = text.slice(i, i + 12).match(DISCARD);
      if (discard) {
        if (/^1?>/.test(discard[0])) silenced.add(segments.length);
        i += discard[0].length - 1;
        continue;
      }
    }
    // A shell without interactive comments treats '#' as an ordinary word.
    // Comment text with shell syntax or quotes would act there, so it stays
    // opaque; shellKind also checks the plain-word reading.
    if (comments && ch === '#' && !started) {
      const end = text.indexOf('\n', i);
      if (/[;|&$`\\()<>{}'"]/.test(text.slice(i, end === -1 ? undefined : end))) return null;
      i = end === -1 ? text.length : end - 1;
      comment = true;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = true;
      quote = ch;
      started = true;
      continue;
    }
    // Plain > and >> take the next word as their target; other forms stay opaque.
    if (ch === '>' && !started && !redirecting) {
      if (text[i + 1] === '>') i++;
      if (/[>|&]/.test(text[i + 1] ?? '')) return null;
      redirecting = true;
      continue;
    }
    if (/[*?[\]]/.test(ch)) {
      if (redirecting) return null;
      glob = true;
      word += ch;
      started = true;
      continue;
    }
    if (/[$`\\()<>{}]/.test(ch)) return null;
    if (/[;|&\n]/.test(ch)) {
      const operator = /[|&]/.test(ch) && text[i + 1] === ch ? ch + text[++i]! : ch;
      pushSegment(operator);
      continue;
    }
    if (/\s/.test(ch)) {
      pushWord();
      continue;
    }
    word += ch;
    started = true;
  }
  if (quote) return null;
  pushSegment();
  return segments.length && !orphan
    ? { segments, operators, glob, comment, redirects, silenced }
    : null;
}

// Callers that act on exact words get no comment or redirect leniency. Operators[i] joins
// segment i to the next: ';', '&&', '||', '|', '&' or a newline; '' after the last.
// Silenced holds the segments whose standard output goes to /dev/null.
export function chain(text: string) {
  const parsed = parse(text);
  return parsed && !parsed.glob && !parsed.comment && !parsed.redirects.length
    ? { segments: parsed.segments, operators: parsed.operators, silenced: parsed.silenced }
    : null;
}

export const commands = (text: string) => chain(text)?.segments ?? null;

const SHIPPING_GIT = new Set(['commit', 'merge', 'push']);
const SHIPPING_WORDS = new Set(['publish', 'push', 'deploy', 'release', 'upload']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'eval']);
// Git global options whose value is a separate word.
const GIT_VALUE_OPTIONS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--config-env',
]);

function gitVerb(segment: string[]) {
  let i = segment.findIndex((word) => word === 'git' || word.endsWith('/git'));
  if (i < 0) return undefined;
  for (i++; segment[i]?.startsWith('-'); i++) {
    if (GIT_VALUE_OPTIONS.has(segment[i]!)) i++;
  }
  return segment[i];
}

export type ShippingKind = 'shipping' | 'uncertain';
export interface Shipping {
  kind: ShippingKind;
  // Why a command is uncertain, for the approval reason. Never holds command text.
  why?: string;
}

const INTERPRETERS = new Set([
  'python',
  'python3',
  'node',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
  'Rscript',
  'lua',
]);
// Tools whose subcommand ships when it is a shipping word, as in npm publish.
const SHIP_TOOLS = new Set([
  'git',
  'npm',
  'pnpm',
  'yarn',
  'npx',
  'cargo',
  'twine',
  'gh',
  'docker',
  'podman',
  'helm',
  'kubectl',
  'vercel',
  'netlify',
  'firebase',
  'fly',
  'flyctl',
  'heroku',
  'gcloud',
  'aws',
  'az',
  'terraform',
  'make',
  'poetry',
  'gem',
  'mvn',
  'gradle',
  'dotnet',
  'wrangler',
  'serverless',
  'sls',
  'pulumi',
  'rsync',
  'scp',
  'curl',
]);
// Script text that starts programs or reaches the network; with shipping words in it,
// Halvard cannot tell whether it ships.
const EFFECTS =
  /\b(?:subprocess|os\.system|os\.exec\w*|os\.spawn\w*|popen|child_process|exec(?:Sync|File|FileSync)?\s*\(|spawn(?:Sync)?\s*\(|system\s*\(|Deno\.(?:run|Command)|Bun\.spawn|IO\.popen|requests\.|urllib|http\.client|httpx|fetch\s*\(|axios|boto3|curl|wget)/;
const SHIPPING_TEXT = /\b(publish|push|deploy|release|upload|commit|merge)\b/;

const base = (word: string) => word.split('/').pop()!;
const stem = (word: string) => base(word).replace(/\.[A-Za-z0-9]+$/, '');

// Code handed to an interpreter. Shipping when it holds a command such as git push or npm
// publish as adjacent words, even split across string literals; uncertain when it starts
// programs or uses the network and mentions shipping; otherwise its words are data.
function scriptShipping(code: string): Shipping | null {
  const words = code.split(/[\s'"`,()[\]{};:=+]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const tool = base(words[i]!);
    if (!SHIP_TOOLS.has(tool)) continue;
    const next = words.slice(i + 1, i + 5).filter((word) => !word.startsWith('-'));
    if (tool === 'git' ? SHIPPING_GIT.has(next[0]!) : next.some((w) => SHIPPING_WORDS.has(w))) {
      return { kind: 'shipping' };
    }
  }
  const word = code.match(SHIPPING_TEXT)?.[1];
  return word && EFFECTS.test(code)
    ? {
        kind: 'uncertain',
        why: `It runs a script that starts programs or uses the network, and the script mentions "${word}".`,
      }
    : null;
}

// Heredocs: the body is data for a reader such as cat or tee, script text for a shell or
// an interpreter, and unknown input for anything else. The scan follows quotes, comments
// and backslashes, so a quoted or commented <<, an escaped \<< and a here-string <<< open
// nothing. Returns the command text with the bodies removed, or null when a heredoc is not
// terminated or the text cannot be followed, so the plain-word fallback applies.
interface Heredoc {
  receiver: string[];
  body: string;
  // An unquoted delimiter lets the shell expand $( ) and backticks in the body.
  expands: boolean;
  // The body is written to a file: a redirect or a tee operand.
  written: boolean;
}

function heredocs(text: string) {
  // In $(( )) and (( )), << is a left shift; such text goes to the plain-word fallback.
  if (text.includes('((')) return null;
  let command = '';
  const bodies: Heredoc[] = [];
  let quote = '';
  let lineStart = 0;
  const opened: { strip: boolean; tag: string; expands: boolean; at: number }[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = '';
      else if (quote === '"' && ch === '\\') {
        command += ch;
        i++;
      }
      command += text[i] ?? '';
      i++;
      continue;
    }
    if (ch === '\\') {
      command += ch + (text[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      command += ch;
      i++;
      continue;
    }
    if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]!))) {
      const end = text.indexOf('\n', i);
      command += text.slice(i, end === -1 ? undefined : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<') {
      if (text[i + 2] === '<') return null;
      const open = text
        .slice(i)
        .match(/^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([A-Za-z_][\w.-]*))/);
      if (!open) return null;
      const tag = open[2] ?? open[3] ?? open[4]!;
      if (!/^[A-Za-z_][\w.-]*$/.test(tag)) return null;
      const expands = open[4] !== undefined && !open[0].includes('\\');
      opened.push({ strip: open[1] === '-', tag, expands, at: command.length });
      command += ' ';
      i += open[0].length;
      continue;
    }
    if (ch === '\n') {
      const line = command.slice(lineStart);
      command += '\n';
      i++;
      for (const open of opened) {
        const body: string[] = [];
        let closed = false;
        while (i <= text.length) {
          const end = text.indexOf('\n', i);
          const raw = text.slice(i, end === -1 ? undefined : end);
          i = end === -1 ? text.length + 1 : end + 1;
          if ((open.strip ? raw.replace(/^\t+/, '') : raw) === open.tag) {
            closed = true;
            break;
          }
          body.push(raw);
        }
        if (!closed) return null;
        bodies.push({
          ...receiverOf(line, open.at - lineStart),
          body: body.join('\n'),
          expands: open.expands,
        });
      }
      if (opened.length && i > text.length) i = text.length;
      opened.length = 0;
      lineStart = command.length;
      continue;
    }
    command += ch;
    i++;
  }
  if (quote || opened.length) return null;
  return { command, bodies };
}

// The command that reads a heredoc opened at `at` in its line, and whether the body goes
// to a file. A reader piped on, as in cat <<EOF | sh, hands the body to the next command.
function receiverOf(line: string, at: number) {
  const before = line
    .slice(0, at)
    .split(/&&|\|\||[;|&]/)
    .pop()!;
  const after = line.slice(at).split(/&&|\|\||;|&(?!&)/)[0]!;
  const stages = [before + after.split('|')[0], ...after.split('|').slice(1)].map((part) =>
    part.replace(/['"]/g, '').split(/\s+/).filter(Boolean),
  );
  const first = stages[0]!;
  const written =
    first.some((word) => /^\d?>>?/.test(word)) ||
    (base(runs(first)[0] ?? '') === 'tee' &&
      runs(first)
        .slice(1)
        .some((w) => !w.startsWith('-')));
  const receiver =
    stages.find((stage) => {
      const name = base(runs(stage)[0] ?? '');
      return !(READERS.has(name) || name === 'tee');
    }) ?? first;
  return { receiver, written };
}

// A command line that runs a file or sources one, so a heredoc it wrote may run too.
const RUNS_FILE =
  /(?:^|[\s;&|(])(?:\.\/|\.\s|source\s|sh\s|bash\s|zsh\s|dash\s|python[\d.]*\s|node\s|ruby\s|perl\s|chmod\s+\+?[0-7]*x)/;
// Files that run later on their own: shell startup files, Git and Husky hooks, and system
// profiles. A heredoc written there with shipping words is uncertain, not data.
const SHELL_STARTUP =
  /(?:^|[\s>/])\.(?:bashrc|bash_profile|zshrc|zprofile|zshenv|profile)\b|(?:^|[\s>])(?:\S*\/)?\.(?:git|husky)\/|(?:^|[\s>])\/etc\//;

function words(text: string) {
  return text
    .replace(/(^|\s)#[^\n]*/g, '$1')
    .replace(/\\\n/g, ' ')
    .replace(/[\\'"]/g, '')
    .split(/[;&|()\n`]+/)
    .map((part) => part.split(/[\s$<>]+/).filter(Boolean));
}

// The command a segment runs, after assignments and wrappers that run their arguments.
const WRAPPERS = new Set([
  'env',
  'command',
  'exec',
  'nohup',
  'time',
  'nice',
  'sudo',
  'xargs',
  'timeout',
  'stdbuf',
  'ionice',
  'chrt',
  'caffeinate',
]);
// Wrapper options whose value is the next word, as in nice -n 5 or sudo -u name.
const WRAPPER_VALUES = new Set(['-n', '-u', '-g', '-k', '-s', '-c', '-t', '-p', '-I', '-L', '-P']);
function runs(segment: string[]) {
  let i = 0;
  let wrapped = false;
  while (i < segment.length) {
    const word = segment[i]!;
    if (/^[A-Za-z_]\w*=/.test(word) || WRAPPERS.has(base(word))) {
      wrapped ||= WRAPPERS.has(base(word));
      i++;
    } else if (wrapped && word.startsWith('-')) {
      i += WRAPPER_VALUES.has(word) ? 2 : 1;
    } else if (wrapped && /^\d+(?:\.\d+)?[smhd]?$/.test(word)) {
      i++; // A duration or priority, as in timeout 5.
    } else {
      break;
    }
  }
  return segment.slice(i);
}

function segmentShipping(
  segment: string[],
  readCommands: ReadCommand[],
  root: string | undefined,
): Shipping | null {
  if (SHIPPING_GIT.has(gitVerb(segment)!)) return { kind: 'shipping' };
  // A read cannot ship; its operands, such as a search pattern, are data.
  if (isRead(segment, readCommands, root)) return null;
  const command = runs(segment);
  const name = base(command[0] ?? '');
  if (SHELLS.has(name) || command.some((word) => SHELLS.has(base(word)))) {
    for (const word of command) {
      if (/\s/.test(word)) {
        const nested = shippingKind(word, readCommands, root);
        if (nested) return nested;
      }
    }
  }
  if (INTERPRETERS.has(name.replace(/[\d.]+$/, '')) || INTERPRETERS.has(name)) {
    for (const [i, word] of command.entries()) {
      // -c, -e, combined short flags ending in c or e (-Ic), and --eval=<code>.
      const inline = word.match(/^--(?:eval|print)=([\s\S]*)$/)?.[1];
      const code =
        inline ?? (/^-[A-Za-z]*[ceEp]$|^--(?:eval|print)$/.test(word) ? command[i + 1] : undefined);
      if (i > 0 && code !== undefined) {
        const script = scriptShipping(code);
        if (script) return script;
      }
    }
  }
  // A script named for shipping, as in ./deploy.sh or python release.py, is opaque: ask.
  const script =
    SHELLS.has(name) || INTERPRETERS.has(name.replace(/[\d.]+$/, ''))
      ? command.slice(1).find((word) => !word.startsWith('-'))
      : command[0];
  if (script && SHIPPING_WORDS.has(stem(script))) return { kind: 'shipping' };
  if (segment.some((word) => SHIPPING_WORDS.has(word))) return { kind: 'shipping' };
  return null;
}

// A shell or interpreter that reads its script from a pipe, as in printf 'git push' | sh,
// runs the earlier stages' text: their operands are checked as script text.
function pipedScript(segments: string[][], operators: string[], index: number): Shipping | null {
  if (index === 0 || operators[index - 1] !== '|') return null;
  const command = runs(segments[index]!);
  const name = base(command[0] ?? '');
  const operands = command.slice(1).filter((word) => !word.startsWith('-'));
  const shell = SHELLS.has(name) && name !== 'eval' && !command.includes('-c') && !operands.length;
  const interpreter =
    INTERPRETERS.has(name.replace(/[\d.]+$/, '')) &&
    !command.some((word) => /^-(?:c|e|E|p)$|^--(?:eval|print)/.test(word)) &&
    operands.every((word) => word === '-');
  if (!shell && !interpreter) return null;
  let start = index - 1;
  while (start > 0 && operators[start - 1] === '|') start--;
  const text = segments
    .slice(start, index)
    .flatMap((stage) => stage.slice(1))
    .join('\n');
  const found = shell ? shippingKind(text) : scriptShipping(text);
  if (found) return found;
  const word = text.match(SHIPPING_TEXT)?.[1];
  return word
    ? {
        kind: 'uncertain',
        why: `It pipes text that mentions "${word}" into a program that runs it.`,
      }
    : null;
}

// Commit, merge, push and publish wait for the user's yes in every harness.
// This catches ordinary spellings, not every way a shell can hide a command:
// the hooks are guardrails, not a security boundary. Words of a parsed command are
// checked by position: quoted text stays one word, and the operands of a read are data.
// Heredoc bodies follow their receiver. Text the parser cannot read is matched on its
// plain words, after dropping comments, line continuations and the quotes and backslashes
// that could split a word like g\it, and is reported as uncertain unless it names a Git
// shipping verb. Script text handed to a shell, as in sh -c 'git push', is checked too.
export function shippingKind(
  text: string,
  readCommands: ReadCommand[] = [],
  root?: string,
): Shipping | null {
  const split = text.includes('<<') ? heredocs(text) : { command: text, bodies: [] };
  if (split) {
    for (const { receiver, body, expands, written } of split.bodies) {
      const command = runs(receiver);
      const name = base(command[0] ?? '');
      let found: Shipping | null;
      if (SHELLS.has(name) || (name === 'ssh' && command.length > 0)) {
        found = shippingKind(body, readCommands, root);
      } else if (INTERPRETERS.has(name.replace(/[\d.]+$/, '')) || INTERPRETERS.has(name)) {
        found = scriptShipping(body);
      } else if (
        (READERS.has(name) || name === 'tee') &&
        !(written && (RUNS_FILE.test(split.command) || SHELL_STARTUP.test(receiver.join(' '))))
      ) {
        found = null;
      } else {
        const word = words(body)
          .flat()
          .find((w) => SHIPPING_WORDS.has(w) || SHIPPING_GIT.has(w));
        found = word
          ? {
              kind: 'uncertain',
              why: written
                ? `It writes text that mentions "${word}" to a file that may run.`
                : `It passes text that mentions "${word}" to a program that may run it.`,
            }
          : null;
      }
      // Without a quoted delimiter the shell runs $( ) and backticks in the body first.
      if (!found && expands && /\$\(|`/.test(body)) {
        const expanded = words(body);
        if (expanded.some((s) => SHIPPING_GIT.has(gitVerb(s)!))) found = { kind: 'shipping' };
        else {
          const word = expanded.flat().find((w) => SHIPPING_WORDS.has(w));
          if (word) {
            found = {
              kind: 'uncertain',
              why: `Its heredoc runs command substitutions in text that mentions "${word}".`,
            };
          }
        }
      }
      if (found) return found;
    }
    const parsed = parse(split.command);
    if (parsed) {
      let result: Shipping | null = null;
      for (const [index, segment] of parsed.segments.entries()) {
        const found =
          pipedScript(parsed.segments, parsed.operators, index) ??
          segmentShipping(segment, readCommands, root);
        if (found?.kind === 'shipping') return found;
        result ??= found;
      }
      return result;
    }
  }
  const plain = words(split?.command ?? text);
  if (plain.some((s) => SHIPPING_GIT.has(gitVerb(s)!))) return { kind: 'shipping' };
  for (const s of plain) {
    const word = s.find((w) => SHIPPING_WORDS.has(w));
    if (word) {
      return {
        kind: 'uncertain',
        why: `Its shell text could not be fully parsed, and it contains the word "${word}".`,
      };
    }
  }
  return null;
}

export const isShipping = (text: string, readCommands: ReadCommand[] = [], root?: string) =>
  shippingKind(text, readCommands, root) !== null;

const READERS = new Set([
  'cat',
  'nl',
  'head',
  'tail',
  'ls',
  'pwd',
  'wc',
  'stat',
  'file',
  'which',
  'basename',
  'dirname',
  'readlink',
  'realpath',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'tr',
  'echo',
  'printf',
  'true',
  'false',
  'uname',
  'whoami',
  'id',
  'ps',
  'du',
  'df',
]);

// Expanded names can begin with '-', so globs are limited to readers whose
// options can neither write nor execute.
const GLOB_READERS = new Set([
  'cat',
  'nl',
  'head',
  'tail',
  'ls',
  'echo',
  'wc',
  'stat',
  'grep',
  'diff',
  'cmp',
  'ps',
  'du',
  'df',
]);

// Help and version output depend on the executable, so only vetted names
// qualify. The bundled halvard-team skill reads Herdr's help.
const HELP_READERS = new Set([
  ...READERS,
  'git',
  'rg',
  'grep',
  'find',
  'sed',
  'jq',
  'node',
  'npm',
  'herdr',
]);

const GIT_READS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'describe',
  'version',
  'show-ref',
  'grep',
  'rev-list',
  'merge-base',
  'check-ignore',
]);

const SED_ADDRESS = '(?:[0-9]+|\\$)(?:,(?:[0-9]+|\\$))?p';
const SED_PRINT = new RegExp(`^${SED_ADDRESS}(?:;${SED_ADDRESS})*$`);

// git branch only lists when every argument comes from this grammar. Filter options imply
// list mode, which makes later operands patterns; without list mode an operand names a
// branch to create. -l is left out: Git before 2.23 read it as --create-reflog.
const BRANCH_FLAGS = new Set([
  '-a',
  '--all',
  '-r',
  '--remotes',
  '-v',
  '-vv',
  '--verbose',
  '--list',
  '--show-current',
  '-i',
  '--ignore-case',
  '--color',
  '--no-color',
  '--no-abbrev',
  '--omit-empty',
  '--no-column',
]);
// Filters whose revision is optional (HEAD by default) or, for --points-at, required.
const BRANCH_FILTERS = new Set(['--merged', '--no-merged', '--contains', '--no-contains']);
const REVISION = /^[A-Za-z0-9_][\w./~^@-]*$/;
const BRANCH_PATTERN = /^[A-Za-z0-9_*?[\]][\w./*?[\]-]*$/;

export function branchListing(args: string[]) {
  let list = false;
  let current = false;
  const patterns: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const [name, value] = arg.includes('=')
      ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]
      : [arg, undefined];
    if (BRANCH_FLAGS.has(arg)) {
      if (arg === '--list') list = true;
      if (arg === '--show-current') current = true;
    } else if (name === '--color' && value !== undefined) {
      if (!['always', 'never', 'auto'].includes(value)) return false;
    } else if (name === '--abbrev' && value !== undefined) {
      if (!/^\d+$/.test(value)) return false;
    } else if (name === '--sort') {
      const key = value ?? args[++i];
      if (!key || !/^-?[a-z][\w:-]*$/.test(key)) return false;
    } else if (BRANCH_FILTERS.has(name)) {
      list = true;
      // Git takes the next word as the revision unless the option comes last.
      const revision = value ?? (i + 1 < args.length ? args[++i] : 'HEAD');
      if (!REVISION.test(revision!)) return false;
    } else if (name === '--points-at') {
      list = true;
      const revision = value ?? args[++i];
      if (!revision || !REVISION.test(revision)) return false;
    } else if (!arg.startsWith('-') && BRANCH_PATTERN.test(arg)) {
      patterns.push(arg);
    } else {
      return false;
    }
  }
  return !patterns.length || (list && !current);
}

// GNU and Git long options accept unambiguous abbreviations, so --out means --output.
const abbreviates = (arg: string, names: string[]) => {
  const name = arg.split('=')[0]!;
  return name.length > 2 && name.startsWith('--') && names.some((full) => full.startsWith(name));
};

// The selected repository's configuration can run code, so -C may only name
// the project itself.
function projectDirectory(path: string | undefined, root: string | undefined) {
  if (!path || !root || !isAbsolute(path)) return false;
  try {
    return realpathSync(path) === root;
  } catch {
    return false;
  }
}

function isRead(segment: string[], configured: ReadCommand[] = [], root?: string) {
  const [cmd, ...args] = segment;
  if (HELP_READERS.has(cmd!) && args.length === 1 && ['--help', '--version'].includes(args[0]!)) {
    return true;
  }
  if (cmd === 'command') {
    return args.length === 2 && ['-v', '-V'].includes(args[0]!) && !args[1]!.startsWith('-');
  }
  if (cmd === 'jq') {
    const filtered = ['jq'];
    for (let i = 0; i < args.length; i++) {
      if (['--arg', '--argjson'].includes(args[i]!)) {
        if (i + 2 >= args.length || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(args[i + 1]!)) return false;
        if (args[i]! === '--argjson') {
          try {
            JSON.parse(args[i + 2]!);
          } catch {
            return false;
          }
        }
        i += 2;
      } else {
        filtered.push(args[i]!);
      }
    }
    return configuredRead(
      filtered,
      {
        prefix: ['jq'],
        options: {
          '-r': 'flag',
          '--raw-output': 'flag',
          '-c': 'flag',
          '--compact-output': 'flag',
          '-s': 'flag',
          '--slurp': 'flag',
          '-n': 'flag',
          '--null-input': 'flag',
          '-e': 'flag',
          '--exit-status': 'flag',
          '-S': 'flag',
          '--sort-keys': 'flag',
        },
        positionals: { min: 1, max: Number.MAX_SAFE_INTEGER },
      },
      true,
    );
  }
  if (
    cmd === 'sort' &&
    args.some((a) => /^-[^-]*o/.test(a) || abbreviates(a, ['--output', '--compress-program']))
  ) {
    return false;
  }
  if (cmd === 'uniq') {
    return configuredRead(
      segment,
      {
        prefix: ['uniq'],
        options: {
          '-c': 'flag',
          '--count': 'flag',
          '-d': 'flag',
          '--repeated': 'flag',
          '-u': 'flag',
          '--unique': 'flag',
          '-i': 'flag',
          '--ignore-case': 'flag',
          '-z': 'flag',
          '--zero-terminated': 'flag',
          '-f': 'positiveInteger',
          '--skip-fields': 'positiveInteger',
          '-s': 'positiveInteger',
          '--skip-chars': 'positiveInteger',
        },
        positionals: { min: 0, max: 1 },
      },
      true,
    );
  } // Its second operand writes an output file.
  if (cmd === 'file' && args.some((a) => /^-[^-]*C/.test(a) || abbreviates(a, ['--compile']))) {
    return false;
  }
  if (READERS.has(cmd!)) return true;
  if (cmd === 'git') {
    const gitArgs = [...args];
    while (gitArgs.length) {
      if (['--no-pager', '--literal-pathspecs', '--no-optional-locks'].includes(gitArgs[0]!)) {
        gitArgs.shift();
        continue;
      }
      if (gitArgs[0]! === '-C') {
        if (!projectDirectory(gitArgs[1], root)) return false;
        gitArgs.splice(0, 2);
        continue;
      }
      break;
    }
    if (!gitArgs.length) return false;
    if (
      gitArgs.some((a) =>
        abbreviates(a, ['--output', '--ext-diff', '--textconv', '--open-files-in-pager']),
      )
    ) {
      return false;
    }
    if (gitArgs[0]! === 'grep' && gitArgs.some((a) => /^-[^-]*O/.test(a))) return false; // -O runs a pager command.
    if (gitArgs[0]! === 'remote') {
      return gitArgs.length === 1 || (gitArgs.length === 2 && gitArgs[1]! === '-v');
    }
    if (gitArgs[0]! === 'branch') return branchListing(gitArgs.slice(1));
    return GIT_READS.has(gitArgs[0]!);
  }
  if (cmd === 'rg') return !args.some((a) => /^--(pre|hostname-bin|pre-glob)(=|$)/.test(a));
  if (cmd === 'grep') return true;
  if (cmd === 'find') {
    return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint.*|fls)$/.test(a));
  }
  // GNU sed accepts options after the script, and -i or -e 'w file' writes.
  if (cmd === 'sed') {
    return (
      args[0]! === '-n' &&
      SED_PRINT.test(args[1]! ?? '') &&
      args.slice(2).every((a) => !a.startsWith('-'))
    );
  }
  // Extra flags can turn a reader into a writer (for example list + write).
  // Options must be part of the reviewed prefix; only positional operands follow.
  return configured.some((entry) => configuredRead(segment, entry));
}

function configuredRead(segment: string[], entry: ReadCommand, endOptions = false) {
  const prefix = Array.isArray(entry) ? entry : entry.prefix;
  if (!prefix.every((part, i) => segment[i]! === part)) return false;
  const args = segment.slice(prefix.length);
  if (Array.isArray(entry)) return args.every((part) => !part.startsWith('-'));
  let count = 0;
  let operands = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (endOptions && arg === '--' && !operands) {
      operands = true;
      continue;
    }
    if (operands || !arg.startsWith('-')) {
      count++;
      continue;
    }
    if (!Object.hasOwn(entry.options, arg)) return false;
    const type = entry.options[arg];
    if (type === 'flag') continue;
    const value = args[++i]!;
    if (
      !value ||
      value.startsWith('-') ||
      (type === 'positiveInteger' && !/^[1-9][0-9]*$/.test(value))
    ) {
      return false;
    }
  }
  return count >= entry.positionals.min && count <= entry.positionals.max;
}

const isCd = (segment: string[]) => segment[0]! === 'cd' && segment.length <= 2;

// A nested repository below the project supplies its own executable Git configuration.
function nestedRepository(dir: string, root: string) {
  for (let d = dir; d !== root && d.startsWith(root + '/'); d = dirname(d)) {
    if (existsSync(resolve(d, '.git'))) return true;
  }
  return false;
}

// The shell expands a leading ~ in cd and redirection targets.
function expandHome(path: string) {
  return path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
}

// cd follows the logical path by default, so .. undoes a symlink rather than
// leaving its target.
function changeDirectory(logical: string, operand: string | undefined) {
  const target = expandHome(operand ?? '~');
  if (target.startsWith('-') || target.startsWith('~')) return null;
  try {
    const next = resolve(logical, target);
    return statSync(next).isDirectory() ? next : null;
  } catch {
    return null;
  }
}

// True when a relative path's .. steps leave the starting directory at any point.
function climbs(depth: string, operand: string) {
  let level = depth ? depth.split('/').length : 0;
  for (const part of operand.split('/')) {
    if (part === '..') level--;
    else if (part && part !== '.') level++;
    if (level < 0) return true;
  }
  return false;
}

function physical(logical: string | null) {
  try {
    return logical && realpathSync(logical);
  } catch {
    return null;
  }
}

// Each segment runs where the cds before it lead; null where that is unknown.
// A cd counts only inside an unbroken && chain from the start of the command,
// where every later segment runs only after it succeeded. The first ;, ||, &
// or newline after a cd may follow a skipped or failed cd or end a background
// list, so the directory is unknown from there. The shell's logical starting
// directory is unknown too, so a relative cd may not climb above it.
function directories(
  segments: string[][],
  operators: string[],
  root: string | undefined,
  cwd: string | undefined,
) {
  const start = cwd ?? root ?? null;
  let logical = start;
  let anchored = false;
  let chained = true;
  let moved = false;
  return segments.map((segment, i) => {
    const here = physical(logical);
    if (isCd(segment)) {
      const operand = expandHome(segment[1] ?? '~');
      const next =
        logical && chained && ['', '&&'].includes(operators[i - 1] ?? '') && operators[i] === '&&'
          ? changeDirectory(logical, operand)
          : null;
      anchored ||= isAbsolute(operand);
      logical = next && (anchored || !climbs(relative(start!, logical!), operand)) ? next : null;
      moved = true;
    }
    if (!['', '&&', '|'].includes(operators[i]!)) {
      chained = false;
      if (moved) logical = null;
    }
    return here;
  });
}

// Built-in readers act the same anywhere. Git and configured commands load the
// configuration of the directory they run in, so they read only in the project
// and outside nested repositories.
function readsIn(
  segment: string[],
  dir: string | null,
  readCommands: ReadCommand[],
  root?: string,
) {
  if (isCd(segment)) return true;
  if (!root) return isRead(segment, readCommands, root);
  const contained = dir !== null && inside(root, dir) && !nestedRepository(dir, root);
  if (segment[0] === 'git') return contained && isRead(segment, readCommands, root);
  return isRead(segment, contained ? readCommands : [], root);
}

// A redirection writes the project unless its target is provably outside it.
// Only absolute and ~/ targets qualify, so no directory guess decides a write.
// The kernel applies .. after following a symlink, path resolution before it.
// Team workspace files keep their one-writer rule, which only file tools check.
function writesOutside(path: string, root: string) {
  const target = expandHome(path);
  if (!isAbsolute(target) || target.split('/').includes('..')) return false;
  const base = workspaceRoot();
  return (
    outsideProject(root, root, target) &&
    !inside(existsSync(base) ? realpathSync(base) : base, physicalPath(target))
  );
}

// A redirection into Halvard's own data outside the workspace. Only absolute and ~/ targets
// are known; the command stops for approval like any it cannot classify.
function writesHalvardData(path: string, root?: string, dir?: string | null) {
  const target = expandHome(path);
  if (!isAbsolute(target) && !dir) return false;
  const real = (folder: string) => (existsSync(folder) ? realpathSync(folder) : folder);
  const physical = physicalPath(resolve(dir ?? '/', target));
  // A factory worktree lies under the factory folder; its own files are project files.
  if (root && inside(real(root), physical) && !projectHoldsData(root)) return false;
  if (inside(real(workspaceRoot()), physical)) return false;
  return protectedRoots().some((folder) => inside(real(folder), physical));
}

// git -C naming the project root runs exactly as plain git there.
export function rootGit(segment: string[], root?: string, cwd?: string) {
  if (!root || segment[0] !== 'git' || segment[1] !== '-C' || !segment[2]) return segment;
  try {
    return realpathSync(resolve(cwd ?? root, segment[2])) === root
      ? ['git', ...segment.slice(3)]
      : segment;
  } catch {
    return segment;
  }
}

function leavesBranch(segment: string[], root?: string, cwd?: string) {
  segment = rootGit(segment, root, cwd);
  if (segment[0]! !== 'git') return false;
  const [verb, ...args] = segment.slice(1);
  if (!['checkout', 'switch'].includes(verb!) || args.includes('--')) return false;
  if (args.length === 1) return /^[A-Za-z0-9][\w./-]*$/.test(args[0]!);
  return (
    args.length === 2 && ['-b', '-c'].includes(args[0]!) && /^[A-Za-z0-9][\w./-]*$/.test(args[1]!)
  );
}

export function shellKind(
  text: string,
  readCommands: ReadCommand[],
  root?: string,
  cwd?: string,
): ShellKind {
  const parsed = parse(text);
  if (!parsed) return 'opaque';
  if (!parsed.comment) return classify(parsed, readCommands, root, cwd);
  // A commented command is a read only if it also reads when '#' is a plain
  // word: trailing comment words become arguments, and a segment starting
  // with '#' is a missing command that runs nothing. Never a branch exemption.
  if (classify(parsed, readCommands, root, cwd) !== 'read') return 'mutation';
  const plain = parse(text, false);
  const kept = plain?.segments.map((segment) => !segment[0]!.startsWith('#'));
  const segments = plain?.segments.filter((_, i) => kept![i]);
  return plain &&
    segments?.length &&
    classify(
      { ...plain, segments, operators: plain.operators.filter((_, i) => kept![i]) },
      readCommands,
      root,
      cwd,
    ) === 'read'
    ? 'read'
    : 'opaque';
}

function classify(
  {
    segments,
    operators,
    glob,
    redirects,
  }: {
    segments: string[][];
    operators: string[];
    glob: boolean;
    redirects: { segment: number; path: string }[];
  },
  readCommands: ReadCommand[],
  root?: string,
  cwd?: string,
): ShellKind {
  const dirs = directories(segments, operators, root, cwd);
  let kind: ShellKind;
  if (glob) {
    kind = segments.every((s, index) => {
      if (isCd(s) || GLOB_READERS.has(s[0]!)) return true;
      // Path-prefixed patterns cannot expand into options. Bare patterns need --.
      const delimiter = s.indexOf('--');
      // Only recognize a delimiter after operands or known argument-free flags.
      const flags = new Set([
        '-n',
        '--line-number',
        '--no-pager',
        '--literal-pathspecs',
        '--no-optional-locks',
      ]);
      const endOptions =
        s[0]! !== 'find' &&
        delimiter > 0 &&
        s.slice(1, delimiter).every((arg) => !arg.startsWith('-') || flags.has(arg))
          ? delimiter
          : -1;
      const safe = s.every(
        (arg, i) =>
          !/[*?[\]]/.test(arg) ||
          (i > 0 &&
            ((endOptions > 0 && i > endOptions) ||
              arg.slice(0, arg.search(/[*?[\]]/)).includes('/'))),
      );
      // Only built-ins with safe multiple operands: expansion can multiply arguments.
      return (
        ['rg', 'find', 'git', 'sort', 'sed'].includes(s[0]!) &&
        safe &&
        readsIn(s, dirs[index] ?? null, readCommands, root)
      );
    })
      ? 'read'
      : 'opaque';
  } else if (segments.every((s, i) => readsIn(s, dirs[i] ?? null, readCommands, root))) {
    kind = 'read';
  } else {
    const leaves = (s: string[], i: number) => {
      const dir = dirs[i] ?? null;
      return (!root || (dir !== null && inside(root, dir))) && leavesBranch(s, root, dir ?? cwd);
    };
    kind =
      segments.some(leaves) &&
      segments.every(
        (s, i) =>
          leaves(s, i) ||
          // The runtime checks checkout names in the root, so a cd may lead only there.
          (isCd(s) && (!root || dirs[i + 1] === root)) ||
          // A git read rides along with the switch, which runs that repository's configuration anyway.
          (!isCd(s) &&
            (s[0] === 'git'
              ? isRead(s, readCommands, root)
              : readsIn(s, dirs[i] ?? null, readCommands, root))),
      )
        ? 'branch'
        : 'mutation';
  }
  if (!redirects.length) return kind;
  if (redirects.some((r) => writesHalvardData(r.path, root, dirs[r.segment] ?? cwd))) {
    return 'opaque';
  }
  // Writing outside the project is governed by the harness, as for file tools.
  return kind === 'read' && root && redirects.every((r) => writesOutside(r.path, root))
    ? 'outside'
    : kind === 'opaque'
      ? kind
      : 'mutation';
}
