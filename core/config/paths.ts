import { homedir } from 'node:os';
import { resolve } from 'node:path';

export const personalRoot = () =>
  resolve(process.env.HALVARD_HOME || resolve(homedir(), '.config/halvard'));

// Team briefs and reports live here, one folder per repository and task.
export const workspaceRoot = (home = homedir()) =>
  resolve(process.env.HALVARD_WORKSPACE || resolve(home, '.halvard'));
