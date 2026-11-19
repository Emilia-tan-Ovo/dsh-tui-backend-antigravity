import type { ContentBlock, NewSessionResponse, SessionConfigOption, SessionUpdate, ToolCallUpdate } from '@agentclientprotocol/sdk';
import type { AgentEvent, AgentEventMeta, AgentInput, ContentBlockView, TurnEndReason } from './host-contract.js';

type Listener = (events: readonly AgentEvent[], meta: AgentEventMeta) => void;
interface Turn { number: number; inputId: string; attempt: string; blocks: ContentBlockView[]; tools: Map<string, { value: ToolCallUpdate; done: boolean; output: string; start: number }> }
interface ReplayMessage { role: 'user' | 'assistant'; id?: string | null; anchor: string; blocks: ContentBlockView[] }
interface Compaction { id: string; seq: number; time: number; endedAt?: number; status: string; summary: ContentBlock[]; error?: string | null; meta?: unknown; ended: boolean }
const terminalCompaction = (c: Compaction) => ['completed','failed','cancelled'].includes(c.status);

// Image facades are immutable lazy readers, not structured-cloneable payloads.
// Clone event data while retaining those host-owned capabilities by reference.
const copyEvents = (events: readonly AgentEvent[]): AgentEvent[] => events.map(event => {
  const images = 'images' in event ? event.images : undefined;
  return images === undefined ? structuredClone(event) : { ...structuredClone({ ...event, images: undefined }), images: [...images] } as AgentEvent;
});

// Keep the native block alongside a readable facade. Host 0.19.0 only promises
// type/text for generic blocks; never throw away images/resources it cannot draw.
export function contentView(content: ContentBlock, type?: string): ContentBlockView {
  if (content.type === 'text') return { ...content, type: type ?? 'text' };
  const ref = 'uri' in content ? content.uri : 'resource' in content && 'uri' in content.resource ? content.resource.uri : '';
  return { ...content, text: `[${content.type}]${ref ? ` ${ref}` : ''}` };
}

export function modelName(options: SessionConfigOption[] | null | undefined): string {
  const option = options?.find((o) => o.category === 'model');
  if (!option || option.type !== 'select') return '模型未报告';
  const values = option.options.flatMap((o) => 'options' in o ? o.options : [o]);
  return option.currentValue;
}

/** In-memory canonical journal, with an atomic history→subscribe handover. */
export class Projection {
  private journal: AgentEvent[] = [];
  private listeners = new Set<Listener>();
  private seed?: { revision: number; events: readonly AgentEvent[] };
  private subscribed = false;
  private seq = 0;
  private turnNumber = 0;
  private loading = false;
  private replayMessage?: ReplayMessage;
  private replayOrdinal = 0;
  private replayTurn?: Turn;
  private compactions = new Map<string, Compaction>();
  private compactionMarkers = new Map<number, Compaction>();
  private compactionEvents = new Set<AgentEvent>();
  private visibleCompaction?: Compaction;
  get compactionCount(): number { return this.compactions.size; }
  active?: Turn;
  nextSeq(): number { return ++this.seq; }
  model: string;
  constructor(readonly id: string, cwd: string, session: NewSessionResponse, private debug: (text: string) => void, loading = false) {
    this.loading = loading;
    this.model = modelName(session.configOptions);
    this.emit({ type: 'session.ready', sessionId: id, cwd, model: this.model, permissionMode: session.modes?.currentModeId });
    this.emit({ type: 'session.status', status: 'idle' });
  }
  emit = (event: AgentEvent): void => {
    this.journal.push(event);
    for (const listener of [...this.listeners]) this.deliver(listener, [event], false);
  };
  private deliver(listener: Listener, events: readonly AgentEvent[], replay: boolean) {
    try { listener(copyEvents(events), { replay, wake: events.some((e) => e.type === 'assistant.delta' || e.type === 'tool.output') ? 'frame' : 'sync' }); }
    catch (e) { this.debug(`Antigravity event listener: ${String(e)}`); }
  }
  private snapshot(): readonly AgentEvent[] {
    const committed = new Set(this.journal.flatMap((e) => e.type === 'assistant.message' ? [e.attemptId] : []));
    const settled = new Set(this.journal.flatMap((e) => e.type === 'permission.settled' || e.type === 'question.settled' ? [e.requestId] : []));
    const activeTools = new Map([...this.active?.tools ?? []].filter(([, t]) => !t.done).map(([id,t]) => [this.callId(this.active!, id),t.start]));
    return this.journal.flatMap((e,index) => {
      const compaction = this.compactionMarkers.get(index);
      if (compaction) return this.compactionSnapshot(compaction);
      if (this.compactionEvents.has(e)) return [];
      return !(e.type === 'assistant.delta' && committed.has(e.attemptId)) &&
      !((e.type === 'tool.output' || e.type === 'tool.progress') && index < (activeTools.get(e.callId) ?? Infinity)) &&
      !((e.type === 'permission.request' || e.type === 'question.request') && settled.has(e.request.requestId)) ? [e] : [];
    });
  }
  async history(): Promise<readonly AgentEvent[]> {
    if (!this.subscribed) this.seed ??= { revision: this.journal.length, events: copyEvents(this.snapshot()) };
    return copyEvents(this.seed && !this.subscribed ? this.seed.events : this.snapshot());
  }
  subscribe(listener: Listener): () => void {
    const first = !this.subscribed;
    this.subscribed = true;
    this.listeners.add(listener);
    if (first && this.seed) this.deliver(listener, this.journal.slice(this.seed.revision).filter((_,i) => !this.compactionMarkers.has(this.seed!.revision + i)), false);
    else this.deliver(listener, this.snapshot(), true);
    this.seed = undefined;
    return () => this.listeners.delete(listener);
  }
  reserve(inputId: string): Turn {
    const number = ++this.turnNumber;
    const attempt = `${this.id}:attempt:${number}`;
    return this.active = { number, inputId, attempt, blocks: [], tools: new Map() };
  }
  start(input: AgentInput, blocks: ContentBlockView[], turn: Turn): void {
    const {number, attempt} = turn;
    const time = Date.now();
    this.emit({ type: 'turn.start', turn: number, origin: 'user', userMessageId: input.clientMessageId, time });
    if (this.active !== turn) return;
    this.emit({ type: 'user.message', id: input.clientMessageId, anchor: `${this.id}:input:${number}`, seq: ++this.seq,
      turn: number, time, source: 'user', text: input.text, blocks, ...(input.images?.length ? { images: input.images } : {}) });
    if (this.active !== turn) return;
    this.emit({ type: 'pending.changed', items: [], claimed: [input.clientMessageId] });
    if (this.active !== turn) return;
    this.emit({ type: 'step.start', turn: number, step: 1 });
    if (this.active !== turn) return;
    this.emit({ type: 'assistant.attempt.start', turn: number, step: 1, attemptId: attempt, model: this.model });
  }
  toolState(id: string): ToolCallUpdate | undefined { return this.active?.tools.get(id)?.value; }
  callId(turn: Turn, native: string): string { return `${this.id}:tool:${turn.number}:${native}`; }
  private flushReplay(): void {
    const message = this.replayMessage;
    if (!message) return;
    this.replayMessage = undefined;
    if (message.role === 'user') this.emit({ type: 'user.message', id: message.anchor, anchor: message.anchor, seq: ++this.seq,
      time: 0, source: 'user', text: message.blocks.map(b => b.text ?? '').join(''), blocks: message.blocks });
    else this.emit({ type: 'assistant.message', anchor: message.anchor, seq: ++this.seq, attemptId: message.anchor,
      time: 0, model: this.model, blocks: message.blocks, canonical: true });
  }
  endReplay(): void {
    this.flushReplay();
    if (this.replayTurn) this.settleTools(this.replayTurn, '历史工具未报告终态，结果未知', 0);
    if (this.loading) this.closeCompactions();
    this.replayTurn = undefined; this.loading = false;
  }
  private replay(update: SessionUpdate): boolean {
    if (!this.loading) return false;
    if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk' || update.sessionUpdate === 'agent_thought_chunk') {
      const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
      if (!this.replayMessage || this.replayMessage.role !== role || this.replayMessage.id !== update.messageId) {
        this.flushReplay();
        if (role === 'user' && this.replayTurn) { this.settleTools(this.replayTurn, '历史工具未报告终态，结果未知', 0); this.replayTurn = undefined; }
        this.replayMessage = { role, id: update.messageId, anchor: `${this.id}:replay:${++this.replayOrdinal}:${update.messageId ?? 'segment'}`, blocks: [] };
      }
      const block = contentView(update.content, update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : undefined);
      const last = this.replayMessage.blocks.at(-1);
      if (update.content.type === 'text' && last?.type === block.type) this.replayMessage.blocks[this.replayMessage.blocks.length - 1] = { type: block.type, text: (last.text ?? '') + block.text };
      else this.replayMessage.blocks.push(block);
      return true;
    }
    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.flushReplay();
      this.replayTurn ??= { number: ++this.turnNumber, inputId: '', attempt: '', blocks: [], tools: new Map() };
      this.tool(this.replayTurn, update, 0); return true;
    }
    return false;
  }
  update(update: SessionUpdate): void {
    if (this.replay(update)) return;
    const turn = this.active;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': case 'agent_thought_chunk': {
        if (!turn) { this.debug('忽略不属于活动 prompt 的回复。'); return; }
        if (update.content.type !== 'text') { turn.blocks.push(contentView(update.content)); return; }
        const type = update.sessionUpdate === 'agent_thought_chunk' ? 'reasoning' : 'text';
        const last = turn.blocks.at(-1);
        const index = last?.type === type ? turn.blocks.length - 1 : turn.blocks.length;
        if (last?.type === type) turn.blocks[index] = { type, text: (last.text ?? '') + update.content.text };
        else turn.blocks.push({ type, text: update.content.text });
        this.emit({ type: 'assistant.delta', attemptId: turn.attempt, index, time: Date.now(), seq: ++this.seq,
          turn: turn.number, step: 1, delta: { kind: type, text: update.content.text } });
        break;
      }
      case 'user_message_chunk':
        if (!turn && update.content.type === 'text') this.emit({ type: 'user.message', id: `${this.id}:native:${this.seq + 1}`,
          anchor: `${this.id}:native:${this.seq + 1}`, seq: ++this.seq, time: 0, source: 'user', text: update.content.text, blocks: [update.content] });
        break; // Active prompt echo is already attributed to its clientMessageId.
      case 'tool_call': case 'tool_call_update':
        if (turn) this.tool(turn, update);
        break;
      case 'config_option_update': {
        const model = modelName(update.configOptions);
        if (model !== this.model) { this.model = model; this.emit({ type: 'model.changed', model, source: 'settings' }); }
        break;
      }
      case 'current_mode_update': this.emit({ type: 'mode.changed', modeId: update.currentModeId }); break;
      case 'session_info_update': if (update.title !== undefined) this.emit({ type: 'session.title', title: update.title ?? '', source: 'auto' }); break;
      case 'notice': this.emit({ type: 'notice', level: update.severity === 'error' ? 'error' : update.severity === 'warning' ? 'warning' : 'info', text: [update.title, update.description].filter(Boolean).join('\n') }); break;
      case 'compaction_update': case 'compaction_summary_chunk': this.compaction(update); break;
      default: this.debug(`未投影 ACP 更新：${update.sessionUpdate}`);
    }
  }
  private tool(turn: Turn, patch: ToolCallUpdate, time = Date.now()): void {
    const callId = this.callId(turn, patch.toolCallId);
    let tool = turn.tools.get(patch.toolCallId);
    if (!tool) {
      tool = { value: patch, done: false, output: '', start: this.journal.length }; turn.tools.set(patch.toolCallId, tool);
      this.emit({ type: 'tool.call', seq: ++this.seq, anchor: `${this.id}:tool:${turn.number}:${patch.toolCallId}`,
        turn: turn.number, step: 1, callId, name: patch.title ?? patch.kind ?? 'Antigravity tool',
        argsJson: JSON.stringify(patch.rawInput ?? { locations: patch.locations ?? [] }), time,
        presentation: { card: 'generic', title: patch.title ?? patch.kind ?? 'Antigravity tool' } });
    }
    // ACP updates are partial snapshots, including nullable fields. Undefined leaves prior data intact.
    tool.value = { ...tool.value, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    if (tool.done) return;
    const value = tool.value;
    const content: ContentBlockView[] = value.content?.flatMap((c) => c.type === 'content' ? [contentView(c.content)] : []) ?? [];
    const outputText = content.map((c) => c.text).join('\n');
    const locations = value.locations?.map((l) => l.path).join('\n');
    if (locations) content.push({ type: 'text', text: locations });
    const text = content.map((c) => c.text).join('\n');
    if (outputText && outputText.startsWith(tool.output) && outputText !== tool.output) this.emit({ type: 'tool.output', callId, text: outputText.slice(tool.output.length), time });
    tool.output = outputText;
    if (value.status !== 'completed' && value.status !== 'failed') {
      this.emit({ type: 'tool.progress', callId, elapsedMs: 0 }); return;
    }
    tool.done = true;
    const diffs = value.content?.flatMap((c) => c.type === 'diff' ? [{ path: c.path, oldText: c.oldText ?? null, newText: c.newText }] : []) ?? [];
    const isError = value.status === 'failed';
    const raw = value.rawOutput;
    const output = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    this.emit({ type: 'tool.result', seq: ++this.seq, turn: turn.number, step: 1, callId,
      time, content, text, isError, errorText: isError ? text || '工具失败' : undefined,
      structured: raw, meta: { acp: value },
      presentation: diffs.length ? { card: 'diff', title: value.title ?? undefined, diffs } :
        value.kind === 'execute' ? { card: 'terminal', title: [value.title,locations].filter(Boolean).join(' · ') || undefined,
          output: typeof output.output === 'string' ? output.output : outputText || undefined,
          exitCode: typeof output.exitCode === 'number' ? output.exitCode : typeof output.exit_code === 'number' ? output.exit_code : undefined } :
          { card: 'generic', title: value.title ?? undefined, content } });
  }
  finish(turn: Turn, reason: TurnEndReason): void {
    if (this.active !== turn) return;
    this.active = undefined;
    this.settleTools(turn, '操作中断，结果未知', Date.now());
    this.emit({ type: 'assistant.message', seq: ++this.seq, anchor: turn.attempt, turn: turn.number, step: 1,
      attemptId: turn.attempt, time: Date.now(), model: this.model, blocks: turn.blocks,
      interrupted: reason.kind !== 'completed' ? true : undefined, canonical: true });
    this.emit({ type: 'assistant.attempt.end', attemptId: turn.attempt, turn: turn.number, step: 1, outcome: 'committed' });
    this.emit({ type: 'step.end', turn: turn.number, step: 1 });
    this.emit({ type: 'turn.end', turn: turn.number, time: Date.now(), reason });
  }
  private settleTools(turn: Turn, text: string, time: number): void {
    for (const [native, tool] of turn.tools) if (!tool.done) {
      tool.done = true;
      this.emit({ type: 'tool.result', seq: ++this.seq, turn: turn.number, step: 1, callId: this.callId(turn, native),
        time, content: [{ type: 'text', text }], text,
        isError: true, errorText: text, meta: { acp: tool.value, interrupted: true } });
    }
  }
  private compactionSnapshot(c: Compaction): AgentEvent[] {
    return [{ type: 'compaction.start', trigger: 'auto', cancellable: false, time: c.time }, ...(terminalCompaction(c) ? [this.compactionEnd(c), this.compactionMessage(c)] : [])];
  }
  private compactionMessage(c: Compaction): AgentEvent {
    const blocks = c.summary.map(b => contentView(b));
    const text = [`Antigravity 压缩：${c.status}`, ...blocks.map(b => b.text ?? ''), c.error].filter(Boolean).join('\n');
    return { type: 'user.message', id: `${this.id}:compaction:${c.id}`, anchor: `${this.id}:compaction:${c.id}`, seq: c.seq,
      time: c.endedAt ?? c.time, source: c.status === 'completed' ? 'compaction' : 'command-output',
      displayLive: c.status === 'completed' ? undefined : true, label: 'Antigravity 压缩记录', text,
      blocks: [{ type: 'text', text: `Antigravity 压缩：${c.status}` }, ...blocks, ...(c.error ? [{ type: 'text', text: c.error }] : [])] };
  }
  private compactionEnd(c: Compaction): AgentEvent {
    return { type: 'compaction.end', ok: c.status === 'completed', contextReplaced: c.status === 'completed',
      summary: c.summary.map(b => contentView(b).text ?? '').join(''), error: c.error ?? (c.status === 'completed' ? undefined : c.status), time: c.endedAt ?? c.time };
  }
  private compactionEmit(event: AgentEvent): void { this.compactionEvents.add(event); this.emit(event); }
  private compaction(update: Extract<SessionUpdate, { sessionUpdate: 'compaction_update' | 'compaction_summary_chunk' }>): void {
    this.flushReplay();
    let c = this.compactions.get(update.compactionId);
    if (!c) {
      c = { id: update.compactionId, seq: ++this.seq, time: this.loading ? 0 : Date.now(), status: 'in_progress', summary: [], ended: false };
      this.compactions.set(c.id, c); this.compactionMarkers.set(this.journal.length, c);
      this.journal.push({ type: 'notice', level: 'info', text: '' }); // private timeline marker, never delivered
    }
    const ended = c.ended;
    if (update.sessionUpdate === 'compaction_update') {
      c.status = update.status;
      if (update.summary !== undefined) c.summary = update.summary ?? [];
      if (update.error !== undefined) c.error = update.error;
      if (update._meta !== undefined) c.meta = update._meta;
    } else c.summary.push(update.content);
    if (ended) {
      this.emit({ type: 'notice', level: 'info', text: `压缩记录 ${c.id} 已更正：${c.status}\n${c.summary.map(b => contentView(b).text ?? '').join('')}${c.error ? `\n${c.error}` : ''}` });
      return;
    }
    // Host brackets have no IDs. Serialize their display; native entities still
    // patch independently and history always has one entity at its first position.
    if (!this.visibleCompaction) {
      this.visibleCompaction = c;
      this.compactionEmit({ type: 'compaction.start', trigger: 'auto', cancellable: false, time: this.loading ? 0 : Date.now() });
    }
    if (this.visibleCompaction === c && update.sessionUpdate === 'compaction_summary_chunk') this.compactionEmit({ type: 'compaction.progress', outputChars: contentView(update.content).text?.length ?? 0 });
    this.flushCompactions();
  }
  private flushCompactions(): void {
    while (this.visibleCompaction && terminalCompaction(this.visibleCompaction)) {
      const c = this.visibleCompaction; c.ended = true; c.endedAt = this.loading ? 0 : Date.now();
      this.compactionEmit(this.compactionEnd(c));
      // Host compaction brackets only update volatile progress/context. The
      // completed checkpoint makes the native record visible in both live and
      // history. Failed/cancelled attempts use a neutral command report: the
      // host's compaction source also resets context and declares success.
      this.compactionEmit(this.compactionMessage(c)); this.visibleCompaction = undefined;
      const next = [...this.compactions.values()].find(v => !v.ended);
      if (next) { this.visibleCompaction = next; this.compactionEmit({ type: 'compaction.start', trigger: 'auto', cancellable: false, time: this.loading ? 0 : Date.now() }); }
    }
  }
  closeCompactions(): void {
    for (const c of this.compactions.values()) if (!terminalCompaction(c)) { c.status = 'failed'; c.error = '连接结束，压缩结果未知'; }
    this.flushCompactions();
  }
}
