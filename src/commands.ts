import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { CommandInfo } from './host-contract.js';

// Host 0.19.0 owns these names even when their optional backend capability is absent.
// goal has a verified native fall-through. plan is also translated by the host
// as a mode toggle, so its distinct native workflow needs an unambiguous alias.
const local = new Set(`new clear compact resume rename recap rewind tree fork export btw trace agentview bg background context status cost config reload settings setup star doctor migrate init agents team jobs panel activity preset theme color lang model effort thinking tokens balance provider login logout add-dir hooks mcp skills plugin update vim terminal-setup connect workspace home help tips kernel dsh codex claude restart exit quit q deepseek permission channel plan`.split(' '));
const cliOnly = new Set(`permissions resume switch conversation restore load clear model effort context mcp skills add-dir agents artifact btw changelog codesearch cs search copy credits diff feedback fork branch hooks keybindings logout open plugin plugins rename remote-control rewind undo reload statusline tasks title usage quota voice record config settings help exit quit goal compact schedule browser plan grill-me teamwork learn boost a11y-debugging agy-customizations antigravity-guide chrome-devtools chrome-extensions cookie-debugging debug-optimize-lcp gemini-api-dev gemini-live-api-dev gemini-omni-flash-api memory-leak-debugging modern-web-guidance run-workflow swarm troubleshooting`.split(' '));

export class Commands {
  private entries: CommandInfo[] = [];
  private routes = new Map<string, string>();
  private seen = new Set<string>();
  private native = new Set<string>();
  constructor(private debug: (text: string) => void) {}
  replace(commands: AvailableCommand[]): void {
    this.entries = []; this.routes.clear(); this.native.clear();
    const native = new Map<string, AvailableCommand>();
    for (const command of commands) {
      const name = command.name.replace(/^\//, '');
      const key = name.toLowerCase();
      if (!/^[a-z0-9_.:\/-]+$/iu.test(name) || native.has(key)) { this.debug(`无效或重复的原生命令：${name.slice(0,100)}`); continue; }
      native.set(key, { ...command, name }); this.seen.add(key);
      this.native.add(key);
    }
    const occupied = new Set([...native.keys(), 'agy-commands', ...local]);
    for (const [key, command] of native) {
      if (key === 'compact') continue; // exact typed equivalent, not a second prompt alias
      let name = command.name;
      if (local.has(key) || key === 'agy-commands') {
        name = `agy:${command.name}`;
        while (occupied.has(name.toLowerCase())) name = `agy:${name}`;
      }
      occupied.add(name.toLowerCase()); this.seen.add(name.toLowerCase());
      this.routes.set(name.toLowerCase(), command.name);
      this.entries.push({ name, description: `${name === command.name ? '' : `原生 /${command.name} · `}${command.description}`, argumentHint: command.input?.hint });
    }
  }
  list(): readonly CommandInfo[] { return [...this.entries, { name: 'agy-commands', description: '查看统一指令、当前原生命令与 CLI 能力缺口（离线）' }]; }
  has(native: string): boolean { return this.native.has(native); }
  route(text: string): { text: string; local?: true; error?: string } {
    const match = /^\s*\/([^\s]+)([\s\S]*)$/.exec(text);
    if (!match) return { text };
    const key = match[1].toLowerCase();
    if (key === 'agy-commands') return { text, local: true };
    const native = this.routes.get(key);
    // Typed host commands must never accidentally be submitted as model text.
    if (native) return { text: text.replace(/^(\s*)\/[^\s]+/, `$1/${native}`) };
    if (local.has(key) || cliOnly.has(key) || this.seen.has(key) || key.startsWith('agy:')) return { text, error: `/${match[1]} 当前不能从 ACP 执行；输入已保留。请使用 dsh-tui 对应入口，或 /agy-commands 查看原因与官方 CLI 入口。` };
    return { text };
  }
  report(): string {
    return ['Antigravity 统一指令', '/model · /effort · /permission：原生配置；/resume · /bg · /background：宿主会话管理器。',
      '/new：新建原生会话；/clear：仅清显示。/compact：仅在原生公布后执行；/context：原生总用量（无细分）。',
      '计划模式用 /permission plan；原生规划工作流用菜单中的 /agy:plan（公布后可用）。宿主 /context 把总量行归在“系统提示词”标题下，该行实际为全会话总量。',
      `本会话原生命令：${this.entries.map(c => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`).join('、') || '尚未公布'}`,
      '/mcp：ACP 未提供活动服务器状态接口；请在官方终端用 agy mcp 管理配置。/skills：宿主技能目录不等于 agy 已加载技能；请在官方 agy 终端查看。',
      'agy 登录、安装/更新、插件、配额、远程控制和启动参数仍由官方 CLI 管理；不会通过模型文字模拟。',
      '完整覆盖清单：docs/design/T02-command-mapping.md（随插件分发）。'].join('\n');
  }
  clear(): void { this.entries = []; this.routes.clear(); this.seen.clear(); this.native.clear(); }
}
