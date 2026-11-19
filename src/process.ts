import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface Launch { executable: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }
export interface ProcessExit { code: number | null; signal: string | null; error?: Error }
export interface OwnedProcess {
  stdin: ChildProcessWithoutNullStreams['stdin'];
  stdout: ChildProcessWithoutNullStreams['stdout'];
  stderr: ChildProcessWithoutNullStreams['stderr'];
  exited: Promise<ProcessExit>;
  dispose(): Promise<void>;
}
export type ProcessFactory = (launch: Launch) => OwnedProcess;

export const startOwned: ProcessFactory = (launch) => {
  if (process.platform !== 'win32') throw new Error('首版只支持 Windows + PowerShell 7。');
  const encoded = Buffer.from(JSON.stringify({ ...launch, env: undefined, parentPid: process.pid })).toString('base64');
  const child = spawn('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
    fileURLToPath(new URL('../scripts/windows-job-host.ps1', import.meta.url)), '-Launch', encoded],
  { cwd: launch.cwd, env: launch.env ?? process.env, windowsHide: true, stdio: 'pipe' });
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => resolve({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  // A pipe can error during teardown before the SDK has attached its reader.
  child.stdin.on('error', () => {});
  let disposal: Promise<void> | undefined;
  return { stdin: child.stdin, stdout: child.stdout, stderr: child.stderr, exited,
    dispose() {
      return disposal ??= (async () => {
        child.stdin.destroy();
        child.kill(); // Only this helper: closing its private Job kills the tree.
        await deadline(exited, 1500, '释放 Antigravity Job host');
        child.stdout.destroy(); child.stderr.destroy();
      })();
    },
  };
};

export function redact(text: string): string {
  return text.replace(/(bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|token|api[_-]?key|authorization|password)["']?\s*[=:]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

/** Redact whole logical lines so a token split across pipe chunks stays secret. */
export class DiagnosticTail {
  private tail = '';
  private line = '';
  private overflow = false;
  append(text: string): void {
    for (const part of text.split(/(\n)/)) {
      if (part === '\n') {
        this.tail = (this.tail + (this.overflow ? '[stderr line truncated]' : redact(this.line)) + '\n').slice(-4096);
        this.line = ''; this.overflow = false;
      } else if (!this.overflow) {
        this.line += part;
        if (this.line.length > 4096) { this.line = ''; this.overflow = true; }
      }
    }
  }
  get text(): string { return (this.tail + (this.overflow ? '[stderr line truncated]' : redact(this.line))).slice(-4096); }
}

export async function deadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
    })]);
  } finally { clearTimeout(timer!); }
}
