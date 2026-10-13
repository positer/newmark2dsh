# 0.3.10：DSH 原生模型边界与 macOS CU 原型

2026-10-13。Windows 已安装验收；macOS 部分为待原生编译及硬件验证的源码原型。

## 模型兼容边界

Agent API 复用 DSH 公共 `llm.resolveModelInfo(provider, model)`、`llm.prepareCall(config, signal)` 与 `BlockAssembler`，对应对话层的模型选择、请求准备和标准流回复解析。prepareCall 返回的流句柄是单次使用的，每次重试重新准备。供应商插件负责鉴权、协议转换、SDK 和模型元数据；Newmark 不按供应商名称分支，也不单独实现外部 API 协议。

模型目录用于展示和旧宿主回退；存在公共模型解析接口时，以解析结果为准，允许插件动态提供目录外的模型。provider/model 必须与请求精确对应。图片能力同样读原生解析结果。供应商私有 replayState 仅在同一 provider/model 中重放，同名模型切换供应商时剥离，禁止跨供应商复用。

12 项集成检查使用本机安装的真实 DSH LLM Runtime、Cordis 和 BlockAssembler，并只注册内存中的适配器。覆盖请求准备、单次句柄、重试、默认参数和文本/工具/usage/finish/replayState。未安装 OpenCode/OpenAI 接入插件，未使用其凭据，未进行真实外部供应商调用。因此证据是公共边界兼容，不是所有第三方插件端到端承诺。参考 [OpenCode provider 文档](https://opencode.ai/docs/providers/) 和 [OpenAI 工具调用规范](https://developers.openai.com/api/docs/guides/function-calling)，协议变化由 DSH 供应商适配层处理。

## 文件导航

NewMate 对 assistant 回复中的文件引用进行路径及现存普通文件校验，不读取文件正文。客户端每次点击查询 DSH documentPreviews 实时注册表；有原生预览时恢复已选中的 DSH 对话并等待其原生侧栏挂载，再通过 sidebarRight 打开资源。没有可用会话、类型或原生打开失败，则通过 sessionController.openWorkspacePath 的 reveal 动作定位文件。没有静态后缀白名单，后续注册预览实现自动参与。导航草稿只留在当前窗口内存，历史仍不可编辑或重新激活。

## macOS 官方容器基线

基于 [deepseek-ai 官方 desktop 容器](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.md)：Electron 桌面及其 Cordis Host。没有采用第三方桌面包装器或私有 macOS Space 接口。公共宿主生命周期与原生桥仍需在目标官方构建中验收。

`computeruse/lib/darwin.js` 是延迟加载的调度层，Swift helper 源码按哈希编译到 `~/Library/Caches/Newmark-CU`，通过有界 NDJSON 通信。Windows 不编译、加载或执行它。没有安装好的 SDK 就返回缺失状态，不自动触发 Xcode 安装。

`darwin-native.swift` 使用 AppKit、CoreGraphics、Accessibility 和 [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit)。仅预检屏幕录制/辅助功能权限，不主动申请 TCC。实现应用和窗口枚举、观察、截图、应用激活、移动/点击、Unicode 输入、按键、滚动、有界 sequence/wait 和 takeover 生命周期。现代截图采用主屏逻辑坐标以避免 Retina 坐标混用。32×18 稀疏观察网格无变化时不发布 PNG，变化阈值 0.02，至少每 60 秒完整刷新，缓存有界。

交互原型要求 macOS 14+ 及 SDK 14+；旧系统只有观察降级路径。每个窗口标识记录 windowID 与 PID，动作前检查窗口存在及前台目标；helper 用 per-user flock 防止同时接管，退出/EOF 释放锁，接管有可见 NSPanel 描边。**这些保护不会屏蔽人的物理输入**：结果明确 `user_input_blocked:false`，不是 Windows 完整输入锁的等价物。未实现 Mac NewMate 桌宠同等能力；本轮不宣称生产级 Mac CU。

## 隔离虚拟桌面

macOS Space 是用户界面的组织方式，不能作为独立自动化隔离边界。源码试验采用 Apple [Virtualization.framework](https://developer.apple.com/documentation/virtualization) 与 [Linux VM 路径](https://developer.apple.com/documentation/virtualization/running-linux-in-a-virtual-machine)。`darwin-vm.swift` 仅承载用户手动提供 kernel/initrd/disk 的独立 VM 启动和窗口视图原型，macOS 13+，CPU/内存范围有界。没有共享目录、剪贴板或自动下载，NAT 必须显式启用。签名 entitlement 为 `com.apple.security.virtualization`，对应 `darwin-vm.entitlements.plist`。

**guest CU 传输和 Agent API 的 VM 路由尚未接通**。virtual/desktop/desktopName 请求当前统一返回 `macos_vm_not_provisioned`，绝不静默落到宿主物理桌面。VM 显示源码不等于隐藏虚拟桌面自动化可用。

Mac 验收需要：在官方容器版本中用本地 SDK 编译 helper；用户配置 TCC；检查正常/拒绝权限、Retina 与多屏坐标、前台保护和 helper 崩溃释放；手动提供 Linux 启动资产并签名 VM helper，确认隔离启动后再接通 guest 协议。Windows 本轮仅完成 13 项 Darwin JS 分派/边界/稀疏测量检查，**没有 Mac 编译、输入、VM 启动或硬件验收**。
