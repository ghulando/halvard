import type { PackageMetadata, PackageStatus } from './types.ts';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Shipped content, including modes, defines identity. Never follow package symlinks.
export function packageDigest(root: string) {
  root = realpathSync(root);
  const parsed: unknown = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const metadata = parsed as PackageMetadata;
  if (metadata.name !== 'halvard' || !Array.isArray(metadata.files)) {
    throw new Error('not an halvard package');
  }
  const hash = createHash('sha256');
  const add = (value: string | Buffer) => {
    const bytes = Buffer.from(value);
    hash.update(`${bytes.length}:`);
    hash.update(bytes);
  };
  const visit = (path: string) => {
    if (
      typeof path !== 'string' ||
      path.startsWith('/') ||
      path.split('/').some((part) => !part || part === '..' || part === '.')
    ) {
      throw new Error('invalid shipped package path');
    }
    for (let count = 1; count <= path.split('/').length; count++) {
      const ancestor = resolve(root, ...path.split('/').slice(0, count));
      if (lstatSync(ancestor).isSymbolicLink()) {
        throw new Error(`unsupported shipped package symlink: ${path}`);
      }
    }
    const file = resolve(root, path);
    const stat = lstatSync(file);
    add(path);
    add(String(stat.mode & 0o777));
    if (stat.isDirectory()) {
      for (const entry of readdirSync(file).sort()) visit(`${path}/${entry}`);
    } else if (stat.isFile()) {
      add(readFileSync(file));
    } else {
      throw new Error(`unsupported shipped package entry: ${path}`);
    }
  };
  for (const path of [...new Set([...metadata.files, 'package.json'])].sort()) visit(path);
  return hash.digest('hex');
}

export function packageStatus(source: string, target: string): PackageStatus {
  const expected = packageDigest(source);
  try {
    const actual = packageDigest(target);
    return { path: target, matches: actual === expected, expected, actual };
  } catch (err) {
    return {
      path: target,
      matches: false,
      expected,
      error: (err as NodeJS.ErrnoException).message,
    };
  }
}
