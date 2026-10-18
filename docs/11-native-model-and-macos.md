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

## 0.3.12 源码候选：macOS 无障碍优先

已将 macOS CU 源码更新为无障碍 AX 优先：返回有界控件树，使用 AXPress 点击、AXSelectedText 插入选中文本、AXRaise 激活指定窗口；目标标识仅供同调用者和同窗口使用，有效期30秒。无需屏幕录制权限也可观察 AX 结构，像素采集失败时保留 AX 结果。稀疏测量结合控件标题、角色、状态、动作及几何变化，不将随机目标标识当成变化；不读取输入框值，安全字段拒绝编辑。无明确目标且控件不支持语义动作时保留 CoreGraphics 回退，已尝试失败的 AX 动作不重复投递。版本为0.3.12源码候选，尚未在Mac编译或实机验收；本机已安装/发布的0.3.11不变。

基于 Apple 的[公共 AXUIElement 接口](https://developer.apple.com/documentation/applicationservices/axuielement_h)和[AX命中测试](https://developer.apple.com/documentation/applicationservices/1462077-axuielementcopyelementatposition)。复用现有app_observe/app_click/app_type/app_activate接口和target_id，不引入另一套供模型调用的桌面工具。观察树最多160项、深度8、遍历预算250ms（单个AX IPC受50ms消息超时限制，预算不是实时调度保证）；父控件点击查找最多6层。元素值不回传，secure字段仅标识；设置选中文本只在焦点仍属于同窗口时允许。AXPress/AXSelectedText已发出但失败时停止，不发送重复CG事件。无障碍授权和屏幕录制授权分开预检，不自动打开TCC申请或设置。hash缓存helper更新可能改变macOS权限身份，签名/稳定应用归属及升级后的授权延续仍需Mac官方容器实际验证。

43项相关检查通过，其中AX18项包含12项JavaScript行为和6项Swift源码契约，Darwin13项、版本12项。Mac原生编译门禁在Windows上SKIP。旧computeruse-output-boundary探针无法加载当前DSH缺失的dsh-util-values模块，未计入通过数，不以替代shim伪装通过。

## 0.3.12 最终路线：Space＋AX与用户优先

按用户最终选择，macOS CU 采用 Space＋AX，不接入额外账户或VM。Space租约绑定用户预先放入目标Space的现有窗口；不创建Space或使用私有Space ID。Agent输入等到物理键鼠连续空闲至少100ms、且无按键/鼠标按钮保持按下后投递，最多等待5秒，超时不投递旧动作。每个输入保存鼠标位置和原前台AX窗口，成功/失败均尝试恢复；新用户操作优先，恢复失败明确报告，已执行动作不自动重放。后台点击/文本仅使用支持的AX动作；按键/滚动可能短暂激活目标Space再恢复。仍是0.3.12源码候选，Mac编译、100ms硬件时序及焦点/鼠标恢复均未实机验收。Windows安装/公开发布维持0.3.11。

调用：app_list选择新鲜mac:<window-id>:<pid>标识，用户将该窗口放入专用Space，再takeover_start传desktop:"space"、mouse_mode:"virtual"及window_handle。virtual在macOS明确表示共享输入的Space，不再表示VM；不会调用darwin-vm.swift。无需新账户。观察枚举包括离屏窗口，后台捕获不可用时保留AX结构。

输入保护使用Apple公共[HID事件源状态](https://developer.apple.com/documentation/coregraphics/cgeventsourcestateid/hidsystemstate)，读取事件计数、空闲时间和按下状态，不记录按键内容。Agent合成事件使用privateState和零用户事件压制间隔，避免自身动作重置硬件用户空闲判断。需要Input Monitoring与Accessibility；权限不可用时不发送输入。等待每20ms检查，100ms是下界，调度和IPC可能带来额外延迟。检测与AX调用仍有极短竞争窗口，因此不能宣称硬件原子隔离。

前台/鼠标快照失败时不操作。每个输入包括异常路径都会尝试恢复精确原AX窗口和光标；新用户输入或意外第三方焦点出现时保留其状态。context_restore报告cursor_restored、focus_restored、user_preempted；动作已执行但恢复失败返回context_restore_failed与action_applied:true，禁止自动重复该动作。Space切换取决于系统应用激活设置，无法验证目标前台时拒绝按键/滚动。没有未公开CGS/SLS Space接口，不自动移窗或创建桌面。

65项检查：Space22项（11项实际JS分派行为＋11项Swift源码约束）、原生AX18项、Darwin13项、版本12项。Mac原生SDK编译在Windows上SKIP。以上不是Mac硬件时序、鼠标恢复或焦点实测证据。

## 0.3.12 桌宠和normal边框补充

0.3.12候选补上Mac原生共享桌宠：Space接管单击展开/收起只读目标窗口预览，双击复用open-chat事件并唤起DSH，原生菜单退出陪伴/打开设置，气泡沿用主主题；没有独立托盘。normal CU以显式mouse_mode:real保留原生输入路径，边框按每个NSScreen渲染、点击穿透、跨Space/全屏显示，并在停止/退出时清理。CU主线程不再阻塞读取stdin。预览只在展开时500ms检查，不更换Agent AX标识，最多保留2张自产临时画面。此前100ms用户优先与操作后恢复约束继续适用。Windows本机安装和公开发布仍为0.3.11；此候选未发布。

桌宠NSPanel使用canJoinAllSpaces/fullScreenAuxiliary，NSApplication accessory模式，不额外创建状态栏图标。单击与双击用系统双击间隔消歧，拖动取消待触发单击。点击展开是只读预览，Escape/关闭/再次点击桌宠收起；双击写既有open-chat.json并通过NSWorkspace reopen DSH。NewMate在Mac不再调用Windows专用probeDesktop。

normal接管有真实模式支持，使用原用户优先输入检测及恢复。屏幕框按NSScreen分别创建，忽略鼠标，监听显示器变更；通过AppKit运行循环刷新。Space模式不铺全局屏幕框，使用CU归属的桌宠描边，陪伴单独开启不闪边。Native CU/桌宠都已在免费GitHub标准Mac runner成功编译，原生只读协议也成功；实际自产窗口集成及空间/鼠标物理验收详见云测试记录。
