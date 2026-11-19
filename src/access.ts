export const accessProfiles = ['outside-workspace', 'full-access'] as const;
export type AccessProfile = typeof accessProfiles[number];
export const isAccessProfile = (id: string): id is AccessProfile => id === 'outside-workspace' || id === 'full-access';

export function accessProfile(env: NodeJS.ProcessEnv): AccessProfile | undefined {
  const value = env.DSH_TUI_AGY_ACCESS;
  if (value === undefined) return undefined;
  if (isAccessProfile(value)) return value;
  throw new Error('DSH_TUI_AGY_ACCESS 只接受 outside-workspace 或 full-access；移除此变量可恢复日常设置。');
}

export function withAccess(args: string[], profile: AccessProfile | undefined): string[] {
  if (!profile) return args;
  const full = profile === 'full-access';
  // The root CLI parses --settings before the ACP subcommand. The ACP flag
  // belongs after it. The settings overlay is process-local and never saved.
  return ['--settings', JSON.stringify({
    agentMode: '',
    enableTerminalSandbox: false,
    allowNonWorkspaceAccess: true,
    toolPermission: full ? 'always-proceed' : 'request-review',
  }), ...args, ...(full ? ['--dangerously-skip-permissions'] : [])];
}

export const isUnsandboxedMode = (id: string | undefined): boolean => id === 'default' || id === 'accept-edits' || id === 'plan';

export const accessLabel = (profile: AccessProfile): string => profile === 'full-access' ? 'Full access' : '工作区外访问';

export const accessSummary = (profile: AccessProfile): string =>
  `允许工作区外访问，关闭终端沙箱，${profile === 'full-access' ? '跳过工具审批' : '保留命令审批'}。`;

export const accessDescription = (profile: AccessProfile): string =>
  `当前权限 ${profile}：${accessSummary(profile)} 用 /permission 切回原生权限模式。`;
