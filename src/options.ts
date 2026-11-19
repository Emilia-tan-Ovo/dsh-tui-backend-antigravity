import type { LoadSessionResponse, SessionConfigOption, SessionConfigSelectOption, SessionModeState } from '@agentclientprotocol/sdk';
import type { Choice } from './prefs.js';
import type { AgentEvent } from './host-contract.js';

type Select = Extract<SessionConfigOption, { type: 'select' }>;
export const values = (option: Select): SessionConfigSelectOption[] => option.options.flatMap((o) => 'options' in o ? o.options : [o]);

/** Authoritative native snapshots; selectors and mutations use the same IDs. */
export class Options {
  private config: SessionConfigOption[] = [];
  private legacy?: SessionModeState | null;
  private modeConfigSeen = false;
  constructor(private emit: (event: AgentEvent) => void, private model: (id: string) => void) {}
  select(category: Choice): Select | undefined {
    const matches = this.config.filter((o) => o.category === category);
    if (matches.length !== 1 || matches[0].type !== 'select') return undefined;
    const option = matches[0];
    const ids = values(option).map((v) => v.value);
    return new Set(ids).size === ids.length ? option : undefined;
  }
  current(category: Choice): string | undefined {
    return this.select(category)?.currentValue ?? (category === 'mode' && !this.modeConfigSeen ? this.legacy?.currentModeId : undefined);
  }
  choices(category: Choice): SessionConfigSelectOption[] {
    const select = this.select(category);
    if (select) return values(select);
    return category === 'mode' && !this.modeConfigSeen ? this.legacy?.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })) ?? [] : [];
  }
  has(category: Choice): boolean { return !!this.select(category) || (category === 'mode' && this.choices(category).length > 0); }
  display(): string | undefined { return this.choices('model').find(v => v.value === this.current('model'))?.name; }
  adopt(next: Options): void {
    this.apply({ configOptions: next.config, modes: next.legacy ?? null }, next.modeConfigSeen);
  }
  apply(response: LoadSessionResponse, modeConfigSeen = this.modeConfigSeen): void {
    const before = { model: this.current('model'), thought_level: this.current('thought_level'), mode: this.current('mode') };
    // Lifecycle responses may omit configOptions; explicit updates are always full snapshots.
    if (response.configOptions !== undefined) this.config = response.configOptions ?? [];
    this.modeConfigSeen = modeConfigSeen || this.config.some(o => o.category === 'mode');
    if (response.modes !== undefined) this.legacy = response.modes;
    const model = this.current('model');
    this.model(model ?? '模型未报告');
    if (model !== before.model) this.emit({ type: 'model.changed', model: model ?? '模型未报告', source: 'settings' });
    const effort = this.current('thought_level');
    if (effort !== before.thought_level) this.emit({ type: 'effort.changed', effort: effort ?? null });
    const mode = this.current('mode');
    if (mode !== before.mode) this.emit({ type: 'mode.changed', modeId: mode ?? '' });
  }
  mode(id: string): void {
    const select = this.select('mode');
    if (select) this.apply({ configOptions: this.config.map(o => o === select ? { ...select, currentValue: id } : o) });
    else if (this.legacy) this.apply({ modes: { ...this.legacy, currentModeId: id } });
  }
  validate(category: Choice, value: string): void {
    if (!this.choices(category).some(v => v.value === value)) throw new Error(`Antigravity 当前未提供 ${category}=${value}；未更改配置。`);
    if (category === 'model' && !/^gemini(?:[-_.]|$)/i.test(value)) throw new Error('本后端当前只开放实际公布的 Gemini 模型。');
  }
}
