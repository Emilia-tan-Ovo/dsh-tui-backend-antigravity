import type { TuiThemeDescriptor, TuiThemeRuntime } from '@deepseek-harness-tui/dsh-tui/extensions';

// RGB strings also feed the host logo's parseRGB path (hex does not).
const rgb = (hex: string): string => `rgb(${[0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(',')})`;
const groups: ReadonlyArray<readonly [readonly string[], string, string]> = [
  [["accent", "professionalBlue", "activity", "toolNameExec", "ide", "background", "rate_limit_fill", "subagentToolName", "subagentStatusRunning"], "6A9EFF", "155FC4"],
  [["accentShimmer", "activityShimmer", "suggestion", "remember", "permission", "permissionShimmer", "autoAccept", "merged", "subagentBullet"], "C79BFF", "7050CB"],
  [["promptBorder", "bashBorder"], "5B82D9", "3568B5"],
  [["promptBorderShimmer"], "8AB4F8", "155FC4"],
  [["text", "subagentDescription"], "EDF1FA", "181C26"],
  [["inverseText", "inputBackground"], "141824", "FFFFFF"],
  [["inactive", "subagentModel", "subagentElapsed"], "A8B2C8", "5A6275"],
  [["inactiveShimmer"], "C0C9DD", "45516A"],
  [["subtle", "syntaxComment"], "9AA6BF", "606B80"],
  [["toolCardBackground"], "1C2233", "FFFFFF"],
  [["toolCardBackgroundDim", "bashMessageBackgroundColor", "memoryBackgroundColor", "messageActionsBackground"], "141824", "F4F6FB"],
  [["selectionBg", "userMessageBackgroundHover"], "252E47", "E6EEFF"],
  [["success", "planMode", "subagentStatusCompleted"], "6EC28B", "26733F"],
  [["warning", "toolNameMutate", "chromeYellow", "warningShimmer"], "E4BD6B", "8A6014"],
  [["error", "subagentStatusFailed"], "E07A82", "B93443"],
  [["toolDotExec"], "6EC28B", "26733F"],
  [["toolDotRead", "toolDotWeb"], "6A9EFF", "155FC4"],
  [["toolDotWrite", "toolDotTask"], "C79BFF", "7050CB"],
  [["userPromptLabel"], "BFB4FF", "7050CB"],
  [["diffAdded", "diffAddedDimmed"], "1D332B", "E1F2E6"],
  [["diffRemoved", "diffRemovedDimmed"], "3C252E", "FBE5E8"],
  [["diffAddedWord"], "91D6AA", "216637"],
  [["diffRemovedWord"], "F3A5B3", "A92540"],
  [["rate_limit_empty"], "252E47", "E6EEFF"],
  [["ignition"], "C79BFF", "7050CB"],
  [["ignitionDim"], "252E47", "E6EEFF"],
  [["contextBarSystem"], "29354E", "CAD8F1"],
  [["contextBarPrompt"], "3E5C91", "A7C2EE"],
  [["contextBarAssistant"], "4D8EFF", "5D88D8"],
  [["contextBarThinking"], "9982D6", "8265C1"],
  [["contextBarTools"], "C79BFF", "7050CB"],
];
function colors(shade: 1 | 2): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(groups.flatMap(group => group[0].map(key => [key, rgb(group[shade])]))));
}
export const GEMINI_THEMES: readonly TuiThemeDescriptor[] = Object.freeze([
  Object.freeze({ name: 'antigravity:gemini-starlight', displayName: 'Gemini Starlight', base: 'dark', colors: colors(1) }),
  Object.freeze({ name: 'antigravity:gemini-daylight', displayName: 'Gemini Daylight', base: 'light', colors: colors(2) }),
]);

// A soft service dependency: bare apply() and backend-only profiles still work.
export interface AppearanceContext {
  inject(services: string[], callback: (ctx: { tuiThemes: Pick<TuiThemeRuntime, 'register'> }) => void): unknown;
}
export function registerAppearance(ctx?: AppearanceContext): void {
  ctx?.inject(['tuiThemes'], scoped => {
    for (const descriptor of GEMINI_THEMES) scoped.tuiThemes.register(descriptor);
  });
}
