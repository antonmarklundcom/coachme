import { execFile } from 'node:child_process';
import { redact } from './redact.js';
export interface RunOptions { cwd?: string; timeout?: number; maxBuffer?: number }
export type Exec = (cmd: string, args: string[], opts?: RunOptions) => Promise<string>;
export const run: Exec = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeout ?? 30_000, maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
    if (error) reject(new Error(redact(error.message)));
    else resolve(stdout);
  });
});
