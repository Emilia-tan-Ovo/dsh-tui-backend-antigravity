import type { AgentBackend, BackendHost, SessionListScope } from './host-contract.js';
import type { SessionInfo, SessionNotification } from '@agentclientprotocol/sdk';
import { Acp, actionable, type AcpHandlers } from './acp.js';
import { detectCli, executable, type CliOptions } from './cli.js';
import { Session, type SessionOverlay } from './session.js';
import { Prefs } from './prefs.js';
import { CatalogUnavailable, listSessions, sameCwd } from './catalog.js';
import { deadline } from './process.js';
import { accessProfile, withAccess, type AccessProfile } from './access.js';

export interface BackendOptions extends CliOptions { openMs?: number; cancelMs?: number; configMs?: number; catalogMs?: number; resumeMs?: number }
export function createBackend(options: BackendOptions = {}, prepareOverlay?: () => Promise<SessionOverlay | undefined>): AgentBackend {
  let currentHost: BackendHost;
  const stores = new Map<string | undefined, Prefs>();
  const known = new Map<string, string>();
  const remember = (row: Pick<SessionInfo, 'sessionId' | 'cwd'>) => { known.set(row.sessionId, row.cwd); };
  const capture = (host: BackendHost): Prefs => {
    currentHost = host;
    let store = stores.get(host.dataDir);
    if (!store) { store = new Prefs(host); stores.set(host.dataDir, store); }
    return store;
  };
  const readHost = (): BackendHost => currentHost ?? { cwd: process.cwd(), locale: () => 'zh', debug() {}, warn() {} };
  const list = (scope?: SessionListScope, onPartial?: Parameters<NonNullable<AgentBackend['catalog']>['list']>[1]) =>
    listSessions(readHost(), options, scope, remember, onPartial, options.catalogMs);
  return {
    id: 'antigravity', descriptor: { label: 'Antigravity' },
    catalog: { list, info: async (id, cwd) => (await list(cwd ? { cwd } : { allProjects: true })).find(row => row.id === id) },
    launch: {
      sessionPrefs: (host) => {
        const prefs = capture(host);
        return { lastSession: () => prefs.last(host.cwd),
          setLastSession: (id) => { const cwd = known.get(id); if (cwd) prefs.mark(id, cwd); },
          touch: (id) => { const cwd = known.get(id); if (cwd) prefs.mark(id, cwd); },
          forget: (id) => prefs.forget(id, known.get(id)) };
      },
      resumeCommand: (id) => `dsh-tui --backend antigravity --resume ${JSON.stringify(id)}`,
    },
    detect: (host) => { capture(host); return detectCli(host.cwd, options); },
    async open(target, host) {
      const prefs = capture(host);
      const end = Date.now() + (target.kind === 'create' ? options.openMs ?? 15000 : options.resumeMs ?? 30000);
      const remaining = () => { const ms = end - Date.now(); if (ms <= 0) throw new Error('Antigravity 打开会话超时。'); return ms; };
      let cwd = target.cwd;
      let acp: Acp | undefined;
      let session: Session | undefined;
      let abandoned = false;
      const early: SessionNotification[] = [];
      let failure: Error | undefined;
      try {
        return await deadline((async () => {
          const access = accessProfile(options.env ?? process.env);
          const sessionOverlay = await prepareOverlay?.();
          if (target.kind === 'resume') {
            let rows;
            try { rows = await listSessions(host, options, cwd ? { cwd } : { allProjects: true }, remember, undefined, remaining()); }
            catch (error) { if (!(error instanceof CatalogUnavailable) || !cwd) throw error; }
            if (rows) {
              const row = rows.find(r => r.id === target.sessionId);
              if (!row) throw new Error(`找不到原生会话 ${target.sessionId}${cwd ? `（目录 ${cwd}）` : ''}；未新建替代会话。`);
              if (cwd && !sameCwd(cwd, row.cwd)) throw new Error(`会话 ${target.sessionId} 工作目录不一致；未恢复。`);
              cwd = row.cwd;
            }
          }
          if (!cwd) throw new Error('原生会话缺少工作目录，无法安全恢复。');
          remaining();
          const binary = await executable(options);
          if (abandoned) throw new Error('打开会话已结束。');
          const sessionCwd = cwd;
          const transport = {
            start: (profile: AccessProfile | undefined, handlers: AcpHandlers) =>
              new Acp({ executable: binary, args: withAccess(options.args ?? ['acp'], profile), cwd: sessionCwd, env: options.env }, handlers, options.processFactory),
            overlay: sessionOverlay, resumeMs: options.resumeMs ?? 30000,
          };
          const original: Acp = acp = transport.start(access, {
            update: (params) => {
              if (session) { if (session.receives(original)) session.update(params); }
              else if (early.length < 256) early.push(params);
              else { failure = new Error('初始化更新过多，已拒绝建立会话。'); void acp?.dispose(); }
            },
            permission: (params, signal) => session?.receives(original) ? session.permission(params, signal) : Promise.resolve({ outcome: { outcome: 'cancelled' } }),
            fatal: (error) => { failure = error; if (session?.receives(original)) session.fatal(error); }, diagnostic: (text) => host.debug(text),
          });
          const init = await acp.initialize(remaining());
          const overlay = sessionOverlay?.(init);
          if (target.kind === 'resume') {
            if (!init.agentCapabilities?.loadSession) throw new Error(`agy 未公布 loadSession；无法恢复 ${target.sessionId} 的历史。`);
            session = new Session(cwd, { sessionId: target.sessionId }, acp, host, options.cancelMs, prefs, true, options.configMs, access, transport);
            const result = await Promise.race([acp.died, acp.connection.agent.request('session/load', { sessionId: target.sessionId, cwd, mcpServers: [], ...overlay })]);
            if (failure) throw failure;
            await session.ready(result);
          } else {
            const result = await Promise.race([acp.died, acp.connection.agent.request('session/new', { cwd, mcpServers: [], ...overlay })]);
            if (failure) throw failure;
            session = new Session(cwd, result, acp, host, options.cancelMs, prefs, false, options.configMs, access, transport);
            for (const update of early) session.update(update);
            await session.ready(result);
          }
          if (abandoned || failure || session.status === 'disposed') throw failure ?? new Error('会话准备已取消或失败。');
          remember({ sessionId: session.ref.sessionId, cwd });
          return session;
        })(), remaining(), target.kind === 'resume' ? `恢复 Antigravity 会话 ${target.sessionId}` : 'Antigravity 新建会话');
      } catch (error) {
        abandoned = true;
        if (session) await session.dispose(); else await acp?.dispose();
        throw new Error(`${target.kind === 'resume' ? `恢复 ${target.sessionId} 失败（未另建会话）：` : ''}${actionable(error, target.kind === 'resume' ? `会话 ${target.sessionId}` : '新建会话')}`);
      }
    },
  };
}
