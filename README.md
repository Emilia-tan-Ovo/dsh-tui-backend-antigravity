# Antigravity Backend for dsh-TUI

在 [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) 里选择 **Antigravity**，就能用 Gemini 开新会话或接着聊原来的会话。这个社区插件通过官方 `agy acp` 接入；登录、工具执行和原生会话仍由 Antigravity CLI 管理。安装不用修改 dsh-TUI。

**Windows 预览版 · `0.5.3-rc.1`。** 主包包含 Antigravity 后端和两套可手选的 Gemini 主题。已验证菜单切换、工具审批、按 Esc 停止并保留排队输入、会话恢复和卸载。

**后续可选外观：** `ANTIGRAVITY HARNESS` 开屏与转录标题、Gemini 像素娘计划分别提供。dsh-TUI 0.20.2 允许外部后端显示自己的内核名称和注册配色，但没有设置专属开屏与转录标题的公开接口。当前版沿用宿主标题；看内核选择器里的 **Antigravity** 即可确认已切换。[跟进标题接口 #2067](https://github.com/ccch1mneyyy/dsh-TUI/discussions/2067)。像素娘另等皮肤接口和素材分发授权。

## 安装

先装好 dsh-TUI、**PowerShell 7**（PATH 中可运行 `pwsh.exe`）和 **Node.js 22.19+（22.x）或 24+**。[按 Google 官方指南安装并登录 Antigravity CLI](https://antigravity.google/docs/getting-started?tab=cli)，然后运行 `agy --version` 和 `agy acp --help`。插件要求 **agy 1.5.0 或更新版本**且支持 ACP。已验收组合：Windows、[dsh-TUI 0.20.2](https://github.com/ccch1mneyyy/dsh-TUI/releases/tag/v0.20.2)、DSH 0.2.2-rc.1、Node.js 24.18.1，使用离线 ACP 对端。

**只安装你信任的包。** 插件在 dsh-TUI 进程中运行，宿主不会把它放进独立沙箱。下面是命令行安装，不需要在 TUI 里再确认；TUI 的 `/plugin install` 是另一条有信任确认的入口。

从[发布页](https://github.com/Emilia-tan-Ovo/dsh-tui-backend-antigravity/releases/tag/v0.5.3-rc.1)下载 `dsh-tui-backend-antigravity-0.5.3-rc.1.tgz`。在 PowerShell 执行这条命令，把路径换成文件实际所在的位置：

```powershell
dsh plugin --profile dsh-tui add 'C:\Downloads\dsh-tui-backend-antigravity-0.5.3-rc.1.tgz'
```

**重启 dsh-TUI → 打开内核选择器 → 选 Antigravity。** 如果菜单显示未安装，先重开终端确认 PATH，或将 `DSH_TUI_AGY_COMMAND` 设为官方 `agy.exe` 的绝对路径（变量值不带引号或参数）。如果显示版本过旧，先升级 CLI。

## 使用

- **换主题：** 在 `/theme` 里选 **Gemini Starlight**（深色）或 **Gemini Daylight**（浅色）。本插件不会随内核切换自动应用主题。
- **继续会话：** 在原项目目录进入 Antigravity，用 `/resume` 选择原生会话。恢复失败时会报错，不会另开一个会话顶替。
- **停止任务：** 按 **Esc**。尚未发送的排队消息会留在输入区；确认后按 **Enter** 才会发送。
- **查看会话能力：** `/agy-commands` 列出当前会话提供的原生命令。`/model`、`/effort` 和图片输入取决于 agy 公布的能力。
- **调整工具权限：** 默认沿用 agy 设置。会话空闲且 CLI 支持原生恢复时，`/permission` 可选**工作区外访问**（关闭终端沙箱、保留审批）或 **Full access**（另会跳过审批）。只在任务确有需要时切换，用完切回原生档。

## 卸载和切回原内核

等任务结束或先停止，再从内核菜单切回 **DSH** 或 **Codex**。如果选过 Gemini 主题，可先用 `/theme` 切回。退出 dsh-TUI，在 PowerShell 执行：

```powershell
dsh plugin --profile dsh-tui remove dsh-tui-backend-antigravity
```

重新打开 dsh-TUI 即可继续用原内核；卸载不会删除 agy 的原生会话。

## 反馈问题

请在[本仓库的 Issues](https://github.com/Emilia-tan-Ovo/dsh-tui-backend-antigravity/issues)附上插件、Windows、dsh-TUI、DSH 版本和 `agy --version` 的输出，以及最短复现步骤和报错。请删去凭据、会话正文和私人路径。

## 从源码构建

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack
```

用上面的安装命令安装生成的 `.tgz`。

项目使用 [MIT](LICENSE) 许可证。第三方来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
