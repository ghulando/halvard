import type { InstallationPlan } from './types.ts';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  rmdirSync,
} from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { packageDigest } from './package.ts';

// Stage before replacing anything. Roll back reported IO failures, retaining backups
// if rollback itself fails. This is not a cross-filesystem crash-atomic transaction.
export function applyInstallation({
  source,
  copy,
  writes,
  link,
  replace = false,
}: InstallationPlan) {
  const files: {
    path: string;
    dir: string;
    temporary: string;
    backup: string;
    before: Buffer | null;
    mode: number;
    applied: boolean;
    oldMoved: boolean;
  }[] = [];
  const directories: string[] = [];
  let staged: string | undefined;
  let previous: string | undefined;
  let swapped = false;
  let linked = false;
  let committed = false;
  let rolledBack = false;
  const ensure = (dir: string): void => {
    if (existsSync(dir)) return;
    ensure(dirname(dir));
    mkdirSync(dir);
    directories.push(dir);
  };
  const rollback = () => {
    if (linked) rmSync(link!.path);
    for (const file of [...files].reverse()) {
      if (file.applied) rmSync(file.path);
      if (file.oldMoved) renameSync(file.backup, file.path);
    }
    if (swapped) rmSync(copy!.destination, { recursive: true, force: true });
    if (previous && existsSync(previous)) renameSync(previous, copy!.destination);
  };
  try {
    if (copy) {
      ensure(dirname(copy.destination));
      staged = mkdtempSync(copy.destination + '.next-');
      for (const path of copy.files) {
        cpSync(resolve(source, path), resolve(staged, path), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
      }
      if (packageDigest(staged) !== packageDigest(source)) {
        throw new Error('package changed during staging; retry installation');
      }
    }
    for (const write of writes) {
      ensure(dirname(write.path));
      const path = existsSync(write.path)
        ? realpathSync(write.path)
        : resolve(realpathSync(dirname(write.path)), basename(write.path));
      if (files.some((file) => file.path === path)) {
        throw new Error('installation writes the same physical path twice');
      }
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat && !stat.isFile()) throw new Error(`installation target is not a file: ${path}`);
      const dir = mkdtempSync(resolve(dirname(path), `.${basename(path)}.workflow-`));
      const file = {
        path,
        dir,
        temporary: resolve(dir, 'next'),
        backup: resolve(dir, 'previous'),
        before: Object.hasOwn(write, 'before') ? write.before : stat ? readFileSync(path) : null,
        mode: (stat?.mode ?? 0) & 0o777,
        applied: false,
        oldMoved: false,
      };
      files.push(file);
      writeFileSync(file.temporary, write.content, { mode: stat ? file.mode : 0o600, flag: 'wx' });
      if (stat) chmodSync(file.temporary, file.mode);
    }
    for (const file of files) {
      const current = existsSync(file.path) ? readFileSync(file.path) : null;
      if (
        (file.before === null) !== (current === null) ||
        (current && !current.equals(file.before!))
      ) {
        throw new Error('settings changed during staging; retry installation');
      }
    }
    if (copy) {
      if (replace) {
        previous = staged + '.previous';
        renameSync(copy.destination, previous);
      } else if (existsSync(copy.destination)) {
        throw new Error('package appeared during staging; retry installation');
      }
      renameSync(staged!, copy.destination);
      swapped = true;
    }
    for (const file of files) {
      if (file.before !== null) {
        renameSync(file.path, file.backup);
        file.oldMoved = true;
      }
      renameSync(file.temporary, file.path);
      file.applied = true;
    }
    if (link) {
      symlinkSync(link.target, link.path, 'dir');
      linked = true;
    }
    committed = true;
  } catch (err) {
    try {
      rollback();
      rolledBack = true;
    } catch (rollbackError) {
      throw new AggregateError(
        [err, rollbackError],
        'installation failed and rollback needs attention; staging backups were retained',
      );
    }
    throw err;
  } finally {
    // If rollback failed, leave evidence and backups for the user.
    if (committed || rolledBack) {
      const cleanup = (path: string) => {
        try {
          rmSync(path, { recursive: true, force: true });
        } catch (err) {
          if (!committed) throw err;
          process.stderr.write(
            `workflow: installation committed; cleanup failed at ${path}: ${(err as NodeJS.ErrnoException).message}\n`,
          );
        }
      };
      if (staged) cleanup(staged);
      for (const file of files) cleanup(file.dir);
      if (committed && previous) cleanup(previous);
      if (!committed) {
        for (const dir of directories.reverse()) {
          try {
            rmdirSync(dir);
          } catch (err) {
            if (
              !['ENOTEMPTY', 'ENOENT', 'EEXIST'].includes(
                (err as NodeJS.ErrnoException).code as string,
              )
            ) {
              throw err;
            }
          }
        }
      }
    }
  }
}
