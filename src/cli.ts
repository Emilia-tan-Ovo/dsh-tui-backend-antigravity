import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { BackendDetection } from './host-contract.js';
import { deadline, redact, startOwned, type ProcessFactory } from './process.js';

export interface CliOptions { executable?: string; args?: string[]; env?: NodeJS.ProcessEnv; processFactory?: ProcessFactory; probeMs?: number }
export async function executable(options: CliOptions = {}): Promise<string> {
  // Explicit constructor injection is internal; product configuration accepts a binary, not shell text.
  const explicit = options.executable ?? (options.env ?? process.env).DSH_TUI_AGY_COMMAND;
  if (explicit !== undefined) {
    if (!isAbsolute(explicit) || !/\.exe$/i.test(explicit)) throw new Error('DSH_TUI_AGY_COMMAND 必须是官方 agy CLI .exe 的绝对路径（不含引号或参数）。');
    await access(explicit, constants.F_OK); return resolve(explicit);
  }
  for (const dir of ((options.env ?? process.env).PATH ?? '').split(delimiter)) {
    const path = join(dir, 'agy.exe');
    try { await access(path, constants.F_OK); return resolve(path); } catch { /* next PATH entry */ }
  }
  throw new Error('找不到 agy CLI。请安装官方 Antigravity CLI，并重开终端；或设置 DSH_TUI_AGY_COMMAND 为 agy.exe 的绝对路径。');
}

export async function detectCli(cwd: string, options: CliOptions = {}): Promise<BackendDetection> {
  let version: string | undefined;
  try {
    const binary = await executable(options);
    const probe = async (args: string[]) => {
      const child = (options.processFactory ?? startOwned)({ executable: binary, args, cwd, env: options.env });
      let output = '';
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output = (output + data.toString('utf8')).slice(-16384); });
      try {
        const exit = await deadline(child.exited, options.probeMs ?? 5000, 'CLI 检测');
        if (exit.error) throw exit.error;
        if (exit.code !== 0) throw new Error(`CLI 检测退出 ${exit.code}：${redact(output).slice(-1000)}`);
        return output;
      } finally { await child.dispose(); }
    };
    const value = await probe(['--version']);
    version = value.match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
    if (!version) throw new Error('无法识别官方 CLI 版本；请确认不是 IDE 启动器。');
    const [major, minor] = version.split('.').map(Number);
    if (major < 1 || (major === 1 && minor < 5)) return { installed: false, version, stale: true, hint: '请升级至支持原生 ACP 的 agy CLI（至少 1.5.0）。' };
    const help = await probe(['acp', '--help']);
    if (!/\bacp\b/i.test(help) || !/stdio|agent client protocol/i.test(help)) return { installed: false, version, stale: true, hint: '此 agy 不支持原生 ACP；请安装官方 CLI，而非 IDE 启动器。' };
    return { installed: true, auth: 'unknown', version, hint: '认证将在新建会话时由 CLI 检查；需要时先在终端运行 agy 完成官方登录。' };
  } catch (error) {
    return { installed: false, version, hint: redact(error instanceof Error ? error.message : String(error)) };
  }
}
