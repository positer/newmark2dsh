# 0.2.27 — 2026-10-08

## Process window transfers and ownership in 0.2.27

On Windows, `computer_use` adds `process_push` (hidden → real) and `process_pull` (real → hidden). Select one top-level `window_handle`, an unambiguous `process_id`, or an existing `transfer_id`. NewMate responds with a spring pulse while the window smoothly flies out or contracts into it.

The original PID, creation time, application state and HWND are retained. This is an interactive presentation/control mapping, not native HWND-thread migration. Use the returned presentation handle for subsequent actions. Compatible Win32 windows must support PrintWindow and posted window messages; minimized windows must be restored first. Additional dialogs and other top-level windows require their own selection. The full desktop preview remains read-only.

Each Windows user has one real and one virtual takeover slot across all DSH hosts. Both may coexist; a transfer temporarily reserves both. DSH session identity, including Agent API calls, controls ownership. Stopping virtual takeover restores imported real windows and preserves exported applications. A guardian restores imports after host death and rebuilds an exported presentation after its display host fails, without restarting the original application.

# 简体中文

## 0.2.27：窗口推出、拉入与接管互斥

Windows 的 `computer_use` 新增 `process_push`（隐藏→真实）和 `process_pull`（真实→隐藏）。指定一个顶层 `window_handle`、只有一个候选窗口的 `process_id`，或已有 `transfer_id`。NewMate 弹性响应，窗口平滑飞出或收缩进入桌宠。

保留原 PID、启动时间、应用状态和 HWND，采用可交互的呈现与控制映射，不迁移原生窗口线程。后续操作使用回执中的呈现窗口句柄。支持 PrintWindow 和窗口消息的 Win32 窗口；最小化窗口须先恢复，其他顶层窗口和新增对话框需要分别选择。全屏虚拟桌面预览仍然只读。

同一 Windows 用户的所有 DSH 宿主共享真实、虚拟两个接管槽，每种模式至多一个；两种模式可以共存，跨越时同时占用两槽。身份取自真实 DSH 会话，包含 Agent API 转调。停止虚拟接管恢复拉入的真实窗口，保留已推出的应用；宿主死亡后恢复导入窗口，导出呈现宿主崩溃后重建显示层，不重启原应用。

