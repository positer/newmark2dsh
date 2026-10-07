# Newmark2DSH

**Newmark capabilities inside DeepSeek Harness.** One self-contained plugin bundle provides persistent memory, desktop automation, an Agent API, and Dev/rDev presets over the shared `~/.Newmark` user store.

## Capabilities

| Component | What it provides |
|---|---|
| MemoryLab | Nine `memory_lab_*` tools, persistent structured memory, and a sidebar renderer |
| ComputerUse | Windows and Linux backends, 21 actions, real/virtual mouse modes, sparse/full observation, and exclusive takeover leases |
| Agent API | Four tools for model discovery, state, sending work, and stopping runs; structured results and error causes |
| Dev | Project-oriented development preset with the Harness kernel inspection and plugin management tools |
| rDev | The same development baseline with those kernel modification tools withheld |

The core loads all three components from this package. Components can be enabled independently in the plugin panel; presets are declared by the bundle patch. There are no separately installed component dependencies.

## NewMate in 0.2.24

On Windows, virtual-mode ComputerUse starts **NewMate**, a transparent, topmost, draggable mascot. A black-and-white animated border follows its silhouette while the virtual desktop is collapsed.

- Click NewMate to expand a read-only virtual desktop preview over the monitor containing it. Click again or press Esc to collapse.
- The border disappears while any Newmark preview is visible, including its closing animation.
- Entrance, press/release and completion use spring squash/stretch. The preview smoothly scales in and out; repeated clicks reverse the current transition.
- Right-click for 50%, 75%, 100%, 125%, 150% or 200% size. The last choice is saved and restored before the next entrance, including after a host restart.
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

0.2.24 passed the development workspace's 195-check core gate, 17 native interaction checks, 18 motion/persistence checks, and five preference recovery checks. The locally installed DSH bundle completed real ComputerUse startup, status and teardown calls. Native lifecycle and multi-owner checks also passed. Validation scripts and local evidence are maintained in the development workspace, rather than being advertised as runnable files in this release repository.

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
| ComputerUse | Windows/Linux 后端、21 项动作、真实/虚拟鼠标、稀疏/完整观察与独占接管租约 |
| Agent API | 模型发现、状态查询、发送任务、停止运行四个工具，以及结构化结果与错误原因 |
| Dev | 面向项目开发，带 Harness 内核检查与插件管理工具 |
| rDev | 相同的开发基线，移除上述内核修改工具 |

核心从本包内部加载三个组件，插件面板可独立启用组件；Dev/rDev 由 bundle patch 声明，无需另装子组件依赖。

## 0.2.24：NewMate

Windows 虚拟模式启动后，**NewMate** 以透明、置顶、可拖动的桌宠出现。虚拟桌面收起时，黑白渐变跑马灯沿本体轮廓运动。

- 点击 NewMate，在其所在显示器全屏展开只读虚拟桌面；再次点击或按 Esc 收起。
- 任意 Newmark 预览可见时取消描边，包括收起动画期间。
- 出场、按压/松手和完成退出使用弹性伸缩；桌面预览平滑放大/缩小，连续点击可反向过渡。
- 右键选择 50%、75%、100%、125%、150%、200% 大小。最后倍率持久保存，下次出场前恢复，宿主重启后同样生效。
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

0.2.24 已通过开发工作区核心 195 项、原生交互 17 项、动效与恢复 18 项、偏好异常处理 5 项检查。DSH 本地安装已实际完成 ComputerUse 启动、状态查询和停止清理；生命周期与多宿主检查亦通过。验收脚本及本机证据保留在开发工作区。

版本标签必须与 manifest 一致。GitHub Actions 验证自包含结构和 NewMate 必需文件，通过 npm OIDC 发布并生成 provenance；以注册表确实能返回并下载指定版本作为发布完成依据。

## 许可

专有软件，Newmark AI 保留所有权利，见 [LICENSE](LICENSE)。
