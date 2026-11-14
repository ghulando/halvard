// The task on a branch, for the watchtower's task card. Halvard keeps one Markdown file per
// task in the repository's task folder, with metadata naming its branch:
//   <!-- halvard {"version":1,"title":"...","branch":"feature/x",...} -->
// Only the repository's .halvard.json is read for the folder; personal settings are not.

import { exec, readTextFile } from "herdr";
import { parseTask } from "./rules.js";

async function taskFolder(root) {
  try {
    const folder = JSON.parse((await readTextFile(`${root}/.halvard.json`)) ?? "null")?.workflow?.taskDirectory;
    return typeof folder === "string" && folder ? folder : "docs/tasks";
  } catch {
    return "docs/tasks";
  }
}

// The last lookup per repository and branch: the folder's files newest first, and the index
// of the one that matched (-1 for none) with its task. An edit makes a file the newest, so
// while the order is the same only the newest file can have changed.
const last = new Map();

// { file, title, status, next } for the task whose metadata names this branch, or null.
// Like Halvard, the most recently changed file wins when two tasks name one branch.
export async function readTask(root, branch) {
  if (!root || !branch) return null;
  const folder = `${root}/${await taskFolder(root)}`;
  // The mod file API has no stat, so ls orders the files by change time.
  const listed = await exec("ls", ["-t", folder]);
  if (listed.code !== 0) return null;
  const names = listed.stdout.split("\n").filter((name) => name.endsWith(".md"));
  const key = `${folder}\n${branch}`;
  const read = async (name) => {
    const task = parseTask(await readTextFile(`${folder}/${name}`), branch, name);
    return task ? { file: name, ...task } : null;
  };
  const before = last.get(key);
  let found = -1;
  let task = null;
  let start = 0;
  if (before && before.names.join("\n") === names.join("\n") && names.length) {
    task = await read(names[0]);
    if (task) found = 0;
    else if (before.found > 0) [found, task] = [before.found, before.task];
    // The newest file no longer names the branch: an older task may now be the newest.
    else start = before.found === 0 ? 1 : names.length;
  }
  for (let i = start; i < names.length && found < 0; i++) {
    task = await read(names[i]);
    if (task) found = i;
  }
  if (last.size >= 64 && !last.has(key)) last.clear();
  last.set(key, { names, found, task });
  return task;
}
