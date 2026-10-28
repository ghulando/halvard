import type { FlowConfig, ReadCommand } from '../types.ts';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { authors, providers, reviewerChoices } from './reviewers.ts';
import { personalRoot } from './paths.ts';

export function flowConfig(input: unknown = {}): FlowConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('workflow must be an object');
  }
  const defaults: FlowConfig = {
    taskDirectory: 'docs/tasks',
    baseBranch: 'main',
    featurePrefix: 'feature/',
    fixPrefix: 'fix/',
    requireReview: true,
    reviewers: {},
    reviewTimeout: 900,
    reviewExclude: [],
    reviewContext: [],
    reviewExceptions: {},
    reviewDeferrals: {},
    stacks: null,
  };
  // shellApproval is accepted from older configurations; shell commands no longer ask.
  const { shellApproval, ...settings } = input as Record<string, unknown>;
  for (const key of Object.keys(settings)) {
    if (!Object.hasOwn(defaults, key)) throw new Error(`unknown workflow setting: ${key}`);
  }
  if (shellApproval !== undefined && !['workflow', 'native'].includes(shellApproval as string)) {
    throw new Error('invalid workflow shellApproval');
  }
  const value = { ...defaults, ...settings } as FlowConfig;
  for (const key of ['taskDirectory', 'baseBranch', 'featurePrefix', 'fixPrefix'] as const) {
    if (
      typeof value[key] !== 'string' ||
      !value[key] ||
      value[key].includes('\0') ||
      /[\r\n]/.test(value[key])
    ) {
      throw new Error(`invalid workflow ${key}`);
    }
  }
  if (
    value.taskDirectory.startsWith('/') ||
    value.taskDirectory.split('/').some((part) => part === '..' || !part)
  ) {
    throw new Error('taskDirectory must be a relative directory');
  }
  if (typeof value.requireReview !== 'boolean') throw new Error('requireReview must be boolean');
  // A home-relative path lets teammates share one project setting.
  if (
    value.stacks !== null &&
    (typeof value.stacks !== 'string' ||
      !(value.stacks.startsWith('/') || value.stacks.startsWith('~/')) ||
      /[\r\n\0]/.test(value.stacks))
  ) {
    throw new Error('stacks must be an absolute or ~/ directory path');
  }
  for (const key of ['reviewExclude', 'reviewContext'] as const) {
    if (
      !Array.isArray(value[key]) ||
      value[key].some(
        (path) =>
          typeof path !== 'string' ||
          !path ||
          path.startsWith('/') ||
          path.split('/').includes('..'),
      )
    ) {
      throw new Error(`${key} must contain repo-relative patterns`);
    }
  }
  if (
    !Number.isInteger(value.reviewTimeout) ||
    value.reviewTimeout < 1 ||
    value.reviewTimeout > 3600
  ) {
    throw new Error('reviewTimeout must be 1..3600 seconds');
  }
  if (
    !value.reviewExceptions ||
    typeof value.reviewExceptions !== 'object' ||
    Array.isArray(value.reviewExceptions)
  ) {
    throw new Error('reviewExceptions must be an object');
  }
  for (const [task, exception] of Object.entries(value.reviewExceptions)) {
    if (
      !task ||
      task.startsWith('/') ||
      task.split('/').some((part) => !part || part === '..') ||
      /[\r\n\0]/.test(task) ||
      !exception ||
      typeof exception !== 'object' ||
      Array.isArray(exception) ||
      Object.keys(exception).some((key) => !['maxRound', 'reason'].includes(key)) ||
      !Number.isInteger(exception.maxRound) ||
      exception.maxRound < 3 ||
      exception.maxRound > 10 ||
      typeof exception.reason !== 'string' ||
      !exception.reason.trim()
    ) {
      throw new Error('invalid task review exception');
    }
  }
  if (
    !value.reviewDeferrals ||
    typeof value.reviewDeferrals !== 'object' ||
    Array.isArray(value.reviewDeferrals)
  ) {
    throw new Error('reviewDeferrals must be an object');
  }
  // Each entry is a user decision, so it lives in configuration the guard asks before editing.
  for (const [task, deferrals] of Object.entries(value.reviewDeferrals)) {
    if (
      !task ||
      task.startsWith('/') ||
      task.split('/').some((part) => !part || part === '..') ||
      /[\r\n\0]/.test(task) ||
      !Array.isArray(deferrals) ||
      deferrals.some(
        (deferral) =>
          !deferral ||
          typeof deferral !== 'object' ||
          Array.isArray(deferral) ||
          Object.keys(deferral).some(
            (key) => !['finding', 'approvedBy', 'reason', 'override'].includes(key),
          ) ||
          typeof deferral.finding !== 'string' ||
          !/^round(?:[1-9]|10)#[1-9][0-9]*$/.test(deferral.finding) ||
          ['approvedBy', 'reason'].some(
            (key) =>
              typeof deferral[key as 'approvedBy' | 'reason'] !== 'string' ||
              !deferral[key as 'approvedBy' | 'reason'].trim() ||
              /[\r\n\0]/.test(deferral[key as 'approvedBy' | 'reason']),
          ) ||
          (deferral.override !== undefined && deferral.override !== true),
      ) ||
      new Set(deferrals.map((deferral) => deferral.finding)).size !== deferrals.length
    ) {
      throw new Error('invalid task review deferral');
    }
  }
  if (!value.reviewers || typeof value.reviewers !== 'object' || Array.isArray(value.reviewers)) {
    throw new Error('reviewers must be an object');
  }
  for (const [key, settings] of Object.entries(value.reviewers)) {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new Error('invalid reviewer');
    }
    // An entry with `reviewer` is keyed by author and assigns that author's reviewer.
    const assigned = settings.reviewer !== undefined;
    const name = assigned ? settings.reviewer! : key;
    if (assigned) {
      if (!authors.includes(key)) throw new Error(`reviewer assignment for unknown author ${key}`);
      if (typeof name !== 'string' || !providers.includes(name)) {
        throw new Error(`invalid reviewer for author ${key}`);
      }
      if (name === key ? !settings.model : !reviewerChoices[key]!.includes(name)) {
        throw new Error(
          name === key
            ? `${key} reviewing its own work requires an explicit model`
            : `${name} cannot review work by ${key}`,
        );
      }
    } else if (!providers.includes(key)) {
      throw new Error('invalid reviewer');
    }
    if (
      Object.keys(settings).some(
        (field) =>
          field !== 'model' &&
          !(assigned && field === 'reviewer') &&
          !(name === 'ollama' && field === 'transport'),
      ) ||
      (settings.model !== undefined &&
        (typeof settings.model !== 'string' ||
          !settings.model ||
          settings.model.startsWith('-') ||
          /[\r\n\0]/.test(settings.model)))
    ) {
      throw new Error(`invalid ${name} reviewer settings`);
    }
    if (settings.transport !== undefined && !['cli', 'pi'].includes(settings.transport)) {
      throw new Error('Ollama transport must be cli or pi');
    }
    if (name === 'ollama' && !settings.model) throw new Error('Ollama requires an explicit model');
  }
  return value;
}

// personal.json holds workflow settings plus read commands trusted in every repo.
// Projects validate the read commands together with their own.
export function personalSettings(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('personal configuration must be an object');
  }
  const { readCommands = [], ...workflow } = input as Partial<FlowConfig> & {
    readCommands?: ReadCommand[];
  };
  // The guard asks before project configuration edits but not before personal ones.
  const { reviewDeferrals } = workflow;
  if (
    reviewDeferrals &&
    typeof reviewDeferrals === 'object' &&
    Object.keys(reviewDeferrals).length
  ) {
    throw new Error('reviewDeferrals belong in project configuration');
  }
  flowConfig(workflow);
  return { workflow, readCommands };
}

export function personalConfig() {
  const file = resolve(personalRoot(), 'personal.json');
  if (!existsSync(file)) return { workflow: {}, readCommands: [] };
  if (statSync(file).size > 64 * 1024) throw new Error('personal configuration is oversized');
  return personalSettings(JSON.parse(readFileSync(file, 'utf8')));
}
