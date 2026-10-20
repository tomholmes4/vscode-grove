import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Mirrors the `gt-branch-name` tool (which itself mirrors the Graphite CLI's
// generateBranchName, gt 1.8.6): replaceUnsupportedCharacters, slash collapsing,
// lowercasing, and removeUnsupportedTrailingCharacters, then branchPrefix + a
// MM-DD- date prefix. Ported here so the extension needs no external process.
const UNSUPPORTED_CHARACTERS = /[^-_/.a-zA-Z0-9]+/g;
const SLASHES = /\/+/g;
const UNSUPPORTED_TRAILING_CHARACTERS = /[/.]*$/;

const USER_CONFIG_PATH = path.join(os.homedir(), '.config', 'graphite', 'user_config');

export interface BranchNameConfig {
  branchPrefix?: string;
  branchDate?: boolean;
  branchReplacement?: string;
  allowSlashesInGeneratedBranchNames?: boolean;
  allowUpperCaseInGeneratedBranchNames?: boolean;
}

const DEFAULT_CONFIG: Required<BranchNameConfig> = {
  branchPrefix: '',
  branchDate: true,
  branchReplacement: '_',
  allowSlashesInGeneratedBranchNames: false,
  allowUpperCaseInGeneratedBranchNames: false,
};

/** Reads the Graphite user config, returning {} if it is missing or invalid. */
export function readGraphiteUserConfig(configPath = USER_CONFIG_PATH): BranchNameConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  try {
    return JSON.parse(raw) as BranchNameConfig;
  } catch {
    return {};
  }
}

function sanitizeMessage(message: string, config: Required<BranchNameConfig>): string {
  let name = message.replace(UNSUPPORTED_CHARACTERS, config.branchReplacement);
  if (!config.allowSlashesInGeneratedBranchNames) {
    name = name.replace(SLASHES, config.branchReplacement);
  }
  if (!config.allowUpperCaseInGeneratedBranchNames) {
    name = name.toLowerCase();
  }
  return name.replace(UNSUPPORTED_TRAILING_CHARACTERS, '');
}

function datePrefix(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${month}-${day}-`;
}

/**
 * Formats a free-text task description into a Graphite-style branch name.
 * Throws when the message is empty. Mirrors `gt branch create` naming.
 */
export function generateBranchName(
  message: string,
  config: BranchNameConfig = readGraphiteUserConfig(),
  date = new Date()
): string {
  if (!message || !message.trim()) {
    throw new Error('Must specify a task description to generate a branch name.');
  }
  const merged: Required<BranchNameConfig> = { ...DEFAULT_CONFIG, ...config };
  const prefix = merged.branchPrefix || '';
  const dated = merged.branchDate ? datePrefix(date) : '';
  return `${prefix}${dated}${sanitizeMessage(message, merged)}`;
}
