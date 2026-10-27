# dsh-whale-widget-dual

把之前的小鲸鱼全功能插件改成 **dsh-pet 式双模式**：

| `display` | 效果 |
|---|---|
| `web` | 只挂 DSH 页面（原 dsh-whale-widget 全功能 overlay） |
| `desktop` | 只拉起桌面 Electron 桌宠（原桌面版，功能不变） |
| `both`（默认） | 页面一只 + 桌面一只 |
| `none` | 都不显示 |

## 结构（照 dsh-pet）

```
lib/web-host.js   原 dsh-whale-widget 宿主（未改）
lib/index.js      双模式外壳：按 display 决定 apply web / spawn desktop
desktop/          原桌面桌宠应用（全功能，未改）
assets/           原插件素材（气泡图/音效等）
```

- 网页半侧：`web-host.apply(root)` → `/dsh-whale/*` 路由 + 页面注入；
- 桌面半侧：spawn `desktop/`（必需 `~/.dsh/electron/electron.exe` 或 `DSH_WHALE_ELECTRON_PATH`）；
- pid 文件去重；插件卸载/DSH 退出时 `taskkill /T /F`；
- 配置：`%USERPROFILE%\.dsh\dsh-whale-widget-dual.json` → `{"display":"both"}`。

## 安装

```powershell
& "$env:LOCALAPPDATA\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
    plugin --profile desktop add "link:<本目录绝对路径>"
```

改 `display` 后需重载插件/重启 DSH（网页注入只在启动时收集；桌面进程在 apply 时拉起）。

## 与独立 exe 的关系

`desktop/` 就是之前 `DSH-Whale-Widget-Desktop.exe` 的源码；桌宠窗口行为（透明、置顶、点击穿透、拖动、托盘）完全不变。

## 许可

插件代码来自 dsh-whale-widget（MIT，MeteorNOX/DeepSeek-Balance-Whale-Widget）；见 LICENSE / PROVENANCE。
