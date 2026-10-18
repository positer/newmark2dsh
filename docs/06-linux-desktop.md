# Linux 真实／虚拟桌面实现与 WSL 验证

状态：2026-10-08 本地候选实现，未发布。Windows 正式安装仍为 0.2.29。本页中的 Linux 验收不能代替 Windows 发布验收，也不表示已经完成所有视觉效果的跨平台移植。

## 调研结论

| 环境 | 真实侧 | 虚拟侧 | 原进程跨桌面使用 |
| --- | --- | --- | --- |
| Linux Xorg | 当前 X11 display，保留既有 Linux CU 后端 | 独立、带认证的 Xvfb + Openbox | XComposite 画面与输入呈现映射，保留 PID、启动身份、XID |
| 本机 WSLg | Windows 上呈现的 Linux X11/XWayland 应用窗口 | 同上，独立输入和窗口树 | 已实测双向映射、原进程输入更新、恢复与异常退出 |
| 原生 Wayland | 应由 compositor / RemoteDesktop Portal 提供会话 | 可研究嵌套 compositor | 当前后端不支持；不能把现有客户端直接切换服务器 |

WSLg 官方支持 X11 和 Wayland GUI 应用的 Windows 集成；它不提供完整 Linux 桌面环境。因此这里的“真实侧”指 WSLg 的 Linux 应用表面，不是从 Linux 接管整个 Windows 桌面。[Microsoft WSL GUI 文档](https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps)

X11 窗口重挂载仅改变同一服务器的窗口树，不能把客户端连接迁移到另一台 X 服务器。SaveSet 用于在管理客户端异常终止时恢复其重挂载的其他客户端窗口。本实现据此使用原窗口 + 呈现代理，并对真实导入窗口设置 SaveSet。[Xlib 窗口与 SaveSet 文档](https://www.x.org/releases/X11R7.5/doc/libX11/libX11.html)

Xpra 是可选的成熟持久应用会话方案，支持断开／重连而应用继续运行；但既有任意应用窗口的独立 shadow 不宜视为通用无损迁移接口。本轮选择与现有 CU 工具协议直接兼容的 X11 呈现后端。[Xpra seamless 文档](https://github.com/Xpra-org/xpra/blob/master/docs/Usage/Seamless.md)

原生 Wayland 的 RemoteDesktop Portal 使用 CreateSession、SelectDevices、Start 建立授权会话，Start 通常弹出用户选择界面。这是另一条需要合成器支持的实现路径，不能用 X11 后台输入冒充已支持。[RemoteDesktop Portal](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.RemoteDesktop.html)

## 本机实现

调用入口仍是 `components/computeruse/component.js` 的 `computer_use`，保留真实 DSH session 身份绑定。`lib/linux.js` 在 Linux 上调用原生桥；真实桌面的既有观测和输入实现保留在原文件中，经过原生槽位校验后运行。请求队列覆盖校验与实际输入，避免释放槽位和输入交错。

- `linux-desktop.js`：Node/Python 行 JSON 协议、请求生命周期、异常回执、停止入口。
- `linux-desktop.py`：Qt NewMate、只读预览、X11 窗口枚举、隔离输入、XComposite 呈现、SaveSet 恢复、UID 范围 flock 双槽。
- `linux-process-guard.py`：通过私有管道看护 Xvfb，宿主死亡时结束它拥有的 X 服务器进程组；不在已经启动线程的 Qt 进程中使用 preexec_fn。
- `scripts/verify-linux-desktop.mjs`：实际 Xvfb / WSLg / 插件组件集成门禁，可指定 `NEWMARK_TEST_PACKAGE_ROOT` 检验安装后的包。
- `scripts/lib/linux-desktop-fixture.py`：显式测试程序，记录 PID、XID 和输入计数。生产启动没有引用或自动启动此夹具。
- `scripts/verify-linux-newmate.py`：Qt 合成事件和渲染检查，输出桌宠及预览图片，不冒充物理用户输入验收。
- `archive/20261008-linux-wsl/`：源码备份、失败回执、源代码和安装包测试记录、截图、打包清单与本轮报告。

### 隔离与进程生命周期

虚拟启动只创建 Xvfb、窗口管理器和 NewMate，不自动启动应用。桌面底色为纯黑。`launch` 仅在显式传入时通过 argv 启动，不经过 shell。虚拟 XTEST 只指向私有 DISPLAY；没有真实输入降级路径。

WSLg 的 `/tmp/.X11-unix` 是受它管理的挂载。本实现使用 Linux abstract socket 和随机高位显示号，禁用 TCP 与 filesystem Unix listener；授权使用 mode 0600 的 MIT-MAGIC-COOKIE 文件，运行目录限于当前 UID 的 0700 目录。没有修改 WSLg 的挂载权限或关闭 X 认证。

同一 Linux UID 的真实／虚拟接管分别持有一个 flock；不同 DSH 进程不能争用同一槽。两个槽可并存，同时持有时需要指定 mouse_mode。跨越操作还临时保留真实槽；另一会话占用真实槽会阻止跨越。

`process_push` 把虚拟窗口呈现在真实侧；`process_pull` 把真实窗口呈现在虚拟侧。返回的 window_handle 是呈现窗口，source_window_handle 保留原窗口。用 transfer_id 反向调用可恢复。映射输入依赖应用接受 XSendEvent；这不是通用于所有 GUI 框架的承诺。

停止接管会恢复真实导入窗口。显式导出的应用可以继续存活；未导出的自有启动进程被回收。该宿主必须等导出窗口结束后才能开始新的虚拟会话，以免旧应用污染新的空桌面。真实窗口还受到 X SaveSet 的崩溃恢复保护。关闭最后一个导出窗口会回收私有服务器。

### NewMate 与当前边界

Linux 使用同一位图和 version 2 大小偏好：默认倍率 100%，范围 30%–300%，菜单滑杆步进 0.1%，启动恢复上次值，配置文件改动实时同步。偏好取调用方 userRoot，缺省为 Linux 的 `~/.Newmark`；不读写 Windows 的用户偏好文件。

Qt 版已有透明拖动桌宠、贴合 alpha 轮廓的跑马灯、弹性出场／点击响应，以及平滑缩放展开／收起的纯黑只读预览。预览不向私有桌面转发用户输入。

仍未实现 Windows 完整视觉协议：当前 Linux 右键菜单是 Qt 原生 slider，尚未接入 DSH CSS/WebView 菜单；进程跨越目前只有桌宠响应，没有带完整遮挡／层级保证的飞入飞出覆盖动画。WSLg rootless 窗口存在负坐标占位，不能把它直接当作 Windows 屏幕位置。本实现没有伪造这些动画能力，mode_report 明确返回 `dsh_css_menu: false`、`transfer_flight_animation: false`。Windows 和 WSL 的接管锁也不跨 OS 共享。

虚拟观测支持完整截图、基于图像摘要的 sparse 检查与窗口标题 wait_for；不提供原生 Wayland 控制或 Linux accessibility 控件树。实际 GPU 呈现帧率、物理鼠标操作 NewMate、任意第三方应用兼容性不在本轮通过项内。

## 复现

本机：Ubuntu-24.04 / WSL2、WSLg 1.0.73.2、Node 22.23.1，真实 DISPLAY 为 `:0`。

依赖：

```sh
sudo apt-get install xvfb xauth openbox xdotool wmctrl python3-xlib python3-pil python3-pyqt5
node scripts/verify-linux-desktop.mjs
python3 scripts/verify-linux-newmate.py
```

工具调用示例（经 DSH 自动绑定会话身份）：

```json
{"action":"takeover_start","mouse_mode":"virtual","desktop":"hidden"}
{"action":"app_list","mouse_mode":"virtual"}
{"action":"process_pull","mouse_mode":"virtual","window_handle":"<X11 client XID>"}
{"action":"process_push","mouse_mode":"virtual","transfer_id":"<returned transfer ID>"}
{"action":"takeover_stop","mouse_mode":"virtual"}
```

最终测量与安装候选的校验值见本轮 `archive/20261008-linux-wsl/REPORT.md`。本地 tarball 沿用工作树的 0.2.29 版本元数据，但不是已经发布的 Windows 0.2.29 制品，不应作为同版本正式包分发。

## 2026-10-08 动画候选更新

NewMate 和预览改用 QOpenGLWidget，swap interval 为 1；以完成交换调度，WSLg 提前返回交换时按当前显示器刷新率校正频率，不再固定 16 ms。X11 采集在独占连接的线程执行，仅保留最新帧，直接 BGRX→Qt RGB32，静态纹理不重复上传；窗口映射的 33 ms 上限也改为按输出刷新率调度。WSLg launcher 自动加载 `/usr/lib/wsl/lib` 并优先 d3d12，保留显式驱动覆盖。

本机实际 renderer 为 D3D12 AMD Radeon 890M；稳定预览约 59.8 FPS，p95 18.8 ms。首次显示仍有窗口初始化开销；WSLg 的 frameSwapped 不证明物理垂直相位锁定。47 后端 + 15 Qt 检查通过，后者含真实 X11 窗口的出现/移除及工作线程回收。详细基线、试验失败与最终回执见 `../archive/20261008-animation-vsync/REPORT.md`。本轮源码尚未重新安装至上轮安装候选或生产 DSH。

## 最终发布与安装状态

Linux支持已随0.2.31发布并从远端tag重装到本机WSL，65个发布文件一致，安装后47后端+15Qt检查通过。此前“本地未发布候选”段落记录开发阶段；当前结论以 `../archive/20261008-release-031/REPORT.md` 为准。原生Wayland、DSH CSS菜单和完整Windows窗口飞行动画仍不在已支持范围内。
