import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// Focusing an already-open window is only possible through the `code` CLI: its
// main-process entrypoint de-duplicates by folder root and raises the existing
// window. The extension API (vscode.openFolder) cannot raise a sibling window,
// so we shell out. `code <path>` focuses if open (else reuses the current
// window); `code -n <path>` always opens a new window.

export function focusOrOpenWindow(
  targetPath: string,
  openInNewWindow: boolean,
  onError: (message: string) => void
): void {
  const args = openInNewWindow ? ['-n', targetPath] : [targetPath];
  execFile(codeBinary(), args, (err) => {
    if (err) {
      onError(`Failed to run code CLI (${args.join(' ')}): ${err.message}`);
    }
  });
}

function codeBinary(): string {
  // Prefer the CLI bundled with this exact install so a stable window never
  // drives an Insiders instance (or vice versa).
  const isInsiders = vscode.env.appName.includes('Insiders');
  const bundled = path.join(vscode.env.appRoot, 'bin', isInsiders ? 'code-insiders' : 'code');
  if (fs.existsSync(bundled)) {
    return bundled;
  }
  return isInsiders ? 'code-insiders' : 'code';
}
