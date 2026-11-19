import { randomUUID } from 'node:crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import type { ContentBlock, InitializeResponse, LoadSessionRequest, LoadSessionResponse, NewSessionResponse, PromptResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentSession, AgentSessionStatus, AgentInput, BackendHost, CancelCause, CancelReceipt, ContentBlockView, SessionCapabilities, SubmitPlacement, TurnEndReason } from './host-contract.js';
import { Acp, actionable, type AcpHandlers } from './acp.js';
import { Permissions } from './permissions.js';
import { Projection } from './projection.js';
import { deadline } from './process.js';
import { Commands } from './commands.js';
import { Options } from './options.js';
import { Prefs, type Choice } from './prefs.js';
import { IMAGE_LIMITS, inputBlocks, promptBlocks, routedBlocks } from './images.js';
import { accessDescription, accessLabel, accessProfiles, accessSummary, isAccessProfile, isUnsandboxedMode, type AccessProfile } from './access.js';

export type SessionOverlay = (init: InitializeResponse) => Pick<LoadSessionRequest, '_meta'>;

interface SessionTransport {
  start: (profile: AccessProfile | undefined, handlers: AcpHandlers) => Acp;
  overlay?: SessionOverlay;
  resumeMs: number;
}

interface Active {
  submitted: boolean;
  projection: NonNullable<Projection['active']>;
  terminal: Promise<boolean>;
  resolve: (confirmed: boolean) => void;
  reason?: TurnEndReason;
}

export class Session implements AgentSession {
  readonly ref;
  capabilities: SessionCapabilities;
  private state: AgentSessionStatus = 'idle';
  private projection: Projection;
  private permissions: Permissions;
  private ledger = new Map<string, string>();
  private active?: Active;
  private cancelling?: Promise<CancelReceipt>;
  private disposal?: Promise<void>;
  private closing = false;
  private gate = false;
  private lastUncertain: string[] = [];
  private generation = randomUUID();
  private preparing: boolean;
  private options: Options;
  private commands: Commands;
  private usage?: { used: number; max: number };
  private bound = false;
  private reading?: AbortController;
  private switchFrom?: Acp;
  private candidate?: Acp;
  constructor(readonly cwd: string, response: NewSessionResponse, private acp: Acp, private host: BackendHost,
    private cancelMs = 5000, private prefs?: Prefs, loading = false, private configMs = 15000, private access?: AccessProfile,
    private transport?: SessionTransport) {
    this.preparing = loading;
    this.ref = { backendId: 'antigravity', sessionId: response.sessionId };
    this.projection = new Projection(response.sessionId, cwd, response, (text) => host.debug(text), loading);
    this.commands = new Commands((text) => host.debug(text));
    this.options = new Options(event => {
      if (event.type !== 'mode.changed') this.projection.emit(event);
      else if (!this.switchFrom) this.announceMode();
    }, (id) => { this.projection.model = id; });
    this.options.apply(response);
    this.permissions = new Permissions(this.generation, this.projection.emit, (waiting) => {
      if (this.active && !this.closing) this.statusTo(waiting ? 'requires-action' : 'running');
    });
    this.capabilities = {
      native: {},
      ...(this.acp.initialized?.agentCapabilities?.promptCapabilities?.image ? { images: { limits: IMAGE_LIMITS } } : {}),
      permissions: { respond: (id, answer) => this.permissions.respond(id, answer), pending: () => this.permissions.pending() },
      questions: { respond: (id, answer) => this.permissions.answer(id, answer), cancel: (id) => this.permissions.cancel(id) },
      effort: this.effortCapability(),
      commands: { list: async () => this.commands.list() },
      compact: { run: () => this.compact() },
      context: { usage: async () => {
        if (!this.usage) throw new Error('尚未收到 Antigravity 原生上下文用量；未提供构成细分。');
        return { ...this.usage, categories: [{ name: '原生总用量（未提供细分）', tokens: this.usage.used, kind: 'used' }] };
      } },
      diagnostics: { lines: () => [`Antigravity ACP v1；原生会话 ${this.ref.sessionId}`, `模型：${this.projection.model}`,
        ...(this.access ? [accessDescription(this.access)] : []), this.commands.report(), ...this.acp.stderr ? [this.acp.stderr] : []] },
    };
  }
  private effortCapability(): NonNullable<SessionCapabilities['effort']> {
    const options = this.options;
    // The host snapshots command availability at bind time. Keep the route,
    // but read its ladder from the current native model, including no ladder.
    return {
      get levelsAvailable() { return options.has('thought_level'); },
      levels: () => options.choices('thought_level').map(v => ({ id: v.value, label: v.name })),
      current: () => this.confirmedEffort(),
      set: async (id) => {
        if (id === null) throw new Error('Antigravity 未公布默认思考档位，无法重置；请选择实际档位。');
        await this.configure('thought_level', id);
      },
    };
  }
  async ready(response: LoadSessionResponse): Promise<void> {
    this.options.apply(response); this.projection.endReplay(); this.preparing = false;
    const options = this.options;
    const access = this.access;
    this.capabilities = { ...this.capabilities,
      ...(options.has('model') ? { models: {
        list: async () => options.choices('model').filter(v => /^gemini(?:[-_.]|$)/i.test(v.value)).map(v => ({ id: v.value, label: v.name, description: v.description ?? undefined })),
        current: () => ({ model: options.current('model') ?? '' }), display: () => options.display(),
        set: async (ref: { model: string; provider?: string }) => {
          if (ref.provider && ref.provider !== 'antigravity') return { kind: 'refused' as const, reason: '模型不属于 Antigravity。' };
          try { await this.configure('model', ref.model); return { kind: 'switched' as const }; }
          catch (error) { return { kind: 'refused' as const, reason: actionable(error) }; }
        },
      } } : {}),
      ...(options.has('mode') ? { modes: {
        list: () => {
          const native = options.choices('mode').map(v => ({ id: v.value, label: v.name, description: v.description ?? undefined }));
          const profiles = this.canSwitchAccess() ? accessProfiles : this.access ? [this.access] : [];
          // Keep both profiles on the first page of the host's five-row picker.
          native.splice(Math.max(0, native.length - 1), 0, ...profiles.map(id => ({
            id, label: accessLabel(id), description: accessSummary(id),
          })));
          return native;
        },
        cycle: () => options.choices('mode').filter(v => ['default','plan'].includes(v.value)).map(v => ({ id: v.value, label: v.name })),
        current: () => this.currentMode(), set: (id: string) => this.setMode(id),
      } } : {}),
    };
    const saved = this.prefs?.restore(this.ref.sessionId) ?? {};
    const applied: string[] = [];
    try {
      for (const category of ['model','thought_level','mode'] as const) {
        // Auto would re-enable the sandbox. Leave the saved daily choice
        // intact so an ordinary reopen restores it.
        const value = access && category === 'mode' && saved.mode === 'auto' ? 'default' : saved[category];
        if (value !== undefined) {
          // Effort belongs to the selected model. Old records could retain the
          // previous model's effort; keep the confirmed native value and tell
          // the user instead of making their entire conversation inaccessible.
          if (category === 'thought_level' && !options.choices(category).some(v => v.value === value)) {
            const current = this.confirmedEffort();
            this.projection.emit({ type: 'notice', level: 'warning', text: `当前模型 ${options.current('model')} 不支持保存的思考档位 ${value}；沿用原生档位 ${current ?? '未提供'}，未发送不支持的档位设置。` });
            this.prefs?.reconcileEffort(this.ref.sessionId, current);
            continue;
          }
          options.validate(category, value);
          if (options.current(category) !== value) { await this.configure(category, value, false); applied.push(`${category}=${value}`); }
        }
      }
    } catch (error) { throw new Error(`恢复会话 ${this.ref.sessionId} 的保存配置失败${applied.length ? `；原生已应用 ${applied.join(', ')}` : ''}：${actionable(error)}`); }
    if (access) {
      if (options.current('mode') === 'auto') await this.configure('mode', 'default', false);
      if (!isUnsandboxedMode(options.current('mode'))) throw new Error(`${access} 无法确认 AGY 执行模式；移除 DSH_TUI_AGY_ACCESS 可按日常权限重开。`);
      this.projection.emit({ type: 'notice', level: access === 'full-access' ? 'warning' : 'info', text: accessDescription(access) });
    }
  }
  private currentMode(): string { return this.access ?? this.options.current('mode') ?? ''; }
  private announceMode(): void { this.projection.emit({ type: 'mode.changed', modeId: this.currentMode() }); }
  receives(acp: Acp): boolean { return this.acp === acp && this.switchFrom !== acp; }
  private canSwitchAccess(): boolean {
    return !!this.transport && this.acp.initialized?.agentCapabilities?.loadSession === true
      && this.options.choices('mode').some(v => v.value === 'default');
  }
  private async setMode(id: string): Promise<void> {
    this.requireIdle();
    if (isAccessProfile(id)) {
      if (id !== this.access) await this.switchAccess(id, 'default');
    } else if (this.access) {
      this.options.validate('mode', id);
      await this.switchAccess(undefined, id);
      if (!this.closing) this.prefs?.confirm(this.ref.sessionId, 'mode', id);
    } else await this.configure('mode', id);
  }
  private requireIdle(): void {
    if (this.closing || this.preparing || this.active || this.gate || this.cancelling) throw new Error('会话正在运行、准备或停止，未更改配置；请等待空闲。');
  }
  private async switchAccess(access: AccessProfile | undefined, mode: string): Promise<void> {
    if (!this.canSwitchAccess()) throw new Error('当前 AGY 未公布会话恢复能力，无法切换启动权限。');
    const old = this.switchFrom = this.acp;
    const previousMode = this.options.current('mode');
    const choices = { model: this.options.current('model'), thought_level: this.confirmedEffort() };
    this.gate = true;
    try {
      // Close before loading again: two ACP processes must not own one conversation.
      await this.closeNative(old);
      await old.dispose();
      try {
        await this.reconnect(access, { ...choices, mode });
      } catch (error) {
        if (this.closing || this.candidate) throw error; // A failed release must not start a second owner.
        const reason = actionable(error);
        try { await this.reconnect(this.access, { ...choices, mode: previousMode }); }
        catch (restoreError) {
          const message = `权限切换失败：${reason}；原连接未恢复：${actionable(restoreError)}。请用 /resume 恢复原会话。`;
          this.fatal(new Error(message));
          throw new Error(message);
        }
        throw new Error(`权限切换失败，已恢复原权限：${reason}`);
      }
    } catch (error) {
      if (!this.closing && this.acp === old) this.fatal(new Error(`未能重新连接原会话：${actionable(error)}。请用 /resume 重试。`));
      throw error;
    } finally { this.switchFrom = undefined; this.gate = false; }
  }
  private async reconnect(access: AccessProfile | undefined, choices: Partial<Record<Choice, string | undefined>>): Promise<void> {
    if (this.closing) throw new Error('会话已关闭。');
    const transport = this.transport!;
    const end = Date.now() + transport.resumeMs;
    const remaining = () => Math.max(1, end - Date.now());
    const staged = new Options(() => {}, () => {});
    const { sessionId } = this.ref;
    let commands: Extract<SessionNotification['update'], { sessionUpdate: 'available_commands_update' }> | undefined;
    let usage: Extract<SessionNotification['update'], { sessionUpdate: 'usage_update' }> | undefined;
    let failure: Error | undefined;
    const candidate = this.candidate = transport.start(access, {
      update: (params) => {
        if (this.receives(candidate)) return this.update(params);
        if (params.sessionId !== sessionId) return;
        // The journal is already on screen. Only stage the connection's control metadata.
        const update = params.update;
        if (update.sessionUpdate === 'config_option_update') staged.apply({ configOptions: update.configOptions });
        else if (update.sessionUpdate === 'current_mode_update') staged.mode(update.currentModeId);
        else if (update.sessionUpdate === 'available_commands_update') commands = update;
        else if (update.sessionUpdate === 'usage_update') usage = update;
      },
      permission: (params, signal) => {
        if (this.receives(candidate)) return this.permission(params, signal);
        if (params.sessionId === sessionId) failure = new Error('重连期间收到执行审批，已拒绝。');
        return Promise.resolve({ outcome: { outcome: 'cancelled' } });
      },
      fatal: error => { if (this.receives(candidate)) this.fatal(error); else failure = error; },
      diagnostic: text => this.host.debug(text),
    });
    try {
      const init = await candidate.initialize(remaining());
      if (!init.agentCapabilities?.loadSession) throw new Error('AGY 未公布 loadSession。');
      const overlay = transport.overlay?.(init);
      const load = candidate.connection.agent.request('session/load', { sessionId, cwd: this.cwd, mcpServers: [], ...overlay });
      staged.apply(await deadline(Promise.race([load, candidate.died]), remaining(), '重连原 Antigravity 会话'));
      if (failure || this.closing) throw failure ?? new Error('会话已关闭。');
      for (const category of ['model', 'thought_level', 'mode'] as const) {
        const value = choices[category];
        if (value === undefined) continue;
        staged.validate(category, value);
        if (staged.current(category) !== value) {
          staged.apply(await this.requestChoice(candidate, staged, category, value, Math.min(remaining(), this.configMs)));
          if (staged.current(category) !== value) throw new Error(`原生未确认 ${category}=${value}。`);
        }
      }
      if (failure || this.closing) throw failure ?? new Error('会话已关闭。');
      this.access = access;
      this.acp = candidate;
      this.capabilities = { ...this.capabilities, images: init.agentCapabilities?.promptCapabilities?.image ? { limits: IMAGE_LIMITS } : undefined };
      this.options.adopt(staged);
      if (commands) this.update({ sessionId, update: commands });
      if (usage) this.update({ sessionId, update: usage });
      if (!this.closing) {
        this.announceMode();
        if (access) this.projection.emit({ type: 'notice', level: access === 'full-access' ? 'warning' : 'info', text: accessDescription(access) });
      }
    } finally {
      if (this.acp !== candidate) await candidate.dispose();
      if (this.candidate === candidate) this.candidate = undefined;
    }
  }
  private confirmedEffort(): string | undefined {
    const current = this.options.current('thought_level');
    return this.options.choices('thought_level').some(v => v.value === current) ? current : undefined;
  }
  private async configure(category: Choice, value: string, save = true): Promise<void> {
    this.requireIdle();
    if (this.access && category === 'mode' && !isUnsandboxedMode(value)) throw new Error('Auto 会重新启用终端沙箱；要使用 Auto，请移除 DSH_TUI_AGY_ACCESS 后重开。');
    this.options.validate(category, value);
    this.gate = true;
    try {
      const result = await this.requestChoice(this.acp, this.options, category, value, this.configMs);
      if (this.closing) throw new Error('配置响应到达时会话已结束；不保存过期结果。');
      this.options.apply(result);
      if (this.closing) throw new Error('配置确认期间会话已结束；不保存过期结果。');
      if (this.options.current(category) !== value) throw new RequestError(-32000, `原生未确认 ${category}=${value}，保留实际返回状态。`);
      if (save && !(this.access && category === 'mode')) {
        if (category === 'model') this.prefs?.confirmModel(this.ref.sessionId, value, this.confirmedEffort());
        else this.prefs?.confirm(this.ref.sessionId, category, value);
      }
    } catch (error) {
      if (!(error instanceof RequestError)) this.fatal(new Error(`配置写入结果未知；会话 ${this.ref.sessionId} 已关闭：${actionable(error)}`));
      throw error;
    } finally { this.gate = false; }
  }
  private requestChoice(acp: Acp, options: Options, category: Choice, value: string, ms: number): Promise<LoadSessionResponse> {
    const { sessionId } = this.ref;
    const select = options.select(category);
    const request = select ? acp.connection.agent.request('session/set_config_option', { sessionId, configId: select.id, value }).then(r => ({ configOptions: r.configOptions })) :
      acp.connection.agent.request('session/set_mode', { sessionId, modeId: value }).then(() => ({ modes: { currentModeId: value,
        availableModes: options.choices('mode').map(v => ({ id: v.value, name: v.name, description: v.description })) } }));
    return deadline(Promise.race([request, acp.died]), ms, '确认 Antigravity 配置');
  }
  private async compact(): Promise<void> {
    if (!this.commands.has('compact')) throw new Error('Antigravity 当前未公布 /compact；未发送请求。');
    if (this.active || this.gate || this.cancelling || this.closing || this.preparing) throw new Error('会话尚未空闲，未执行压缩。');
    const before = this.projection.compactionCount;
    const result = await this.send({ text: '/compact', clientMessageId: `compact:${randomUUID()}` }, 'turn', true);
    if (!result.accepted) throw new Error('reason' in result ? result.reason : '压缩未接受');
    const active = this.active as Active | undefined;
    if (!active || !await active.terminal || active.reason?.kind !== 'completed') throw new Error('原生压缩命令未成功结束；请检查会话记录。');
    if (!this.closing && this.projection.compactionCount === before) this.projection.emit({ type: 'notice', level: 'info', text: '原生 /compact 命令已结束；尚未报告压缩结果或上下文替换。' });
  }
  get status(): AgentSessionStatus { return this.state; }
  private statusTo(status: Exclude<AgentSessionStatus, 'starting'>): void {
    if (this.state === status) return;
    this.state = status; this.projection.emit({ type: 'session.status', status });
  }
  history: AgentSession['history'] = () => this.projection.history();
  subscribe: AgentSession['subscribe'] = (listener) => {
    const first = !this.bound; this.bound = true;
    const unsubscribe = this.projection.subscribe(listener);
    // Host 0.19.0 replays history through its projector, not through selector
    // controls. Re-announce the current ID at the live handover so /new and
    // /resume also refresh the display label instead of retaining the old one.
    const model = this.options.current('model') ?? this.projection.model;
    if (first && !this.closing) {
      this.projection.emit({ type: 'model.changed', model, source: 'resume' });
      if (this.access) this.announceMode();
    }
    return unsubscribe;
  };
  update(params: SessionNotification): void {
    if (this.closing || params.sessionId !== this.ref.sessionId) return;
    const update = params.update;
    if (update.sessionUpdate === 'config_option_update') this.options.apply({ configOptions: update.configOptions });
    else if (update.sessionUpdate === 'current_mode_update') this.options.mode(update.currentModeId);
    else if (update.sessionUpdate === 'available_commands_update') {
      this.commands.replace(update.availableCommands); this.projection.emit({ type: 'commands.changed', commands: this.commands.list() });
    } else if (update.sessionUpdate === 'usage_update') {
      this.usage = { used: update.used, max: update.size };
      this.projection.emit({ type: 'context.capacity', contextWindow: update.size });
      this.projection.emit({ type: 'context.usage', ...this.usage });
    } else this.projection.update(update);
  }
  permission(params: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> {
    if (this.preparing && params.sessionId === this.ref.sessionId) this.fatal(new Error('加载历史期间收到执行审批，已拒绝并停止恢复原目标。'));
    if (this.closing || this.cancelling || !this.active || params.sessionId !== this.ref.sessionId) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const prior = this.projection.toolState(params.toolCall.toolCallId);
    const toolCall = { ...prior, ...Object.fromEntries(Object.entries(params.toolCall).filter(([, v]) => v !== undefined)) } as RequestPermissionRequest['toolCall'];
    return this.permissions.request({ ...params, toolCall }, this.projection.callId(this.active.projection, toolCall.toolCallId), signal);
  }
  async submit(input: AgentInput, placement: SubmitPlacement) {
    return this.send(input, placement);
  }
  private async send(input: AgentInput, placement: SubmitPlacement, typed = false) {
    const reject = (reason: string) => ({ accepted: false, dropped: true, reason });
    const images = input.images ?? [];
    let blocks: ContentBlockView[];
    try { blocks = inputBlocks(input); } catch (error) { return reject(actionable(error)); }
    if (images.length && !this.capabilities.images) return reject('Antigravity 当前未公布图片支持；整条输入已保留，未发送。');
    const fingerprint = JSON.stringify({ text: input.text, blocks, images: images.map(i => ({ id: i.id, mediaType: i.mediaType })) });
    const previous = this.ledger.get(input.clientMessageId);
    if (previous !== undefined) return previous === fingerprint ? { accepted: true } : reject('相同 clientMessageId 的内容不同；请使用新的输入 ID。');
    if (this.closing) return reject(`连接已结束；输入已保留。请用 /resume 重试会话 ${this.ref.sessionId}，或明确 /new 后再发送。`);
    if (this.preparing) return reject('正在恢复历史，输入已保留。');
    const effective = blocks.map(b => b.text ?? '').join('');
    const route = typed ? { text: effective } : this.commands.route(effective);
    if (route.error) return reject(route.error);
    if (route.local) {
      if (images.length) return reject('本地报告命令不接收图片；整条输入已保留，未发送。');
      this.ledger.set(input.clientMessageId, fingerprint);
      this.projection.emit({ type: 'pending.changed', items: [], claimed: [input.clientMessageId] });
      this.projection.emit({ type: 'user.message', id: input.clientMessageId, anchor: `${this.ref.sessionId}:report:${input.clientMessageId}`,
        seq: this.projection.nextSeq(), time: Date.now(), source: 'command-output', label: '/agy-commands', displayLive: true,
        text: this.commands.report(), blocks: [{ type: 'text', text: this.commands.report() }] });
      return { accepted: true };
    }
    if (this.access && !isUnsandboxedMode(this.options.current('mode'))) return reject('AGY 执行模式已变化；请从 /permission 选择一个原生模式，输入已保留。');
    blocks = routedBlocks(blocks, effective, route.text);
    if (this.gate || this.cancelling) return reject('正在确认输入或停止结果，输入已保留。');
    if (this.active && placement !== 'now') return reject('任务进行中，输入已保留；结束后可发送。');
    if (images.length) {
      const reading = this.reading = new AbortController(); this.gate = true;
      try { blocks = await promptBlocks(blocks, images, reading.signal); }
      catch (error) { return reject(`读取图片失败：${actionable(error)}；整条输入已保留，未发送。`); }
      finally { if (this.reading === reading) this.reading = undefined; this.gate = false; }
      if (reading.signal.aborted || this.closing) return reject('图片发送已取消；整条输入已保留，未发送。');
    }
    if (this.active) {
      if (placement !== 'now') return reject('任务进行中，输入已保留；结束后可发送。');
      const receipt = await this.cancel('interrupt');
      if (receipt.outcome !== 'confirmed' || this.closing || this.active) return reject('停止尚未确认，输入已保留，未发送。');
    }
    // No await between final admission check and ownership: concurrent submissions cannot both enter.
    const duplicate = this.ledger.get(input.clientMessageId);
    if (duplicate !== undefined) return duplicate === fingerprint ? { accepted: true } : reject('输入 ID 冲突。');
    this.ledger.set(input.clientMessageId, fingerprint);
    this.gate = true;
    const turn = this.projection.reserve(input.clientMessageId);
    let resolve!: (confirmed: boolean) => void;
    const terminal = new Promise<boolean>((r) => { resolve = r; });
    const active: Active = { projection: turn, terminal, resolve, submitted: false };
    this.active = active;
    this.projection.start(input, blocks, turn);
    if (this.closing || this.active !== active) { this.gate = false; this.ledger.delete(input.clientMessageId); return reject('输入发送前会话已结束，输入已保留。'); }
    this.gate = false;
    this.statusTo('running');
    if (this.closing || this.active !== active) { this.ledger.delete(input.clientMessageId); return reject('输入发送前会话已结束，输入已保留。'); }
    active.submitted = true;
    // Once passed to the transport, errors are terminal events, never a retryable dropped input.
    let prompt: Promise<PromptResponse>;
    try {
      prompt = this.acp.connection.agent.request('session/prompt', { sessionId: this.ref.sessionId, prompt: blocks as ContentBlock[] });
    } catch (error) { this.fatal(error); return { accepted: true }; }
    void prompt.then((response) => {
      if (this.active !== active || this.closing) return;
      const stop = response.stopReason;
      const reason: TurnEndReason = stop === 'end_turn' ? { kind: 'completed' } : stop === 'cancelled' ? { kind: 'interrupted' } :
        stop === 'refusal' ? { kind: 'blocked' } : { kind: 'other', label: stop };
      active.reason = reason; this.permissions.cancelAll();
      this.projection.finish(turn, reason); this.active = undefined;
      this.statusTo('idle'); resolve(true);
    }, (error) => { if (this.active === active && !this.closing) this.fatal(error); });
    return { accepted: true };
  }
  cancel(_cause: CancelCause): Promise<CancelReceipt> {
    this.reading?.abort();
    if (this.cancelling) return this.cancelling;
    if (!this.active) return Promise.resolve(this.lastUncertain.length ? { outcome: 'unknown', stillQueued: this.lastUncertain } : { outcome: 'confirmed', stillQueued: [] });
    const active = this.active;
    if (!active.submitted) {
      this.active = undefined;
      this.projection.finish(active.projection, { kind: 'interrupted' });
      active.resolve(true); this.statusTo('idle');
      return Promise.resolve({ outcome: 'confirmed', stillQueued: [] });
    }
    const covered = [active.projection.inputId];
    this.gate = true;
    this.cancelling = (async (): Promise<CancelReceipt> => {
      this.permissions.cancelAll();
      let outcome: CancelReceipt['outcome'] = 'unknown';
      const started = Date.now();
      try {
        await deadline(this.acp.connection.agent.notify('session/cancel', { sessionId: this.ref.sessionId }), this.cancelMs, '发送停止');
      } catch (error) {
        outcome = /超时/.test(String(error)) ? 'unknown' : 'failed';
        this.lastUncertain = covered; this.fatal(error);
        await this.acp.dispose(); return { outcome, stillQueued: covered };
      }
      try {
        const confirmed = await deadline(active.terminal, Math.max(1, this.cancelMs - (Date.now() - started)), '等待停止回执');
        if (confirmed) outcome = 'confirmed';
      } catch { /* notification delivery alone is not confirmation */ }
      if (outcome !== 'confirmed') {
        this.lastUncertain = covered;
        this.fatal(new Error('停止结果未知；本连接已关闭，已提交输入不会自动重发。'));
        await this.acp.dispose();
      }
      return { outcome, stillQueued: outcome === 'confirmed' ? [] : covered };
    })().finally(() => { this.cancelling = undefined; this.gate = false; });
    return this.cancelling;
  }
  fatal(error: unknown): void {
    if (this.closing) return;
    this.reading?.abort();
    this.closing = true;
    const message = actionable(error);
    this.permissions.cancelAll(); this.commands.clear(); this.projection.closeCompactions();
    if (this.active) {
      this.lastUncertain = [this.active.projection.inputId];
      this.projection.finish(this.active.projection, { kind: 'error', message });
      this.active.resolve(false); this.active = undefined;
    }
    this.projection.emit({ type: 'notice', level: 'error', text: message });
    this.statusTo('disposed'); void this.acp.dispose();
  }
  private async closeNative(acp: Acp): Promise<void> {
    if (acp.initialized?.agentCapabilities?.sessionCapabilities?.close) {
      try { await deadline(acp.connection.agent.request('session/close', { sessionId: this.ref.sessionId }), 300, '关闭原生连接'); }
      catch { /* owned process cleanup is authoritative */ }
    }
  }
  dispose(): Promise<void> {
    return this.disposal ??= (async () => {
      // Exiting does not wait five seconds on a peer that already failed to cancel.
      this.closing = true; this.permissions.cancelAll();
      this.reading?.abort();
      this.commands.clear(); this.projection.closeCompactions();
      const active = this.active;
      if (active) {
        this.lastUncertain = [active.projection.inputId];
        this.projection.finish(active.projection, { kind: 'aborted', cause: 'disposed' });
        this.active = undefined;
      }
      this.statusTo('disposed');
      if (this.candidate && this.candidate !== this.acp) await this.candidate.dispose();
      // Let resolved approval responses enter the SDK write queue before the
      // cancellation notification. This is bounded best effort, not a receipt.
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        await deadline(this.acp.connection.agent.notify('session/cancel', { sessionId: this.ref.sessionId }), 300, '退出时停止');
        if (active?.submitted) await deadline(active.terminal, 300, '退出时等待终结');
      } catch { /* An unwritable peer still gets forced cleanup below. */ }
      active?.resolve(false);
      await this.closeNative(this.acp);
      await this.acp.dispose();
    })();
  }
}
