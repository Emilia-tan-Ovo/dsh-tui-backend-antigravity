import { registerAppearance, type AppearanceContext } from './appearance.js';
import { createBackend } from './backend-core.js';

export const name = 'dsh-tui-backend-antigravity';
export const backend = createBackend();
export function apply(ctx?: AppearanceContext): void { registerAppearance(ctx); }
