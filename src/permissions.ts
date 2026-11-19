import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import type { AgentEvent, PermissionDecision, QuestionAnswers } from './host-contract.js';

type PermissionView = Extract<AgentEvent, { type: 'permission.request' }>['request'];
type Entry = { request: RequestPermissionRequest; view?: PermissionView; labels?: Map<string, string>; settle: (id?: string) => void };
const CANCEL = '取消本次审批';

/** One resolver per inbound RPC, never keyed by toolCallId or reused across sessions. */
export class Permissions {
  private entries = new Map<string, Entry>();
  private serial = 0;
  constructor(private generation: string, private emit: (event: AgentEvent) => void, private changed: (waiting: boolean) => void) {}

  request(request: RequestPermissionRequest, callId: string, signal: AbortSignal): Promise<RequestPermissionResponse> {
    const options = request.options;
    if (!options.length || new Set(options.map((o) => o.optionId)).size !== options.length || signal.aborted) {
      this.emit({ type: 'notice', level: 'warning', text: '审批选项为空、ID 重复或请求已取消；本次审批已取消。' });
      return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    }
    const id = `${this.generation}:permission:${++this.serial}`;
    // The host can focus an existing rejection, but does not supply one.
    const standard = options.filter((o) => o.kind === 'reject_once').length === 1 &&
      options.filter((o) => o.kind === 'allow_once').length <= 1 &&
      options.every((o) => ['allow_once', 'allow_always', 'reject_once'].includes(o.kind));
    const call = request.toolCall;
    const detail = JSON.stringify(call, null, 2);
    return new Promise((resolve) => {
      const abort = () => settle();
      const settle = (optionId?: string) => {
        if (!this.entries.delete(id)) return;
        signal.removeEventListener('abort', abort);
        const option = options.find((o) => o.optionId === optionId);
        this.emit(standard ? { type: 'permission.settled', requestId: id,
          outcome: option?.kind === 'allow_once' ? 'allow-once' : option?.kind === 'allow_always' ? 'allow-always' : option ? 'rejected' : 'cancelled' }
          : { type: 'question.settled', requestId: id });
        this.changed(this.entries.size > 0);
        resolve({ outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } });
      };
      const entry: Entry = { request, settle };
      this.entries.set(id, entry);
      signal.addEventListener('abort', abort, { once: true });
      let event: AgentEvent;
      if (standard) {
        const raw = call.rawInput;
        const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : { rawInput: raw };
        const command = typeof input.command === 'string' ? input.command : typeof input.CommandLine === 'string' ? input.CommandLine : undefined;
        entry.view = { requestId: id, callId, toolName: call.title ?? call.kind ?? 'Antigravity tool',
          title: call.title ?? 'Antigravity 请求审批', description: detail, input, command,
          blockedPath: call.locations?.[0]?.path, defaultToNo: true, feedback: false,
          options: options.map((o) => ({ id: o.optionId, label: o.name,
            kind: o.kind === 'allow_once' ? 'allow-once' : o.kind === 'allow_always' ? 'allow-always' : 'reject' })) };
        event = { type: 'permission.request', request: entry.view };
      } else {
        entry.labels = new Map(options.map((o, i) => [`${i + 1}. ${o.name}`, o.optionId]));
        event = { type: 'question.request', request: { requestId: id, callId,
          questions: [{ question: call.title ?? 'Antigravity 请求审批', detail, multiSelect: false,
            hideCustomInput: true, defaultSelected: [CANCEL],
            options: [{ label: CANCEL }, ...[...entry.labels.keys()].map((label) => ({ label }))] }] } };
      }
      this.changed(true);
      if (this.entries.has(id)) this.emit(event);
      if (signal.aborted) settle();
    });
  }
  pending(): readonly PermissionView[] { return [...this.entries.values()].flatMap((e) => e.view ? [e.view] : []); }
  respond(id: string, decision: PermissionDecision): void {
    const entry = this.entries.get(id);
    if (!entry?.view) return;
    const kind = decision.kind === 'allow-once' ? 'allow_once' : decision.kind === 'allow-always' ? 'allow_always' : 'reject_once';
    const candidates = entry.request.options.filter((o) => o.kind === kind);
    let selected = candidates.length === 1 ? candidates[0]?.optionId : undefined;
    if (decision.kind === 'allow-always' && decision.optionId !== undefined) {
      if (!candidates.some((o) => o.optionId === decision.optionId)) return;
      selected = decision.optionId;
    }
    if (candidates.length > 1 && selected === undefined) return;
    entry.settle(selected);
  }
  answer(id: string, answers: QuestionAnswers): void {
    const entry = this.entries.get(id);
    if (!entry?.labels || answers.answers.length !== 1) return;
    const answer = answers.answers[0];
    if (answer.custom || answer.selected.length !== 1) return;
    const label = answer.selected[0];
    if (label === CANCEL) entry.settle();
    else if (entry.labels.has(label)) entry.settle(entry.labels.get(label));
  }
  cancel(id: string): void { this.entries.get(id)?.settle(); }
  cancelAll(): void { for (const entry of [...this.entries.values()]) entry.settle(); }
}
