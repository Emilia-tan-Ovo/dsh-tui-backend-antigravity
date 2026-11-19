import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BackendHost } from './host-contract.js';

export type Choice = 'model' | 'thought_level' | 'mode';
export type Overrides = Partial<Record<Choice, string>>;

/** Small independent records: no whole-database read/modify/write across windows. */
export class Prefs {
  private memory = new Map<string, unknown>();
  constructor(private host: BackendHost) {
    if (!host.dataDir) host.warn('宿主未提供 Antigravity 数据空间；本地会话选择仅在本进程保留，原生会话仍可恢复。');
  }
  path(kind: string, key: string): string | undefined {
    const normalized = kind === 'cwd' ? (process.platform === 'win32' ? resolve(key).toLowerCase() : resolve(key)) : key;
    // Native IDs are opaque and case-sensitive; NTFS filenames usually aren't.
    // Lowercase hex preserves every UTF-8 byte without case-only path collisions.
    const encoded = Buffer.from(normalized, 'utf8').toString('hex') || '_';
    return this.host.dataDir ? join(this.host.dataDir, 'v1', kind, ...encoded.match(/.{1,96}/g)!, 'record.json') : undefined;
  }
  private read(kind: string, key: string): unknown {
    const path = this.path(kind, key);
    if (!path) return this.memory.get(`${kind}:${key}`);
    try { return JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  }
  private write(kind: string, key: string, value: unknown): void {
    const path = this.path(kind, key);
    if (!path) { this.memory.set(`${kind}:${key}`, value); return; }
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    try { writeFileSync(temp, JSON.stringify(value), { encoding: 'utf8', flag: 'wx' }); renameSync(temp, path); }
    finally { try { unlinkSync(temp); } catch { /* renamed, or not created */ } }
  }
  private remove(kind: string, key: string): void {
    const path = this.path(kind, key);
    if (!path) { this.memory.delete(`${kind}:${key}`); return; }
    try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private warn(error: unknown): void { this.host.warn(`Antigravity 本地偏好未保存或不可读；原生状态不变，重开可能不保留选择：${String(error)}`); }
  last(cwd: string): string | undefined {
    try { const value = this.read('cwd', cwd); if (value === undefined || typeof value === 'string') return value; throw new Error('无效启动记录（原文件保留）'); }
    catch (error) { this.warn(error); return undefined; }
  }
  mark(id: string, cwd: string): void { try { this.write('cwd', cwd, id); this.write('touch', id, Date.now()); } catch (error) { this.warn(error); } }
  forget(id: string, cwd?: string): void {
    try { if (cwd && this.last(cwd) === id) this.remove('cwd', cwd); this.remove('touch', id); } catch (error) { this.warn(error); }
  }
  overrides(id: string): Overrides {
    const value = this.read('choices', id);
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.entries(value).some(([k,v]) => !['model','thought_level','mode'].includes(k) || typeof v !== 'string')) throw new Error('无效会话偏好（原文件保留）');
    return value as Overrides;
  }
  restore(id: string): Overrides { try { return this.overrides(id); } catch (error) { this.warn(error); return {}; } }
  confirm(id: string, category: Choice, value: string): void {
    try { this.write('choices', id, { ...this.overrides(id), [category]: value }); } catch (error) { this.warn(error); }
  }
  confirmModel(id: string, model: string, effort?: string): void {
    try {
      const next = { ...this.overrides(id), model };
      if (effort === undefined) delete next.thought_level; else next.thought_level = effort;
      this.write('choices', id, next);
    } catch (error) { this.warn(error); }
  }
  reconcileEffort(id: string, effort?: string): void {
    try {
      const next = { ...this.overrides(id) };
      if (effort === undefined) delete next.thought_level; else next.thought_level = effort;
      this.write('choices', id, next);
    } catch (error) { this.warn(error); }
  }
}
