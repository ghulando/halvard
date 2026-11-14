// The task on a branch, for the watchtower's task card. Halvard keeps one Markdown file per
// task in the repository's task folder, with metadata naming its branch:
//   <!-- halvard {"version":1,"title":"...","branch":"feature/x",...} -->
// Only the repository's .halvard.json is read for the folder; personal settings are not.

import { exec, readTextFile } from "herdr";

const METADATA = /^<!-- halvard (.+) -->$/m;

async function taskFolder(root) {
  try {
    const folder = JSON.parse((await readTextFile(`${root}/.halvard.json`)) ?? "null")?.workflow?.taskDirectory;
    return typeof folder === "string" && folder ? folder : "docs/tasks";
  } catch {
    return "docs/tasks";
  }
}

// The first paragraph under a "## <heading>" line, or null.
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start < 0) return null;
  const body = text.slice(start + heading.length + 5).split(/\n## /)[0].trim();
  return body.split(/\n\s*\n/)[0].replace(/\s+/g, " ").trim() || null;
}

// { file, title, status, next } for the task whose metadata names this branch, or null.
// Like Halvard, the most recently changed file wins when two tasks name one branch.
export async function readTask(root, branch) {
  if (!root || !branch) return null;
  const folder = `${root}/${await taskFolder(root)}`;
  // The mod file API has no stat, so ls orders the files by change time.
  const listed = await exec("ls", ["-t", folder]);
  if (listed.code !== 0) return null;
  const names = listed.stdout.split("\n").filter((name) => name.endsWith(".md"));
  for (const name of names) {
    const text = await readTextFile(`${folder}/${name}`);
    const match = text?.match(METADATA);
    if (!match) continue;
    let metadata;
    try {
      metadata = JSON.parse(match[1]);
    } catch {
      continue;
    }
    if (metadata?.branch !== branch) continue;
    return {
      file: name,
      title: text.match(/^# (.+)$/m)?.[1] ?? metadata.title ?? name,
      status: text.match(/^\*\*Status:\*\* (.+?)\.?$/m)?.[1] ?? null,
      next: section(text, "Next step"),
    };
  }
  return null;
}
