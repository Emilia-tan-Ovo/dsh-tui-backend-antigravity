import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionInfo } from '@agentclientprotocol/sdk';
import { Acp, actionable } from './acp.js';
import { executable, type CliOptions } from './cli.js';
import { deadline } from './process.js';
import type { BackendHost, SessionListScope, SessionSummary } from './host-contract.js';

export class CatalogUnavailable extends Error {}
/** agy 1.5.9 lists Windows directories as encoded file-URL pathnames. */
export function nativeCwd(value: string): string {
  if (/^file:\/\//i.test(value)) return fileURLToPath(value);
  if (process.platform === 'win32' && /^\/[a-z](?::|%3a)\//i.test(value)) return fileURLToPath(`file://${value}`);
  // A normal native path can contain literal percent characters; decode only
  // the unambiguous URL forms, never an ordinary Windows/POSIX path.
  return value;
}
export const sameCwd = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(nativeCwd(a)).toLowerCase() === resolve(nativeCwd(b)).toLowerCase() : resolve(nativeCwd(a)) === resolve(nativeCwd(b));

export async function listSessions(host: BackendHost, options: CliOptions, scope: SessionListScope = {},
  record: (row: SessionInfo) => void, onPartial?: (rows: readonly SessionSummary[]) => void, ms = 20000): Promise<SessionSummary[]> {
  const cwd = scope.allProjects ? undefined : scope.cwd ?? host.cwd;
  const acp = new Acp({ executable: await executable(options), args: options.args ?? ['acp'], cwd: host.cwd, env: options.env }, {
    update() {}, permission: async () => ({ outcome: { outcome: 'cancelled' } }), fatal() {}, diagnostic: (text) => host.debug(text),
  }, options.processFactory);
  try {
    return await deadline(Promise.race([acp.died, (async () => {
      const init = await acp.initialize(ms);
      if (!init.agentCapabilities?.sessionCapabilities?.list) throw new CatalogUnavailable('此 agy 版本未公布 session/list；无法列出原生会话。');
      const rows = new Map<string, SessionSummary>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await acp.connection.agent.request('session/list', { cwd, cursor });
        for (const native of page.sessions) {
          const row = { ...native, cwd: nativeCwd(native.cwd) };
          if (!isAbsolute(row.cwd) || !row.sessionId) throw new Error('原生目录缺少有效会话身份或绝对工作目录。');
          if (cwd && !sameCwd(row.cwd, cwd)) continue;
          record(row);
          const time = row.updatedAt ? Date.parse(row.updatedAt) : 0;
          rows.set(row.sessionId, { id: row.sessionId, backendId: 'antigravity', kind: { kind: 'root' }, title: { text: row.title || row.sessionId, source: row.title ? 'auto' : 'fallback' }, cwd: row.cwd,
            createdAt: 0, updatedAt: Number.isFinite(time) ? time : 0, bytes: undefined, hasPrompt: true,
            agentPreset: undefined, model: undefined, label: undefined, branch: undefined, childCount: 0 });
        }
        onPartial?.([...rows.values()]);
        cursor = page.nextCursor ?? undefined;
        if (cursor && cursors.has(cursor)) throw new Error('原生会话目录重复分页 cursor，目录未完整加载。');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return [...rows.values()];
    })()]), ms, 'Antigravity 会话目录');
  } catch (error) { if (error instanceof CatalogUnavailable) throw error; throw new Error(actionable(error, '会话目录')); }
  finally { await acp.dispose(); }
}
