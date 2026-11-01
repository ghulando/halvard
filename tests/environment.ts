import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

// Personal preferences must not alter fixtures or packaged-install verification.
const previous = process.env.HALVARD_HOME;
const home = mkdtempSync(join(tmpdir(), 'workflow-suite-personal-'));

process.env.HALVARD_HOME = home;

after(() => {
  if (previous === undefined) {
    delete process.env.HALVARD_HOME;
  } else {
    process.env.HALVARD_HOME = previous;
  }
  rmSync(home, { recursive: true, force: true });
});

// Task commands create team workspaces; keep them out of the real home directory.
const previousWorkspace = process.env.HALVARD_WORKSPACE;
const workspace = mkdtempSync(join(tmpdir(), 'workflow-suite-workspace-'));

process.env.HALVARD_WORKSPACE = workspace;

after(() => {
  if (previousWorkspace === undefined) {
    delete process.env.HALVARD_WORKSPACE;
  } else {
    process.env.HALVARD_WORKSPACE = previousWorkspace;
  }
  rmSync(workspace, { recursive: true, force: true });
});

// The data root holds config, workspace and factory folders; keep it out of the real home.
const previousData = process.env.HALVARD_DATA;
const data = mkdtempSync(join(tmpdir(), 'workflow-suite-data-'));

process.env.HALVARD_DATA = data;

after(() => {
  if (previousData === undefined) {
    delete process.env.HALVARD_DATA;
  } else {
    process.env.HALVARD_DATA = previousData;
  }
  rmSync(data, { recursive: true, force: true });
});
