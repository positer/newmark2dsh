# Newmark2DSH

**Newmark capabilities inside DeepSeek Harness.** One self-contained plugin bundle provides persistent memory, desktop automation, an Agent API, and Dev/rDev presets over the shared `~/.Newmark` user store.

## Capabilities

| Component | What it provides |
|---|---|
| MemoryLab | Nine `memory_lab_*` tools, persistent structured memory, and a sidebar renderer |
| ComputerUse | Windows/Linux backends, 23 Windows actions (21 on Linux), real/virtual mouse modes, sparse/full observation, and exclusive takeover leases |
| Agent API | Four tools for model discovery, state, sending work, and stopping runs; structured results and error causes |
| Dev | Project-oriented development preset with the Harness kernel inspection and plugin management tools |
| rDev | The same development baseline with those kernel modification tools withheld |

The core loads all three components from this package. Components can be enabled independently in the plugin panel; presets are declared by the bundle patch. There are no separately installed component dependencies.

## Process window transfers and ownership in 0.2.27

On Windows, `computer_use` adds `process_push` (hidden → real) and `process_pull` (real → hidden). Select one top-level `window_handle`, an unambiguous `process_id`, or an existing `transfer_id`. NewMate responds with a spring pulse while the window smoothly flies out or contracts into it.

The original PID, creation time, application state and HWND are retained. This is an interactive presentation/control mapping, not native HWND-thread migration. Use the returned presentation handle for subsequent actions. Compatible Win32 windows must support PrintWindow and posted window messages; minimized windows must be restored first. Additional dialogs and other top-level windows require their own selection. Imported real windows are temporarily parked off-screen and restored with their original position and window style. The full desktop preview remains read-only.

Each Windows user has one real and one virtual takeover slot across all DSH hosts. Both may coexist; a transfer temporarily reserves both. DSH session identity, including Agent API calls, controls ownership. Stopping virtual takeover restores imported real windows and preserves exported applications. A guardian restores imports after host death and rebuilds an exported presentation after its display host fails, without restarting the original application.

## NewMate

On Windows, virtual-mode ComputerUse starts **NewMate**, a transparent, topmost, draggable mascot. A black-and-white animated border follows its silhouette while the virtual desktop is collapsed.

- Click NewMate to expand a read-only virtual desktop preview over the monitor containing it. Click again or press Esc to collapse.
- The border disappears while any Newmark preview is visible, including its closing animation.
- Entrance, press/release and completion use spring squash/stretch. The preview smoothly scales in and out; repeated clicks reverse the current transition.
- Configuration is grouped into Components and Configuration, with separate model and desktop-assistant cards. Both the configuration page and the DSH-themed right-click menu offer a synchronized 30%–300% continuous size slider. The default is 100% over a base size reduced to 75% of the original; the last size is restored on startup.
- NewMate reuses its drawing surfaces and paces coalesced frames toward 60 Hz. The read-only viewer uses GPU-composited transforms and keeps its renderer warm between expansions. Source capture cadence is independent of animation frame rate. DSH theme CSS and plugin overrides are retained by the menu.
- Size preferences live at `<user root>/computer-use/desktop-pet.json`. The root follows explicit plugin configuration, then `NEWMARK_USER_ROOT`, then `~/.Newmark`.

The preview does not forward user input to the source desktop. A lease started with `desktop: "hidden"` previews its isolated desktop; virtual mode without that option shows a composite of windows on the current desktop. Capture runs in a disposable process, clears stale frames after three seconds and retries. Real mouse mode retains the screen border indicator.

Windows uses the system .NET Framework to compile the bundled native helper, cached by source hash. This release was exercised on a single 2560×1600 display at 200% DPI; multiple-monitor hardware was not available for acceptance. Protected or exclusive GPU surfaces may not be capturable through PrintWindow.

## Install and use

Install through the DSH plugin manager:

```
plugin_manager action=install_bundle target=newmark2dsh
```

Enable the bundle in the plugin panel, then select the components you need. Restart the DSH host after updating an already loaded native/backend module.

For ComputerUse, acquire a lease with `takeover_start` before input and release it with `takeover_stop` when finished. Use `mouse_mode: "virtual"` for NewMate on Windows; add `desktop: "hidden"` for an isolated desktop. The tool receipts identify the active mode, lease owner, capture status and measured cleanup result.

MemoryLab shares Newmark's user store. Agent API uses the models enabled in the plugin's model configuration. The plugin does not contain model credentials.

## Package layout

- `index.js`, `client.js`: host composition and the plugin panel.
- `lib/`: shared root, configuration, model selection and error handling.
- `components/memorylab/`: persistent memory tools and renderer.
- `components/computeruse/`: platform backends, native indicators and NewMate assets.
- `components/agent-api/`: API tools and agent execution.
- `cordis.patch.yml`: core and Dev/rDev loader rows.
- `locale/`: interface localization.
- `.github/workflows/publish.yml`: tag-driven npm publication with provenance.

## Verification and releases

0.2.26 passed the development workspace's 195-check core gate and 12 focused GPU/native integration checks, including real hidden-desktop image decoding, reversal, warm reopen, size persistence and cleanup. A phase-separated 2560×1600 / 200% DPI fixture measured pet drawing at about 55 fps and viewer opening/closing at about 56/60 fps versus about 35 and 4/30 fps before optimization. These are local renderer measurements, not source-capture or hardware scanout guarantees. Validation scripts and local evidence are maintained in the development workspace, rather than being advertised as runnable files in this release repository.

Version tags must match the package manifest. GitHub Actions validates the self-contained bundle and required NewMate files, then publishes through npm Trusted Publishing (OIDC) with provenance. Publication is confirmed by reading and downloading the exact registry version.

## License

Proprietary. See [LICENSE](LICENSE). All rights reserved by Newmark AI.

---

# 简体中文

**将 Newmark 的能力接入 DeepSeek Harness。** 一个自包含插件包提供 MemoryLab、ComputerUse、Agent API，以及 Dev/rDev 预设，共用 `~/.Newmark` 用户库。

## 功能

| 组件 | 能力 |
|---|---|
| MemoryLab | 九个 `memory_lab_*` 工具、结构化持久记忆与侧边栏 |
| ComputerUse | Windows/Linux 后端、Windows 23 项动作（Linux 21 项）、真实/虚拟鼠标、稀疏/完整观察与独占接管租约 |
| Agent API | 模型发现、状态查询、发送任务、停止运行四个工具，以及结构化结果与错误原因 |
| Dev | 面向项目开发，带 Harness 内核检查与插件管理工具 |
| rDev | 相同的开发基线，移除上述内核修改工具 |

核心从本包内部加载三个组件，插件面板可独立启用组件；Dev/rDev 由 bundle patch 声明，无需另装子组件依赖。

## 0.2.27：窗口推出、拉入与接管互斥

Windows 的 `computer_use` 新增 `process_push`（隐藏→真实）和 `process_pull`（真实→隐藏）。指定一个顶层 `window_handle`、只有一个候选窗口的 `process_id`，或已有 `transfer_id`。NewMate 弹性响应，窗口平滑飞出或收缩进入桌宠。

保留原 PID、启动时间、应用状态和 HWND，采用可交互的呈现与控制映射，不迁移原生窗口线程。后续操作使用回执中的呈现窗口句柄。支持 PrintWindow 和窗口消息的 Win32 窗口；最小化窗口须先恢复，其他顶层窗口和新增对话框需要分别选择。拉入的真实窗口暂存屏幕外，返回时恢复原位置和窗口样式。全屏虚拟桌面预览仍然只读。

同一 Windows 用户的所有 DSH 宿主共享真实、虚拟两个接管槽，每种模式至多一个；两种模式可以共存，跨越时同时占用两槽。身份取自真实 DSH 会话，包含 Agent API 转调。停止虚拟接管恢复拉入的真实窗口，保留已推出的应用；宿主死亡后恢复导入窗口，导出呈现宿主崩溃后重建显示层，不重启原应用。

## NewMate

Windows 虚拟模式启动后，**NewMate** 以透明、置顶、可拖动的桌宠出现。虚拟桌面收起时，黑白渐变跑马灯沿本体轮廓运动。

- 点击 NewMate，在其所在显示器全屏展开只读虚拟桌面；再次点击或按 Esc 收起。
- 任意 Newmark 预览可见时取消描边，包括收起动画期间。
- 出场、按压/松手和完成退出使用弹性伸缩；桌面预览平滑放大/缩小，连续点击可反向过渡。
- 页面分为组件和配置两大板块，模型与桌面助手各有分级卡片。配置页与 DSH 主题右键菜单共用 30%–300% 连续滑杆，实时同步并自动保存。默认仍为 100%，本体基准为原尺寸的 75%，启动恢复最后大小。
- 桌宠复用绘制缓冲并以合并帧调度趋近 60 Hz；预览用 GPU 合成缩放，再次展开复用渲染器。源桌面捕获更新频率与动画绘制帧率分别计量。菜单保留 DSH 主题及插件 CSS 覆盖。
- 偏好文件为 `<用户根目录>/computer-use/desktop-pet.json`；依次使用显式插件配置、`NEWMARK_USER_ROOT`、`~/.Newmark`。

预览不会向源桌面转发用户输入。`desktop: "hidden"` 对应租约的隔离桌面；仅虚拟鼠标模式则预览当前桌面的窗口合成画面。捕获位于可回收的独立进程中，三秒无新帧时清除旧画面并重试。真实鼠标模式继续使用屏幕边框。

原生 helper 使用 Windows 自带 .NET Framework 编译，缓存按源码哈希区分。本版在单屏 2560×1600、200% DPI 下实测；多显示器硬件尚未验收。受保护或独占 GPU 内容可能无法通过 PrintWindow 捕获。

## 安装与使用

通过 DSH 插件管理器安装：

```
plugin_manager action=install_bundle target=newmark2dsh
```

在插件面板启用 bundle 和所需组件。更新已加载的原生后端后，重启 DSH 宿主使新模块生效。

ComputerUse 输入前先调用 `takeover_start`，完成后调用 `takeover_stop`。Windows 下用 `mouse_mode: "virtual"` 启动 NewMate；加上 `desktop: "hidden"` 使用隔离桌面。工具回执提供当前模式、租约归属、捕获状态及实际清理结果。

MemoryLab 共用 Newmark 用户库。Agent API 使用插件配置中准用的模型；插件本身不包含模型凭据。

## 结构、验证与发布

`index.js`/`client.js` 负责宿主组合与面板，`lib/` 提供共用配置、根目录和错误处理，`components/` 包含三个组件，`cordis.patch.yml` 声明核心与两个预设，`locale/` 为本地化，`.github/workflows/publish.yml` 为发布流程。

0.2.26 已通过开发工作区核心 195 项和 GPU/原生专项 12 项检查，覆盖真实隐藏桌面图像解码、反向动画、复用渲染器、大小持久化和清理。单屏 2560×1600 / 200% DPI 分阶段夹具测得桌宠约 55 帧/秒，展开/收起约 56/60 帧/秒；旧版对应约 35 和 4/30 帧/秒。这是本机渲染测量，不是源画面捕获频率或显示器扫描输出保证。验收脚本及本机证据保留在开发工作区。

版本标签必须与 manifest 一致。GitHub Actions 验证自包含结构和 NewMate 必需文件，通过 npm OIDC 发布并生成 provenance；以注册表确实能返回并下载指定版本作为发布完成依据。

## 许可

专有软件，Newmark AI 保留所有权利，见 [LICENSE](LICENSE)。
