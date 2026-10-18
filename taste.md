# Newmark2DSH taste

## 2026-10-18 相对鼠标运动（`sweep`）：移动指针 ≠ 交付运动

**同一台机器、同一支注册了原始输入的 WinForms 探针上实测的 A/B，是这一轮所有判断的根**：`SetCursorPos` 连做两次，指针**移动**而原始包 **0**、增量 (0,0)；绝对拖动 `drag` 把指针移动 200 px，原始**运动**包仍 **0**（总包 2 = 两次按键跳变），增量 (0,0)；`mouse_event(MOUSEEVENTF_MOVE, 120, -60)` 产生 1 个运动包、增量精确 **(120, -60)**；`sweep`（方向 0、1200 px/s、250 ms）16 步、原始增量合计 **(300, 0)**。**结论写成规则：移动光标不是交付运动。** 读取原始增量的消费方（游戏转视角、指针锁定的相机）对绝对定位完全不可见，因此「用 `drag` 走一条长路径」在原理上不能转向，无论路径多长；而相对注入交付的正是注入的增量。

- **一切「运动已交付」的断言必须落在原始输入探针上**，不能从「指针动过」或「调用返回成功」推断。`mouse_event` 返回 `void`，系统不告诉调用方是否消费，所以动作回执只能报「注入了多少步」（`injected_steps`）与「指针实际位移」（`cursor_displacement`）这两个测量，绝不替它们下判决；把「注入被拒」和「指针被锁」混为一谈的自造错误码不许出现。
- **精确性属于注入增量，不属于光标位移**：本机 `HKCU\Control Panel\Mouse` 为 `MouseSpeed=1`，指针加速会让光标走 `gain × delta`（本机实测 gain 2.68 / 3.08 两次，同一注入 300 px 走出 805 px 与 923 px）。回执同时给 `dx`/`dy` 与 `cursor_displacement`，判据用前者。同理，**拖动的按键跳变本身就是原始包**，所以「这个调用产生了几个原始包」不是判据，判据是**运动包**数与两次按键跳变。
- **手势的恢复要用不产生原始运动的那条路**：`restore_cursor` 用绝对调用把指针放回起点（该调用不产生原始包），所以重复同一手势（转、再转）不会叠出一次「清洁动作」造成的假转向。这条性质与「绝对定位不能转向」是同一事实的两面。
- **隐藏桌面永远不是输入桌面**：系统不在那里维护指针、也不派发原始运动，所以**任何**工具都无法在隐藏桌面上交付相对运动；隐藏桌面能接受的只有投递式窗口消息，而读取原始增量的消费方不看那些消息。实测：注册了原始输入、每秒自发布且在手势期间存活（发布计数 13→15、文件时间前进）的探针，从一个「16 步全部返回成功」的 300 px 注入里收到 **0** 个包。规则：**这条路径按名拒绝**（`sweep_unsupported_on_hidden_desktop`），并把 0 包测量写进拒绝理由；绝不允许「`ok:true` + `injected_steps:16` 而什么都没发生」。agent 侧的 `sweep` 原语保留为这个否定结论的仪器与将来重测的入口，但工具面不可达。
- **「锁被持有时」先问是谁，不要先杀**：`takeover-lock.exe <owner-pid> <mode>` 的 owner 可能是**活着的宿主里一条活着的隐藏桌面路由**（本轮实测：`mode_report` 报 `lease.held:false / last_release_reason:'stop_all'`，同一份报告里 `hidden_desktop.active_routes` 仍有活路由、`requests_served` 15 → 19、`launched[0]` 正在隐藏桌面上跑用户程序）。杀掉锁不等于停掉那条路由，只会打断用户的工作——**先读 `hidden_desktop.active_routes` 与 owner 是否存活**：活 owner 是「有人正在用这台机器」（门禁应 SKIP 并写明原因），死 owner 才是泄漏（应 FAIL 并清理）。
- **`stop_all` 必须连同路由与锁一起拆**：本轮实测的缺陷是「lease 对象被释放、隐藏路由与锁子进程仍在」，于是外部世界看到一个自相矛盾的状态。凡是释放租约的路径都要问一句：它还持有哪些东西？
- **两个都要拿接管锁的门禁必须串行**：`takeover_start` 冲突会返回 `takeover_lease_occupied`，两个门禁同时跑就会把「占用」当成测量结果。变异实验（就地改源文件再还原）期间还必须保证没有别的进程 import 同一模块，否则被变异/被还原的中间态会被别人当成真值。
- **CI 步骤里绝不写死版本号或产物文件名**：`macos-validation.yml` 的「从 npm 产物执行 todo kernel」一步把 `newmark2dsh-0.3.14.tgz` 写死了，于是**版本一动，整条 macOS 矩阵就会因为一个与 macOS 无关的原因变红**（本轮实测：`unpacking …/newmark2dsh-0.3.18.tgz` 才是对的）。凡是 CI 需要「刚刚构建出来的那个文件」的地方，都从构建产物推导（glob / `--json` 报告），不要写常量。
- **云实测证的是它跑过的那些检查，不是功能在平台上的可用性**：macOS 三腿全绿只说明「0.3.18 在 macOS 没有回归、打包产物可用」，不说明 `sweep` 在 macOS 可用——平台没有实现的动作，矩阵不会替你测，文档也不许替它宣称。
- **阈值落在正解上的判据不是性质**：本轮新门禁一开始用「观测位移 ≥ 声称矩形的一半」判断真实拖动是否移动了指针，而一次**正确**的运行实测 `1280→1380`（观测 100 px、声称 200 px，因为起点复位与终点不同）恰好压在该阈值上——判据在正解与错误两侧都无法稳定区分。改成断言**精确性质**：拖动的最后一次写入是 `SetCursorPos(end_x,end_y)`，所以指针必须落在终点（±4 px，一次滚轮刻度的抖动）且确实走过至少 50 px；失败最多重试 3 次，每次把三个读数（调用前 / 调用后立即 / settle 后）记进 note。**能从代码推出精确落点的地方，不要用比例阈值去近似它。**
- **门禁的变异必须能被自己的对照跑通**：planted mutation 要求「变异后变红、还原后变绿」；还原后那次是**控制组**，它失败说明的是门禁/夹具不稳（例如探针窗口句柄还没发布就被读取），不是产品缺陷。控制组失败要当作门禁 bug 修，不能把「变异变红」单独当成通过。

[契约与边界](docs/14-cu-sweep.md) · [实测 A/B 与隐藏桌面拒绝](docs/03-computer-use-playbook.md)

## 2026-10-13 Newmark2DSH 0.3.14正式发布

0.3.14 已发布 GitHub/npm latest，并取回官方包核对全部 93 文件；Windows安装已替换为同一正式包，逐字节一致，官方ASAR与原配置/消息保留，heartBeat重启不重复投递。不可变标签 b5c8a3b46152da88bb1b16713fc93be9f575c320；只读官方云验收也通过。上一轮200/0/0完整门禁与Mac ARM六作业作为同一运行代码的验收证据；发布源只规范化Git文本换行，正式安装再次通过23项共享桌宠原生检查。

[发布证据](archive/20261013-release-0.3.14/REPORT.md)。


## 2026-10-13 Windows安装与Mac包边对照（0.3.14候选）

0.3.14 已安装本机官方DSH，尚未发布。修复Mac屏幕四层灰度框为顺时针周长黑白渐变，桌宠按Alpha裁剪保持比例；修复Win隐藏CU先启动后开启陪伴重建桌宠的问题。200/0/0完整门禁、92文件源码/安装一致；23共享桌宠、5尺寸、20原生GPU预览、3菜单检查通过。实际宿主待办模型激活、阅读保护、MCP和heartBeat重启不重放通过，原设置/消息/其他插件保留。Mac14/15/26 ARM六云作业成功，原生52场景、生产渲染1x/2x及实际双Space通过。视觉风格与比例对齐，不宣称逐物理像素一致、官方Mac DSH整机或Neo性能实测；Win不激活桌宠实体双击/右键本轮未独立复验。

[完整证据与边界](archive/20261013-win-mac-parity/REPORT.md)。


## 2026-10-13 macOS动态包边专项（0.3.14候选）

修正Mac桌宠矩形外框为图片Alpha轮廓波形，normal CU用四层平滑灰度边框，单调时钟3秒相位、30Hz common-mode计时器；CU决定闪边，预览展开/仅陪伴无闪边，右键菜单不中断动画，释放清理正常。ARM macOS14/15/26原生51场景与双Space均通过；实际连续像素变化、静态无闪边、轮廓邻接0脱离像素通过，生产渲染类1x/2x离屏检查通过。不是实体Retina或官方Mac DSH整机验收。0.3.14仍为未安装发布候选，包含此前toDo对话激活。

[专项证据](archive/20261013-macos-dynamic-border/REPORT.md)。

动态渲染验收须比较相邻帧真实像素，并与无描边基线核对新增Alpha邻接；不能用一张截图或outline_active代替动画证明。轮廓缓存随尺寸/backing scale变化，计时用monotonic相位，不用计数toggle。菜单跟踪使用common run-loop模式。区分名义计时频率、真实paint和物理屏幕FPS；离屏2x不能称实体Retina验收。


## 2026-10-13 toDoList 适时激活 NewMate（0.3.14 候选）

新待办默认激活一轮 NewMate，结合原生MemoryLab记忆和上下文回应或处理明确委托。阅读、草稿、输入、运行任务、静默和暂停时等待；适时按现有关注策略选当前或新对话。回复通过桌宠气泡、点击进入页面，不自动弹出窗口。页面/对话工具/MCP可选择仅原文提醒，旧待办保持原语义。持久化唯一激活任务与消息回执，失败/运行中崩溃不自动重试。21激活、20提醒、23steer、12网页与12版本检查通过；完整门禁200/0/0。六manifest同步0.3.14，无新组件；本轮未安装发布。

[实现与候选包记录](archive/20261013-todo-activation/REPORT.md)。

区分定时原文通知与用户委托的定时Agent激活。后者受关注与打扰门禁约束，但不消耗普通寒暄每日预算；不凭空扩大工具授权。领取时原子创建固定任务，已落盘回复优先消费恢复；不自动重跑不确定的模型/工具动作。历史记录缺mode保持旧语义；新创建显式可选双模式。


## 2026-10-13 0.3.13 已发布：Windows安装与Apple Silicon云验收

NewMate toDoList 已随现有五组件发布，未新增子组件。GitHub v0.3.13、npm latest=0.3.13；93个包内文件与Windows官方DSH安装逐字节一致。完整门禁200通过、零失败/跳过；实际GUI创建、到期等待陪伴开启、精确投递、第二次heartBeat重启不重放，以及实际宿主MCP创建/查询/取消通过。原39条消息、其他插件依赖和Loader配置保留，陪伴恢复原关闭状态。Apple Silicon macOS14/15/26完整和双Space六作业通过；每环境269项检查与5组真实Space场景，不包括官方Mac DSH整机安装、实体输入时序及Neo性能验收。首次npm传播门禁超时，后续官方取回及只读CI完整验证成功；同版本未重发。

[完整发布验收记录](archive/20261013-release-0.3.13/REPORT.md) · [公共发布](https://github.com/positer/newmark2dsh/releases/tag/v0.3.13)。

提醒先持久化固定消息ID再通知，重启按真实消费状态去重；同版本npm上传成功但检索未就绪时等待官方扫描，不重发/改标签。只读验证取回官方tar逐文件与不可变Git标签比对，同时核验latest；后续CI等待最长30分钟。测试数量按实际注册器观察更新，新增工具必须实际调用，不因旧字符串/CRLF假设失败而跳过。区分安装GUI、真实原生云夹具、浏览器宿主模型夹具与实体设备证据。


## 2026-10-13 NewMate toDoList（0.3.13 候选）

NewMate 新增 toDoList 页面按钮，可手动填写激活时间和发送内容、查看状态并取消未投递项目。任意 DSH 对话、NewMate 本身及认证 MCP Agent 可通过 newmate_todo_add/list/cancel 创建与管理。到期直接投递预存内容，复用现有关注保护和自动换新对话策略，不额外调用模型；陪伴关闭时等待开启，静默/暂停/气泡冷却沿用现有规则。固定消息 ID 和持久化投递回执防止重启重复发送，历史及取消记录保留。版本为 0.3.13 源码候选，属于现有组件更新，无新增子组件。尚未安装或发布。

定时待办归属 NewMate，不扩张 heartBeat 的重启与当前对话权限。时间用带时区 ISO 输入、毫秒 epoch 存储；既定内容直接投递，明确的用户待办不消耗自主推理预算。先持久化消息、再通知；重启仅依据消息回执恢复，不能反复投递。取消只改状态，不删除文件或历史。当前阅读/草稿/聊天优先，等待定时器不可改变无待办时的即时 steer 时序。

[实现、测试及候选包记录](archive/20261013-newmate-todo/REPORT.md)。


## 2026-10-13 Apple Silicon 渲染至操作验收

0.3.12 源码候选的渲染至操作验证已扩展：macOS 14.8.9、15.7.9、26.6.2 ARM64 每环境通过 93 组 JS 契约、45 组原生场景、28 组 Chromium/WebKit 页面场景。修复自身输入误判、组合键、macOS 26 滚动、桌宠预览遮挡、预览帧清理及 React fallback snapshot。视觉与 AX 同时可用、分别选择，交叉核验可选；Space 共享输入，100ms 用户 idle 优先。后续仅面向 Apple Silicon，Intel 旧结果仅归档。本地 288 项检查通过。尚未验收官方 Mac DSH 整机、实体键鼠、多屏组合与 Neo 硬件性能；候选未发布或安装。
原生视觉与 AX 保持独立可选择；不得强制交叉核验或在明确通道失败后悄悄切换。跨 Space 必须有真实 WindowServer 前后可见性证据；合成输入不能代表实体输入，原生事件路由不能代表 DSH 容器恢复。CI 仅 Apple Silicon，不添加 Intel 检查。

[完整报告与逐项证据](archive/20261013-macos-render-pipeline/REPORT.md)。

补测：macOS 14/15/26 ARM64 的真实双 Space 流程全部通过。修正离屏 AX 首次绑定、异步 Space 动画和原窗口可见性恢复；离屏像素可通过显式 activate_for_observation 受保护采集，默认/桌宠预览不会自动切换。官方 DSH Mac 容器及实体设备验收仍单列。



## 2026-10-13 免费Mac云验证结果

0.3.12候选已利用公开仓库免费标准Mac CI完成两轮测试：macOS 14.8.9/15.7.9 ARM64均编译CU与桌宠，通过原生只读协议及自产AppKit窗口AXPress/原前台窗口恢复集成；normal边框创建、Space无全屏边框也通过运行检查。210项本地检查通过。鼠标恢复目前为原生返回值证据；真实跨Space、实体键鼠100ms时序、桌宠点击/DSH恢复和边框视觉、Neo硬件仍待独立验收。没有取得可长期交互的免费云Mac，当前安装与npm latest仍为0.3.11。

源码契约、SDK编译、原生自产窗口动作、视觉几何与实体用户输入验收必须分开记录；免费CI不等同长期云服务器。不得为云测试修改TCC或宣称Space实现独立输入隔离。

[报告与证据](archive/20261013-macos-cloud-test/REPORT.md)。

## 2026-10-13 Mac桌宠展开与normal CU边框

0.3.12候选补上Mac原生共享桌宠：Space接管单击展开/收起只读目标窗口预览，双击复用open-chat事件并唤起DSH，原生菜单退出陪伴/打开设置，气泡沿用主主题；没有独立托盘。normal CU以显式mouse_mode:real保留原生输入路径，边框按每个NSScreen渲染、点击穿透、跨Space/全屏显示，并在停止/退出时清理。CU主线程不再阻塞读取stdin。预览只在展开时500ms检查，不更换Agent AX标识，最多保留2张自产临时画面。此前100ms用户优先与操作后恢复约束继续适用。Windows本机安装和公开发布仍为0.3.11；此候选未发布。

预览不转发输入，观察缓存和AX目标不能与Agent控制互相污染。normal与Space展示职责分开；用户主动点击桌宠是交互意图，不能被后台焦点恢复覆盖。Mac SDK编译、实际原生协议、自产窗口动作、跨Space和Neo硬件效果分别记录。

[本次记录](archive/20261013-macos-pet-border/REPORT.md)。

## 2026-10-13 Space 用户优先输入与恢复

按用户最终选择，macOS CU 采用 Space＋AX，不接入额外账户或VM。Space租约绑定用户预先放入目标Space的现有窗口；不创建Space或使用私有Space ID。Agent输入等到物理键鼠连续空闲至少100ms、且无按键/鼠标按钮保持按下后投递，最多等待5秒，超时不投递旧动作。每个输入保存鼠标位置和原前台AX窗口，成功/失败均尝试恢复；新用户操作优先，恢复失败明确报告，已执行动作不自动重放。后台点击/文本仅使用支持的AX动作；按键/滚动可能短暂激活目标Space再恢复。仍是0.3.12源码候选，Mac编译、100ms硬件时序及焦点/鼠标恢复均未实机验收。Windows安装/公开发布维持0.3.11。

Space不标为独立输入隔离。阻断对象是Agent，用户输入不被屏蔽；等待为至少100ms，不承诺实时系统的精确100ms截止。每个原生写操作前重验硬件状态，键鼠成对释放保持完整。恢复优先保留用户新状态；恢复失败携带action_applied，不能重放已执行动作。

[本次记录](archive/20261013-macos-space-input/REPORT.md)。

## 2026-10-13 macOS 无障碍辅助候选

已将 macOS CU 源码更新为无障碍 AX 优先：返回有界控件树，使用 AXPress 点击、AXSelectedText 插入选中文本、AXRaise 激活指定窗口；目标标识仅供同调用者和同窗口使用，有效期30秒。无需屏幕录制权限也可观察 AX 结构，像素采集失败时保留 AX 结果。稀疏测量结合控件标题、角色、状态、动作及几何变化，不将随机目标标识当成变化；不读取输入框值，安全字段拒绝编辑。无明确目标且控件不支持语义动作时保留 CoreGraphics 回退，已尝试失败的 AX 动作不重复投递。版本为0.3.12源码候选，尚未在Mac编译或实机验收；本机已安装/发布的0.3.11不变。

Mac CU 优先公共 Accessibility API。AX目标不得跨调用者、窗口或观察时效复用；明确目标的错误不降级成坐标事件，避免重复动作。仅选中文本插入，不能用AXValue整字段替换冒充输入。观察值脱敏、树规模与消息等待有界，语义标识更新不制造稀疏测量假变化。区分源码契约检查、SDK编译、TCC授权及硬件实际效果。

[本次记录](archive/20261013-macos-accessibility/REPORT.md)。

## 2026-10-13 0.3.11 回复内交互与原生侧栏

0.3.11 已安装并经 heartBeat 重启。生成式 HTML 直接在回复中渲染，支持输入、按钮、展开收起、源码及复制；当前对话和只读历史复用相同实现。文件链接在 NewMate 自己的侧栏挂载 DSH 实时注册的原生组件，未委托本体对话或自写文档预览器；无法支持时通过原生文件管理器定位。NewMate 获得 MemoryLab 新建、增量更新和标签工具，以及 shortMemory_add，仍没有删除许可。259 项相关检查通过，真实模型生成的计数器及原生 Markdown 已实机验证；89 个交付文件源码、包、安装一致。原有 37 条消息均保留，增加 2 条验收消息，陪伴开关保持关闭。0.3.11 已推送 main/v0.3.11 并发布 GitHub Release，CI 成功；官方 npm latest=0.3.11，下载的90个公开文件与发布源码一致。

文档展示只接入 DSH 原生注册组件，注册表动态发现，不按后缀自行实现渲染器。NewMate 有自己的原生组件生命周期，不能切换到本体对话偷用侧栏。生成式 UI 的脚本仅在不授予同源的 sandbox iframe 内执行，禁外部网络；窗口消息须验证来源和随机令牌。源码开关及尺寸变化不得重建交互状态。记忆写入验收使用隔离库，需断言任务真实完成，避免调度器捕获异常造成假阳性。

[本次验收记录](archive/20261013-generative-ui-test/REPORT.md)。

## 2026-10-13 0.3.10 原生兼容与 Mac 原型

0.3.10 已本地安装，并由 heartBeat 完成重启。Agent API 统一接到 DSH 公共模型解析、请求准备和标准流回复解析，兼容能力由供应商适配层提供；同名模型按供应商隔离，未安装或点名外部供应商插件做特殊适配。NewMate 文件链接采用原生侧栏能力优先、文件管理器定位回退，实时发现未来注册类型；无边框、加粗下划线，历史仍只读。桌宠菜单修复启动主题快照缺失、预热及重复加载，原生隔离窗口测得预热后 38 ms 打开。699 项相关检查通过，包含真实 DSH Runtime/BlockAssembler 内存适配器测试和 Windows WebView 集成测试。macOS 原生 CU 与 Virtualization VM 已加入源码原型，但未经过 Mac 编译/硬件验证，guest CU 仍未接通，virtual 请求明确拒绝物理回退。未远端发布。

模型兼容位于 DSH 公共服务末端：按 provider/model 精确匹配，供应商私有 replayState 不跨供应商复用，每次重试重新 prepareCall，使用原生 BlockAssembler 解析标准流，不按插件名字分支。原生 UI 服务通过公开 get/已声明 inject 取得，不跨入未声明 remote 子代理；文件预览查询实时注册表，由原生预览组件处理读取授权和正文。全局面板切换后先等待原生会话/侧栏挂载。macOS 虚拟请求不可降级到物理桌面；源码原型、SDK 编译、硬件验收和 guest CU 路由分别记录，不混称已支持。

[本次验收记录](archive/20261013-native-provider-darwin/REPORT.md)。


## 2026-10-12 0.3.9 主动消息内容约束

0.3.9 已本地安装并完成 heartBeat 重启。NewMate 明确区分用户提问与后台触发：主动联系要有具体可信的新内容，自然简短，最多两句、240 字符；没有可核实内容就保持安静，不主动发送能力边界、权限清单或“我不能为你做什么”的无请求说明。发送前拦截常见能力声明与长篇报告格式，不写聊天、不弹气泡、不触发换新或占消息额度；用户明确询问能力时仍如实回答。外部 agent 主动发信使用同一能力声明防线，完整正文和气泡摘要仍分离。

385 项相关检查通过。实际模型处理重启后台任务后 completed / not_actionable，未追加消息，35 条基线消息保持一致；任务物理消费为永久回执。最终源码、包、安装 84/84 文件同哈希。限频、静默、关注保护和记忆缓存保持，未新增模型审核或子组件，未远端发布。
后台信号不是用户提问，不能续答旧问题或主动解释能力限制。无可核实新内容时静默是成功结果，不是需要重试的失败。抑制必须发生在持久消息、未读、换新及桌宠通知之前，保留用户主动问答的诚实边界；不添加第二次模型调用做内容审核。

[本次验收记录](archive/20261012-newmate-proactive-format/REPORT.md)。


## 2026-10-12 0.3.8 重启恢复、桌宠配置与气泡投递

0.3.8 已本地安装并由 heartBeat 重启加载。修复原对话冷恢复缺少 `{{model}}`：在提示词装配前恢复该对话的供应商、模型和推理等级，保留运行中选择，禁止混用供应商或退回全局默认模型。重启辅助程序跳过已退出子进程的复用 PID，同时保留主进程身份检查。真实后台冷恢复已完成模型回复，任务物理移除并留下永久消费回执；随后再次更新重启，没有重复投递。

NewMate 取消 Windows 系统通知，仅使用桌宠气泡提醒，完整消息保存在聊天。右键菜单改为“退出伴随”“打开设置”；退出只释放陪伴的桌宠所有权，CU 可继续使用同一桌宠。配置页重构为组件卡片、模型与桌宠配置、插件更新、陪伴偏好四个区域，使用 DSH 的主题变量，独立开关和供应商模型隔离继续保留。

此次相关门禁 401 项通过；最终源码、包、安装 83/83 文件同哈希。真实重启与配置页截图已留痕，原生菜单动作经过独立窗口测试，工具限制下未完成用户桌宠的物理右键手势验收。未新增子组件，未远端发布。
恢复模型必须在 agent 发布及首次 loop 前完成，provider/model 必须作为同一选择对；重启只操作已核对身份的进程，不能误杀复用 PID。NewMate 的系统通知设置仅作关闭兼容，不允许从旧配置重新开启。桌宠菜单是配置入口，不关闭 DSH，不干涉 CU 的所有权。主题必须采用实际 DSH token，源码测试通过后仍需检查实际卡片边界和背景。

[本次验收记录](archive/20261012-heartbeat-model-context/REPORT.md)。


## 2026-10-12 0.3.7 NewMate 实时引导与关注保护

0.3.7 已本地安装：NewMate 用户输入直接加入当前运行的 steer guide，不再为每次补充另建排队轮次；界面运行中显示“引导”，补充要求在模型/工具边界生效，旧工具调用被配对为未执行结果，旧回答不会作为最终回复发出。用户打断自动 JSON 判断时复用同一持久任务转为普通回复；显式换新对话的输入会中断旧运行，用户任务优先于后台投递。

自动换新基于可观察的关注状态：正在阅读、近期输入/关注、已有草稿及用户任务保护当前对话。话题变化且至少八小时未互动，或一天以上且连续两次未回应时，在主动消息确实被允许发送前考虑换新；每天最多自动换新一次，旧对话只读保留，不清零预算、冷却或未回应退避。多窗口草稿具有所属窗口与事件序号，其他窗口和旧事件不能清除保护。用户消息上方只保留时间，删除两个“你”；NewMate 回复头像、名称、时间和格式保持不变。

实时引导/关注/换新 23/23、Agent API 268/268、客户端 123/123、低打扰激活 57/57、shortMemory/MCP 37/37、聊天 21/21、供应商隔离 18/18、版本 12/12，共 559 项通过。真实模型验证第二次输入 mode=steer，与第一次共用任务 ID，最终只回复“引导已收到”；实机截图确认用户气泡只显示时间，NewMate 标签完整。最终源码/包/安装 83/83 同哈希，25 条基线消息保留。heartBeat 重启 running，更新后任务已消费为永久回执。未新增子组件，未远端发布。

用户输入不能被当作等待上一回答完成的下一轮队列。引导保持在当前运行作用域，不暴露跨运行/供应商的全局缓冲；最新输入不能使旧工具继续执行。自动换新只依据元数据，不推断用户心理；宁可保持当前对话，也不在关注或草稿状态下切走。换新不得恢复历史或重置主动限频。后台持久任务仍保持交付职责，用户交互具有优先权。

[实现与实机证据](archive/20261012-newmate-steer-handoff/REPORT.md)。


## 2026-10-12 0.3.6 NewMate 唤起、气泡与回复预览

2026-10-12 用户实机确认：关闭 DSH 主窗口、保留后台运行后，双击桌宠可以恢复主窗口并进入 NewMate。此项验收通过；原生消息气泡点击仍待确认。下文待确认措辞为反馈前的历史记录。

0.3.6 本地更新：发送按钮保持正常右对齐；桌宠显式清除 Electron-as-Node 启动变量，通过已验证的 DSH 单实例入口唤起隐藏主窗口，并请求进入当前 NewMate。气泡跟随主设置的浅色/深色/系统外观，展示最多 80 字的独立摘要；完整正文保存在聊天页，MCP newmate_message 可传 summary。NewMate 回复约束为亲近务实的私人秘书，真实文件链接在回复内可点击，只读打开已引用的文本文件（2 MB 上限）。自包含 HTML 回复以卡片打开独立面板，支持展开、页面/源码切换和复制；iframe 采用不带同源能力的脚本沙箱及受限资源策略。未新增子组件、未远端发布。

客户端 123/123、版本 12/12、聊天 21/21、shortMemory/MCP 37/37、低打扰激活 57/57、呈现行为 8/8、原生共享桌宠 19/19，共 277 项通过；另有两条实机 HTTP 文件边界拒绝测试。实机验证 HTML 按钮计数 0→1、展开面板、文件预览及主设置浅色切换后原生 bubble_dark=false，已恢复原来的跟随系统外观。物理桌宠双击和原生气泡点击尚待用户确认，电脑控制工具拒绝对其他原生窗口的点击；不将页面测试计为这两项验收。

呈现只消费完整回复的独立摘要，禁止用气泡截断正文来替换持久消息。文件读取由用户点击触发且必须对应回复中的真实绝对路径，不扩充模型工具权限。交互 HTML 不与宿主共享源或系统能力；预览内容不能成为 MemoryLab 事实。原生用户点击唤起走验证的本体单实例入口，清除派生进程的 Node 模式；视觉层继续只共享 CU 桌宠，CU 决定闪边。

[实现与实机证据](archive/20261012-newmate-bubble-preview/REPORT.md)。


最终包与安装 82/82 同哈希，23 条基线消息保持完整；heartBeat 终态 running，更新后任务已完成并真实消费为永久回执。

## 2026-10-12 0.3.5 NewMate 发送按钮对齐

已本地安装 0.3.5：移除 client.js 中按桌宠运行状态固定添加的发送按钮右外边距，陪伴开启和关闭沿用同一输入框行布局。客户端 123/123、版本约束 12/12；源码/包/安装 81/81 一致，实机截图确认陪伴开启时发送按钮位于输入框右侧。未新增子组件，未远端发布。

[修复与实机证据](archive/20261012-newmate-send-alignment/REPORT.md)。


## 2026-10-12 0.3.4 NewMate 低打扰自主激活

已实现并本地安装 0.3.4：NewMate 不再依赖用户先开口、文件变化或外部任务才工作。开启陪伴后约 20 分钟进入自主检查；默认适中频率，每天最多 4 次自动模型判断、2 条自主消息，未回应后间隔从 4 小时逐步退避至 8/16/24 小时。夜间 23:00–08:00（北京时间）、正在输入、阅读聊天、DSH/后台任务或 CU 忙碌、锁定/安全桌面、离开设备 90 分钟时延后。读过主动消息也算回应兴趣，不要求打字。文件事件先合并，长期记忆正文的元数据变化、标签/短记忆变化与低频空闲检查共用预算；没有必要内容时不发消息。第一整天没有主动内容时允许一条不调用模型的轻量问候，后续同类兜底至少间隔三天。自主消息不抢焦点，首次系统提醒静音，持续未回应后只保留气泡/未读；外部 agent 连发保留全部内容但 30 分钟内只打扰一次。配置页新增主动开关、安静/适中/活跃频率、静默时段和暂停八小时。未新增子组件，patch +1；未远端发布。

主动激活 57/57、原生共享桌宠 16/16、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、Agent API 268/268、供应商隔离 18/18、版本 12/12；最终源码/包/安装 81/81 一致，原有 19 条消息保持完整。七天无用户主动输入的模拟共 8 次模型检查、8 条消息、首次 1 条系统通知。长周期以模拟时间及确定性模型结果验证；实机验证设置、暂停/恢复和原生可用性，未把模拟结果冒称真实七天运行或实际费用。实际定时模型已复验通过：本次没有合适内容保持静默，预算只加一次，旧失败任务未重放。

自主性不能等于高频模型轮询，也不能只靠文件事件触发。先用本地粗粒度元数据/用户可用性决定是否值得推理，再用持久预算控制判断与可见消息，生成结束时重查静默、忙碌和线程边界。冷却与额度重启不清零，不追赶漏掉的时点；自动任务禁止手动重试绕过预算，关闭主动功能只中止自动 run。查看旧历史不重新激活；无删除或任意执行能力。未回应时同时降低频率和通知强度，低成本问候必须限频且不伪造个性化事实。粗粒度用户输入时长不包含键位、窗口内容或屏幕采集。

[策略与验收证据](archive/20261012-newmate-initiative/REPORT.md)。


## 2026-10-12 0.3.3 NewMate 打开链路与界面细节

实机闭环：用户已确认在其他应用前台时，双击桌宠可以正常恢复 dsh 并打开 NewMate 当前聊天（2026-10-12）。下文的待反馈措辞属于确认前记录。

0.3.3 已本地安装：桌宠打开聊天时先恢复并激活已验证的 dsh 主窗口，保留单实例启动兜底；新增双击松键判定与重复事件抑制，单击/拖动不会误打开。打开事件优先处理，恢复焦点时立即检查，缺少布局服务时保留重试；已在历史或设置页时切回当前聊天并聚焦输入框。侧栏头像降低亮度并以更克制的比例向右显示；NewMate 标题、欢迎文案、快捷按钮、历史行、输入框细节和设置页陪伴开关几何已完善。历史仍为按钮进入的只读记录，CU 仍独占闪边，NewMate 无独立托盘。未新增组件，patch +1，未远端发布。

原生点击处理 6/6、共享桌宠 15/15、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、版本 12/12；最终包 80/80 文件与源码和安装一致。已实机检查界面与历史/设置到聊天的导航。真实鼠标双击因无激活工具窗口不能被电脑控制工具直接定位，等待用户反馈；不把事件单测或显式 IPC 夹具声称为物理双击验证。

呈现进程收到用户打开意图时，只恢复 executable 路径严格匹配的 dsh 窗口；无激活桌宠不能靠启动一个单实例进程替代显式前台恢复。用户打开事件先于通知权限路径，消费 ID 只在真实选择页面成功后更新；已在 NewMate 面板时要复位只读历史/设置视图，不修改当前线程。双击松键与原生双击事件须去重，拖动清除候选。实机物理手势、事件单测和 IPC 夹具分别留证。

[本轮验收记录](archive/20261012-newmate-polish/REPORT.md)。


## 2026-10-12 0.3.2 NewMate 页面与陪伴体验

已实现并本地安装 0.3.2：NewMate 提供常驻输入框、独立只读历史入口、新对话、设置和陪伴开关。历史不常驻，不允许编辑、重新激活、继续发送或重试历史任务；新对话关闭上一段记录，旧消息完整保留。侧栏共用桌宠图片，横向翻转朝向右侧，先放大 20% 后按反馈缩小 10%（最终为原尺寸 108%）。陪伴与 CU 共享一个桌宠，CU 单独决定闪边。NewMate 内核由 dsh Cordis 托管，原生辅助窗口只负责呈现并随宿主结束；无独立托盘，系统通知由现有 dsh 窗口承载。焦点不在 NewMate 聊天页时主动消息显示桌宠气泡，返回页面后收起。未新增子组件，patch +1，未远端发布。

专项通过：聊天 21/21、客户端 123/123、共享桌宠原生 15/15、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、Agent API 268/268、版本 12/12；最终源码/包/安装 80/80 字节一致。实机查看正常聊天、按钮进入历史与无输入框的只读阅读、右向图标、后台气泡和前台抑制。双击的原生事件单测与实际 IPC 导航通过；自动化工具不能直接定位无激活桌宠窗口，未声称完成真实鼠标双击。系统通知调用归属 dsh，不声称观察到 Windows 通知中心弹窗。旧总门禁的两个宿主/源码前提失败不归入本轮专项通过。

历史只读必须在服务端执行，不能只隐藏 UI 控件；查看历史不得修改 activeThreadId。共享桌宠用声明状态组合生命周期，CU 独占闪边决策；图片原资产不翻转，侧栏局部 transform 做光学比例与朝向适配。前台抑制结合页面声明与操作系统实际焦点；通知由 dsh 窗口承载，辅助呈现进程不得创建托盘。消息、记忆与模型身份保持各自边界，旧记录不删除。

[本轮验收与证据](archive/20261012-newmate-ui/REPORT.md)。


## 2026-10-12 0.3.1 供应商同名模型隔离

已修复并安装 0.3.1：Agent API 可用性与视觉能力以供应商和模型 ID 同时匹配，核心目录拒绝将外部供应商模型重标为自身；每次 run 固定原始供应商、模型与 reasoningEffort，后续切换不改变重试和后续轮次。记忆缓存仅复用模型无关的背景文本，不共享供应商能力或凭据。未新增组件，patch +1，未远端发布。

隔离专项 18/18、Agent API 268/268、客户端 123/123、陪伴 57/57、版本 12/12；已安装 80/80 文件与源码和 tarball 一致。真实同名 deepseek-flash 的两个供应商 profile 隔离，MCP 0.3.1 与 NewMate QA031_OK 回复通过，原准用模型已恢复。总门禁 195/197，帧循环源码断言及旧 CLI 宿主前提未通过，详见报告。[验收报告](archive/20261012-provider-isolation/REPORT.md)。

模型身份始终为 (provider, model ID)，供应商账户 ID 不归并为品牌名，展示名不能作为路由键。目录显式归属必须与查询供应商一致；图像能力只从该身份取得。共享记忆前缀的本地内容复用不能声称为供应商缓存命中。


## 2026-10-12 0.3.0 本地安装与实机验收

Windows DSH 已安装 0.3.0，80/80 包内文件与最终 tarball 和源码一致。实机验证 NewMate 侧栏/对话、DSH 与外部 MCP 调用、shortMemory 七天到期与灰显、两个独立开关、真实视觉识别，以及两次 heartBeat 全局重启：第一次自动投递后任务载荷移除，第二次不重复投递。实机修复冷启动入口缺失和 opencode-go 缺传输 sessionId，并补齐完整短记忆日期与输入框样式。准用模型恢复原 DeepSeek，桌宠倍率保持 60.1%。未发布远端。

[安装与实机证据](archive/20261012-installed-030/REPORT.md)。下文的“源码候选/未安装”是先前阶段记录；当前状态以本节为准。旧 CLI 完整 ToolRuntime 导入门禁仍未闭环，实际宿主路径已另行验收。

实机发现必须回到当前接口契约：组件状态键用宿主 name；provider sessionId 是传输关联而非持久会话。传输成功、模型实际输出、本地视觉真值和重启后消费分别验证；安装必须核对实际依赖内容，不信相同 tarball 定位器的缓存提示。

## 2026-10-11 0.3.0 新组件实现（源码候选）

已接入 NewMate 陪伴内核与 heartBeat 重启投递，五子组件独立开关；Agent API 支持真实图像附件；MemoryLab 增加 shortMemory（默认七天）及“总览/详细/短期”。NewMate 在首轮推理前原生注入全部标签关系和最近十条短期记忆，并开放 DSH/MCP 共用接口；无文件删除工具，文件测量默认关闭、变动去重且低打扰。heartBeat 成功投递后移除可执行任务，保留无正文收据。

本轮为源码实现与本地候选打包，尚未发布或覆盖本地安装。[验收记录](archive/20261011-newmate-heartbeat/REPORT.md)。[实现和接口](docs/09-newmate-heartbeat-implementation.md) · [OpenDot 参考边界](docs/10-opendot-reference.md)。下文的“仅设计”是先前预研记录，当前实现状态以本节与本次验收报告为准。

约束：原生记忆背景不构成执行授权；调用方身份由宿主提供；短期过期保留灰显；任务消费必须跨过宿主持久化屏障；缓存计数不能冒充提供商命中；只有显式来源绑定的陪伴任务可唤起原对话。源码、隔离测试、候选包和已安装状态分别陈述。

## 2026-10-11 陪伴内核设计原则（预研）

持续身份由持久状态与责任定义，Agent API 临时run不冒充长期会话；现有CU桌宠与拟议陪伴内核分开表述。稀疏灰度摘要仅作唤醒提示，不作语义、完成、情绪或压缩感知重构证据。进程级API调用必须有独立动作/资源许可层，名字级工具allow、工作目录和人格提示词均不替代沙箱。后台判断用只读门面，不能省略过滤器或开放全部工具；视觉输入需要请求级image-block证据。主动提示受本地预算与安静策略约束，记忆写入有来源、确认、纠正和撤销。所有参数先标提案，再测量校准。规格见 [内核设计](docs/08-newmate-kernel-design.md)。

## 2026-10-08 最终安装：0.2.31

NewMate 显示同步优化及 Linux X11/WSLg 支持已接入并发布。最终远端提交 c7b7165 / v0.2.31 经全新网络克隆拉回，Windows 和 WSL 分别重装同一 tarball；Windows DSH 已完全退出旧进程并重新启动，三个组件均由新宿主激活。65/65 发布文件一致，64 运行文件匹配源码；用户当前倍率 60.1% 保持不变。

0.2.31 另将窗口映射控制心跳与显示绘制分离，解决显示时钟停止时控制也停止的问题，避免 WM_TIMER 在高刷新绘制下饥饿。最终安装态：核心195/195、Windows原生专项102/102、CU边界34/34、方言45/45、隐藏路由54/54、Linux后端47/47与Qt15/15、真实模型33/33，以及配置slider门禁通过。实装桌宠约151绘制回调/秒，WSLg稳定预览约60交换回调/秒；不等同物理扫描帧率。测试映射、接管槽和辅助进程已清空。

npm索引当时仍返回404，当前明确安装远端拉回的tarball；不声称从注册表解析安装。首轮失败、后续修正、真实输入范围和完整文件树均见 [最终验收报告](archive/20261008-release-031/REPORT.md)。


## Linux X11 / WSLg 约定

真实 X11 和虚拟 Xvfb 的环境与输入路径必须分开；虚拟启动不继承 Wayland 显示选择，不自动启动 fixture，不关闭 X 认证。WSLg 使用 abstract socket 避开其托管套接字目录。窗口管理器明确就绪后才允许 launch，不能靠测试中固定长等待掩盖启动竞态。

窗口跨服务器采用明确的呈现映射语义，保留源 PID/start/XID；成功回执前验证 Composite 图像可读，真实导入使用 SaveSet，回收只处理本宿主拥有的进程组。Linux UID 级 flock 不冒充 Windows/WSL 统一锁。测试必须同时记录正常停止、helper SIGKILL、可信 DSH session 绑定和导出保活。

平台能力报告要区分 Xorg、WSLg rootless 和原生 Wayland；无法取得真实屏幕层级时不伪造飞行动画。Qt 原生 slider 不冒充已复用 DSH CSS。合成 Qt 事件、实际 X11 事件计数、物理用户输入以及 GPU 呈现帧率是不同证据。2026-10-08 候选测试与未完成视觉范围见 `archive/20261008-linux-wsl/REPORT.md`。

## 2026-10-08 进程迁移动画层级与纯黑桌面（0.2.29）

进程窗口推出/拉入动画读取实际呈现 HWND 的层级，真实窗口保持遮挡关系，虚拟来源跟随展开预览层并位于 NewMate 下方；动画不抢焦点、不强制收起预览。空桌面使用纯黑，移除正常状态工程提示，并修复零窗口枚举误报失败。核心 195/195、原生层级 8/8、GPU 15/15、窗口往返 17/17、空桌面逐像素 15/15。提交 45635d1 与 v0.2.29 已推送发布，经缓存对象加远端 fetch 核验后拉回打包重装，DSH 完全重启且界面显示 0.2.29；62/62 文件一致，安装后层级 8/8、空桌面 15/15、工具 25/25、CU 34/34，测试残留为零。详细状态见 archive/20261008-transfer-visibility/REPORT.md 。用户倍率保持 45.9%。

实现位于 desktop-pet.cs/js、desktop-transfer.cs/js 和 win32.js；新增原生层级探针，GPU 门禁支持无应用空桌面。归档 before 保存修改前源码，layers/gpu/transfers 保存原生回执，empty-desktop 保留失败，empty-desktop-fixed 保存修复后的纯黑截图，core.log 为完整回归。

## 2026-10-08 真实桌面输入补测

0.2.28 已安装包补测确认：DSH 配置页真实点击/滚动正常，滑杆 65%→181.7% 后桌宠与持久化同步；推出窗口真实鼠标/键盘计数 0/0→1/1，双向往返保留 PID、启动身份与 HWND，真实源窗口恢复后仍接收键盘。测试进程已清理。用户随后手动调整并明确要求保留 **45.9%**。透明 NewMate 窗口不在 Sky 可选目标中，右键被目标校验拦截，因此桌宠拖动、菜单滑杆和点击展开/收起仍未记为真实输入通过。详见 `archive/20261008-newmate-real-ui/REPORT.md`，其中保存 runner、原始动作回执、进程身份、输入计数、两张实机截图和清理记录。本轮仅增加验收记录，未修改产品包。

## 2026-10-08 NewMate 窗口推出/拉入（0.2.28，远端拉回重装）

已发布 `process_push` / `process_pull`，采用用户接受的交互映射保留原 PID、启动时间、HWND 和应用状态，配有 NewMate 弹性响应与 GPU 飞入飞出。全 DSH 在同一 Windows 用户下，真实/虚拟模式各一个接管槽；跨越操作同时保留两槽，身份绑定真实会话。已修复关闭竞态，导出应用保活、导入窗口恢复，并验证宿主及呈现层崩溃恢复。

最终版本 0.2.28（805d535b）已推送、从远端标签拉回打包重装，并完全重启 DSH。62 个已安装文件与远端一致，61 个运行文件与源码一致，用户大小仍为 65%。安装后：全工具 25/25、CU 34/34、真实模型 33/33、内核锁 8/8、双槽 16/16、身份 9/9、迁移 17/17、恢复 6/6、GPU 12/12。无测试映射、原生辅助进程或隐藏代理残留。npm 索引尚未同步，当前依赖指向远端拉回的 tarball。

前台真实鼠标复测尚未闭环：桌面自动化对 DSH 和呈现窗口均返回 `failed to activate captured window`；不将这一项计为通过。截图与原生消息路径验证分别有据。完整范围、失败修复和目录结构见 `Newmark2DSH/archive/20261007-cu-transfer/REPORT.md`（子项目中为 `archive/20261007-cu-transfer/REPORT.md`）。

## 2026-10-08 进程窗口映射约定

`process_push` / `process_pull` 保留原进程 PID、启动时间、状态和 HWND，通过可交互呈现窗口跨真实/隐藏桌面使用，不能宣称原生窗口线程迁移。显式选择单个顶层窗口；多窗口进程须指定 HWND，新增对话框另选。以回执中的呈现 HWND 继续操作。Windows 用户范围内真实/虚拟接管各一个，跨越时同时保留两个槽；DSH 调用身份不能由模型 owner_id 冒充。导出窗口保留其 Job Object，退出时只结束未导出的任务；拉入窗口在退出时恢复。宿主死亡和呈现层崩溃必须独立验收，不能以正常退出代替。

实现文件：`desktop-transfer.cs` 管理捕获、交互代理、Job 保活/清理、守护恢复和 GPU 动画；`desktop-transfer.js` 管理有身份校验的原生状态协议；`hidden-agent.js` 监测宿主退出；`takeover-lock.cs/js` 实现内核双槽；`lib/cu-caller.js` 绑定真实会话。`verify-desktop-transfer.mjs` 验证往返和正常结束，`verify-desktop-transfer-recovery.mjs` 验证强制结束恢复。归档 `archive/20261007-cu-transfer/` 包含 before 源码快照、evidence 门禁日志、integration-* 原生回执、recovery-* 异常恢复回执、native 编译试验、PLAN/STATUS/REPORT 工作记录；失败试验保留供复查。该段记录 0.2.27 候选阶段；最终 0.2.28 发布与重装结果见上方。

## NewMate 主题菜单与连续大小控制

配置页和原生菜单必须共用版本化的用户根偏好；调试隔离根时不可用屏幕上测试桌宠判断正式配置同步。滑杆写入串行合并最新值，原生偏好轮询不反向重复写入；初始位图前恢复大小。默认倍率与本体基准尺寸分别定义。菜单复用 DSH 实际结构、主题 token 和有序 CSS，不硬编码 CSS module 哈希；新增控件样式置于低优先级 cascade layer，允许插件覆盖。原生 WebView 按实际 devicePixelRatio 计算物理窗口尺寸，不能以 DeviceDpi 替代。验收包含 200% DPI、亮暗主题、CSS 覆盖、启动持久化及已安装文件核对。

## 2026-10-07 虚拟桌面提示与只读预览

吉祥物正式名称为 **NewMate**；桌宠窗口、右键菜单与预览提示统一使用此名称。

正式 DSH 安装应保留原包与 profile 备份，核对全部 shipped 字节并触发实际会话工具。异步启动的最早快照不代表最终状态；结束回执和独立 PID 查询用于确认清理。模型总结不得替代原始回执。

- 桌宠使用按时间步进的阻尼弹簧伸缩，轮廓随本体一起变换；缩小倍率时保留过渡画布，收敛后再裁去透明余量，不能裁切旧尺寸本体。桌面预览用连续比例缩放与淡入淡出，反向点击保留当前窗口、位置和速度。
- 最后选择的倍率原子保存至共用用户根目录，首次构建位图前读取，下次出场不闪现 100% 默认尺寸。测试必须隔离用户偏好；损坏文件回退至默认值并报告，不能影响桌宠启动。
- 描边在收起过渡的可见窗口彻底消失后恢复。动效验收以真实 HWND 矩形、输入、截图和独立进程恢复为依据；截图采样率不等于 UI 帧率。
- Windows 虚拟模式用透明桌宠，真实模式用既有屏幕边框；`mode_report.overlay_contract` 必须描述实际选中的提示形式。
- 描边来自图片 alpha 外轮廓，复用黑/白/黑/白与 3000 ms 周期；任何本插件预览展开时全局取消描边，最后一个关闭后恢复。原生窗口用属性标识，不靠可变标题猜身份。
- 拖动起点取 MouseDown 事件坐标，不能取消息被处理时较新的系统鼠标位置；拖动超过阈值后松手不触发点击。透明区域保持穿透，桌宠出现不抢焦点。
- 只读预览消费本窗口输入，不注入源桌面，不调用 SwitchDesktop。截图阻塞隔离在可结束的子进程中；3 秒无新帧清除旧图并显示状态，不把旧图持续冒充直播。
- 对 DPI-unaware 源窗口，在其 DPI 上下文里 PrintWindow，再缩放到物理边界。排除输入法服务窗口与所有桌宠/预览，避免黑块及递归镜像。
- 先关闭预览截图再审计隐藏桌面释放。停止、模式切换、启动取消与宿主死亡都必须清理；进程依据自己创建的对象与启动身份跟踪，不按进程名结束。
- UI 验收须有真实鼠标/键盘、原生窗口矩形和新截图；编译通过不代表拖动坐标正确。npm 清单必须包含 helper 源码及原图，实际包也要跑同一原生验收。

The code, behaviour and evidence style that must stay unified across every
conversation in this sub-workspace. Append new decisions here instead of
repeating them in chat. This file is subordinate to
[`docs/00-governance.md`](docs/00-governance.md): where the two disagree, the
parent rulebook wins and the conflict is named here.

## 0. Inheritance and precedence

**T-0.1** `docs/00-governance.md` is the rulebook extracted from the parent
project's `OVERVIEW.md`, `taste.md`, `archive/`, `agent.md`, `README.md`,
`Design.md`, `_local/dsh-dev-preset/` and `newmark-cu-lab/` (the last one was purged
from the parent working tree on 2026-09-30; see the header note in
[`docs/00-governance.md`](docs/00-governance.md), which governs this item going
forward). It governs this sub-workspace. Where this file contradicts it, the parent rulebook wins, and the
contradiction is recorded here as a dated decision instead of being silently
dropped. Project protocol, verbatim: *"When a document disagrees with the code,
trust the code, fix the document, and name the conflict."*

**T-0.2** The work cycle is READ → ACT → WRITE-BACK → ARCHIVE, and the write-back
is mandatory. A work item without its write-back is unfinished.

## 1. Target and its consequences

**T-1.1** The port target is DeepSeek Harness (DSH), not Electron. Two realms
exist and they are not interchangeable: a Host half in the DSH Node process and a
Client half in the browser page. A capability belongs to exactly one of them, and
a module that needs both must name which half owns each fact.

**T-1.2** UI chrome takes its colours, borders and surfaces from the `--dsw-alias-*`
tokens the live `Theme` provider lists. A literal colour carried into DSH chrome
is a defect. **The single exception is the takeover marquee stroke**, which is a
frozen Newmark product token set reproduced verbatim — see T-3.

**T-1.3** Never `require` a Harness Client package from a plugin's `client.js`
(`@deepseek-ai/dsh-client-ui-primitives` and every sibling). A throwing component
blanks the slot entry with `slot entry crashed in '<slot>'`, and the packages
change without notice. Copy the markup and behaviour, reference only tokens.

**T-1.4** A `dsh.client.inject` entry names another *package* whose activation
must precede ours. A name no enabled row provides fails composition, so it stays
empty unless a real ordering dependency exists. A Cordis service dependency
(`slots`) belongs in the plugin's own `inject`, never there.

**T-1.5** `host.call` is a dynamic-Cordis-package builtin and is **not** available
to an installed bundle. The Client half reaches its Host half through the HTTP
prefix route the Host half registers on `ctx.webServer`. One plugin, one prefix:
`webServer.register` throws on a duplicate `(kind, path)`.

**T-1.6** A refused fetch is state, never an empty store. A panel that cannot
reach its Host half says so; it never renders a confident empty view.

## 2. Recording a defect found by observation

**T-2.1** Every seat registered in a slot is an independent React tree. **A
component that uses plugin CSS classes must render its own `<style>` element in
its own tree.** A seat that relies on another seat's mounted stylesheet renders
unstyled.

> Recorded defect, v0.1 (2026-10-25): the Computer Use takeover overlay rendered
> `shell.overlay` with no stylesheet of its own, so the user saw the accessibility
> text and no stroke. Observed by the user: *"接管特效有文字没有描边"*. Fixed by
> rendering a shared `PluginStyles` element in every seat. The general rule is
> T-2.1; the specific cause is recorded so it is not reintroduced.

**T-2.2** A stylesheet written by a plugin uses its own custom-property names.
Reusing a host property name (`--marquee-angle`, `--g1`…) is a collision waiting
to happen; the values may be identical, the names must not be.

## 3. The takeover window effect is the original stroke and nothing else

**T-3.1** The takeover stroke is frozen product values, reproduced verbatim from
the parent's `.marquee-border::before` (`DESKTOP/src/ui/index.html:4195-4240` and
its later override at `:6399-6407`):

| Token | Value |
|---|---|
| colour stops | `#000 0deg, #fff 90deg, #000 180deg, #fff 270deg, #000 360deg` (pure black → white → black → white, closed loop) |
| period | `3s linear infinite` |
| width | `2px` |
| sweep | `conic-gradient(from var(--angle))` where the angle is a registered `@property` of `syntax: '<angle>'` animated `0deg → 360deg` |
| ring cut | two `linear-gradient(#fff 0 0)` mask layers, `content-box`, composite `xor` / `exclude`, `padding: 2px` |
| fallback | `@supports not (background: conic-gradient(from 0deg, red, blue))` → `linear-gradient(var(--angle), …)` plus a `hue-rotate` keyframe |
| compositing | `transform: translateZ(0)`, `pointer-events: none` |

**T-3.2** The effect is **only** that stroke. Do not add a brand-coloured glow, a
breathing frame, corner brackets, a scanline sweep, or a drawn status pill on top
of it. Lease state, owner and countdown belong to this plugin's own panel, never
painted over the frame. Accessibility text is allowed but must be visually
hidden (`clip-path: inset(50%)`), not drawn.

**T-3.3** The overlay is click-through: `position: fixed; inset: 0;
pointer-events: none`. `shell.overlay` is documented as a click-through layer
whose "entries opt back into pointer events", so an occupant must never block the
application underneath.

**T-3.4** The frame-wide layer is the DSH-native equivalent of the parent's
topmost border strips around the virtual desktop. The parent paints the whole
closed perimeter each frame so the sweep reads as one continuous head-to-tail
loop rather than a lap that clears and redraws; a single ring element reproduces
that property, and it must not be rebuilt on a timer.

## 4. The retired line must not appear

**T-4.1** Neither plugin's source may reference `newmark-cu-lab`, `CULab`,
`NES-T`, `NMEP`, `.nmep`, `onnx`, `onnxruntime`, `NPU`, `VitisAI`, `IDLock`,
`ryzenai`, `waveui`, `screenspot`, `screenparse`, `os-atlas`, or any learned
on-device model, artifact loader, ABI validator or schema emitter. This is a
machine-checked assertion in the gate, not a convention.

**T-4.2** The parent retired that line on 2026-09-26: *"桌面端已彻底停用
CULab/NES-T/NMEP/ONNX 端侧推理接口与依赖"* and *"CU-Lab 的模型、数据和 NPU 代码是
隔离的历史研究材料，不参与 Desktop 构建或运行"*. `.nmep` outputs are research
records, not deployable candidates. The frozen legacy source under
`archive/20260926-cu-local-model-retirement/legacy-source/` is a reference shelf,
not a port source.

## 5. Claims and evidence

**T-5.1** Every claim states its evidence class: **measured** (a command, a
reading from a live Inspect provider, a user observation), **read** (a quote from
a file with a citation), **inferred**, or **untested**. An unverified claim
presented as verified is the worst possible outcome.

**T-5.2** `PASS` is reserved for a gate that actually ran. `candidate`,
`estimate`, `untested`, `SKIP` and `BLOCKED` are separate words with separate
meanings and are never merged into a pass.

**T-5.3** Installing a plugin is **not** rendering it. `application: applied`
plus a live slot occupant proves the registration; it does not prove what a user
sees. Without browser control, visual verification stops there and the record
says so.

**T-5.4** A new gate must be shown to fail on the old code before it is trusted.
A green gate with no recorded failure it survived is not evidence.

**T-5.5** Every verification record ends with a `## Boundaries` block listing what
was **not** verified. A record without boundaries is incomplete.

## 6. Implementation style

**T-6.1** Plain JavaScript, ESM, no build step, no TypeScript. Node 24. Every
file carries a header comment stating what it is and which half of the plugin
owns it.

**T-6.2** Prefer the smallest change that satisfies the requirement, and prefer
existing patterns over new machinery. Small named helpers and constants over
duplicated numeric limits.

**T-6.3** Never edit generated output. `client.js` and `index.js` are authored by
hand in this workspace precisely because there is no bundler in the path.

**T-6.4** Bilingual user-facing text: the panel titles, labels and status strings
exist in `locale/en.json` and `locale/zh.json`. A refusal or error message names
the concrete condition, never a raw transport string.

**T-6.5** Diagnostics and probes stay in `scripts/` and never enter a plugin's
shipped files. The criterion is not "disabled by default" but "does not exist in
the artifact".

## 7. Workspace obligations

**T-7.1** `README.md`, `OVERVIEW.md`, `taste.md` and `archive/` stay current.
`OVERVIEW.md` carries the complete file tree with each folder's purpose and each
file's construction and role.

**T-7.2** Operations are archived under `archive/<YYYYMMDD-HHMMSS>-<short-slug>/`
with the before/after state of every touched file, what was done, the conclusions,
the evidence, the exact timestamps, and a `## Boundaries` block. Archive entries
are append-only: an existing conclusion is never rewritten to look better. A
changed decision is a new dated section that marks the old one superseded.

**T-7.3** The archive is local evidence, not runtime state, and never carries
secrets, tokens, screenshots of the user's desktop, or personal paths.

## 8. Dated decisions

**2026-10-25 — The takeover effect is stroke-only.** The user rejected the first
v0.1 overlay, which added a brand-coloured breathing frame, corner brackets and a
status pill around a stroke that was itself missing because the seat rendered no
stylesheet. Requirement restated by the user: *"我要求的效果是只有原版一致的描边"*.
Supersedes nothing; it fixes the v0.1 design intent.

**2026-10-25 — The port keeps the parent's four-axis mode space.** The live Host
contract reports `mouse(2) × observation(2) × lane(7) × lease(2)`, with a lease
TTL of exactly `120000 ms`. A port that implements only `real|virtual` is
incomplete, so all four axes are first-class in the panel and the module.

**2026-10-25 — The plugin reaches its Host half over an owned HTTP prefix.** No
`host.call`, no second application in `document.body`, no DOM written outside a
component. Recorded because it is the least obvious constraint of the DSH target.

## 9. Dated decisions, second round (2026-09-30)

**2026-09-30 — SUPERSEDES T-1.5: the plugin opens no channel at all.** The user
rejected the HTTP prefix as a shortcut: *"MemoryLab不要做Host端口，这是偷懒行为，我要求
你做成原生内置渲染器"*. The mechanism is now the harness's own index injection —
`webServer.tapIndex` transforms the HTML the shell already serves, and the snapshot
arrives as `window.__NEWMARK_CORE__`. A Client half in an installed bundle has
exactly two bridges to its Host half, and the other one (the harness Remote API) is
both an internal and unable to reach `~/.Newmark`, which sits outside any session
workspace. One snapshot per page load is not a compromise here: it is MemoryLab's
own contract.

**2026-09-30 — One plugin, two components, two switches.** `Newmark-Core` carries
MemoryLab and ComputerUse as components of a single bundle. Each is **retired**,
not hidden, by its switch: `components.memoryLab` and `components.computerUse`
default to on, and off means the Host half registers no tool and the Client half
registers no seat. The flags travel inside the injected snapshot, because the
injection lands in `<head>` before the plugin loader boots. The sidebar shows
MemoryLab; ComputerUse is implicit and owns only the takeover stroke.

**2026-09-30 — The shared store root is Newmark's, and the folder is joined.**
`root` is the Newmark user root (`~/.Newmark`); the store lives at
`<root>/Memory Lab`, exactly like Newmark's own `MemoryLabManager(rootPath)`.
**Never construct the store on the shared root itself.** Doing so once wrote an
empty `index.json` and an empty `components/` directory straight into the user's
Newmark root. The join is asserted in the release gate rather than trusted at the
call site, and the on-disk schema is Newmark's: `version: 2`, tag names keep their
leading `#`, `components` is an object keyed by slug, a length-1 `tagPaths` entry
is legitimate, and `updatedAt` belongs to the index alone.

**2026-09-30 — The overview's core rendering is ported completely; the CSS around
it is not.** The user drew the line explicitly: *"保留页面中组件渲染的通用接口接入，
暂不强行移植CSS渲染部分"* together with *"总览的核心渲染要完全完整移植"*. The stage
keeps the anchor/root/tag/leaf/addon classification, the three radial seeds, the two
edge kinds, bounded rotating repulsion (≤24 peers), per-kind springs, ambient drift,
72% velocity retention, the single dirty-frame scheduler, the 0.28 zoom-dots
threshold, the four focus modes, the synchronous pan transform, pointer-anchored
wheel zoom and the dot-mode tooltip. The panel around it uses theme tokens and does
not reproduce Newmark's materials.

**2026-09-30 — A frame-scheduled graph renders imperatively.** Physics and paint
write node positions and path data directly, once per dirty frame, inside a thin
React wrapper. A declarative re-render per frame would reconcile every node and both
paths of every edge on every tick.

**2026-09-30 — Reindex asks for a rebuild by reloading.** The deterministic rebuild
runs on the Host half while it renders the page index, so the panel's 重建索引 button
requests that rebuild by reloading, and the fresh snapshot arrives through the same
injection. Guarded by `config.reindexOnRender` (default on) for deployments that must
never write at render time, and a rebuild failure surfaces as `reindexError` in the
snapshot rather than being swallowed.

**2026-09-30 — Linux is a real target, and it refuses rather than pretends.**
`lib/linux.js` drives `xdotool` / `xte` / `ydotool`, `wmctrl`, `xprop` and a capture
fallback chain, presenting the same exported surface as `lib/win32.js`. It probes its
tools rather than assuming them, returns a structured `no_display` or
`missing_backend_tool` naming the tool, and returns `virtual_mode_unsupported`
instead of silently falling back to real input.

**2026-09-30 — The prohibition gate is blunt on purpose; fix the code, not the
gate.** A raw substring scan for the retired line's product names caught one of my own
comments. The comment was rewritten. Weakening a prohibition check to spare a
sentence is how a prohibition stops being one.

**2026-09-30 — A probe that reads the wrong file is worse than no probe.** An early
round-trip probe copied the store to a temp root but compared the copy's index while
the store wrote elsewhere, and reported a `read()` bug that did not exist. It hid the
real defect — a wrong store root — behind a wrong diagnosis. Establish which artefact
a measurement actually read before trusting its verdict.

## 10. Addendum — icons (2026-09-30)

**The bundle icon and the MemoryLab entry icon are Newmark's own marks, taken
verbatim.** The user asked for the plugin icon to be Newmark's vector icon and for
the MemoryLab entry to use Newmark's own MemoryLab icon. Approximating either is
now a defect the release gate catches.

- `packages/newmark-core/icon.svg` is `DESKTOP/assets/app-icon-dark.svg` copied
  byte-for-byte — the 1024-unit plate and glyph the product itself ships.
- The left-column entry draws the **Lucide `brain`** symbol, all eight path values
  in source order, exactly as Newmark draws that entry from
  `lucide-sprite.svg#brain`.
- The Lucide spec the project pins (24-unit viewport, **2-unit strokes**, round
  caps and joins) is the spec in the code. The earlier hand-drawn glyph used
  `strokeWidth: 1.7` and four invented paths; the gate now asserts both the eight
  real paths **and** the absence of the retired prefix.

Four assertions were added for this, taking the plugin gate from 68 to **72**.

## 11. Addendum — the gate tests the shipped bytes (2026-09-30, round 6)

The store gate now takes packages/newmark-core/lib/memory-store.js as its primary module under test, and the win32 gate takes packages/newmark-core/lib/win32.js. The retired copies are no longer the subject of any section; the store gate keeps one section that *observes* the divergence between the retired mirror and the shipped module rather than dropping that coverage. Assertions went 37 -> 40, with two single-site mutations proving the gate still fails on the rules it claims to protect. Rule B-60 in docs/00-governance.md is now satisfied for both features. Full detail in rchive/20260930-014200-newmark-core-merge/ADDENDUM.md.

## 12. Addendum — the Dev preset is component 3 (2026-09-30, round 9)

- **An agent preset is not plugin code.** It is a `@deepseek-ai/dsh-agent-preset`
  declaration carried by a bundle patch. Absorbing one means carrying its row, not
  wrapping it in the plugin's own module.
- **Never fake a switch.** A config boolean that gates nothing is worse than no
  switch: it looks operable and does nothing. `preset-dev` stays a Loader row
  because a row cannot be gated by a sibling row's config, and that constraint is
  stated rather than dressed up.
- **`String.replace` with a literal replacement is a footgun.** `
` sequences are
  expanded in the replacement — `$&`, `$```, `$'` — and `$``` splices the text
  preceding the match. Two files were damaged this way in one round. Use a function
  replacement or `split`/`join` for every programmatic edit.
- **Verify an assertion's calibration before trusting its failure.** Eight
  assertions failed on a nesting level (10 vs 14 spaces), not on the artifact: the
  count found the nested children of three groups instead of the 20 top-level
  plugins. A failing assertion is a claim about the artifact *and* about itself.
- **A migration is proven by discriminating.** Enabling and disabling the new owner
  and watching the row appear and disappear is the evidence that the row moved;
  "it still exists" is not, because it could be a stale composition.

## 13. Addendum — the preset switch selects; it does not hide (2026-09-30, round 10)

> **SUPERSEDED 2026-10-05 (0.2.16): the switch this section is about no longer exists.** The user
> removed it — 去除插件配置中的预设dev preset插件开关行，不用插件配置页调控默认预设 — so the
> conclusions below are kept as the record of what was learned, not as rules in force. The
> mechanisms it names are still worth knowing, because they are the three ways this area already
> failed silently; see §17 for what replaced it.

- **Read the Config schema before naming a field; never guess one.** The Dev preset's
  switch cost three rounds of guessed fields. `@deepseek-ai/dsh-agent-preset-registry`
  has exactly two config keys — `default` (required) and `selectedDefault` (volatile) —
  at `lib/index.js:471-474`, and `defaultId` is `selectedDefault ?? default` at
  `:493-495`. There is **no** field anywhere in the preset stack that hides a preset
  from the picker: `list()` (`:577-588`) and `remoteExportList()` (`:592-598`) emit every
  registered definition, and the picker renders every row it is handed
  (`dsh-client-ui-agent-preset/lib/client.js:897-1013`). The only way to remove a preset
  from that list is to stop declaring it — which is the mechanism this switch replaced,
  and which contradicts `selectedDefault`. So the row says **已选用 / 未选用**, not
  "hidden", and not 运行中 / 已关闭.
- **Write the field the shell itself writes.** The preset picker writes `selectedDefault`
  through the settings service (`dsh-client-ui-agent-preset/lib/client.js:1060,1072` →
  `dsh-settings/lib/index.js:501-537` → `dsh-config-editor/lib/index.js:24-26,98,110`),
  and it lands in the profile patch. A second, unverified mechanism beside a working one
  is how a switch ends up writing a field nothing reads.
- **The panel's key and the route's key are one constant, not two strings.** The shipped
  switch was a silent no-op: the client sent `component: 'presetDev'`, the route compared
  against `preset-dev`, and every click answered `unknown_component` on a branch that
  returns *before* the logger — so the file never changed and nothing was logged anywhere.
  A route that keys a public surface by an internal id fails exactly this way. The gate
  now reads the key out of the client row and posts that string.
- **A patch config REPLACES the config; it does not deep-merge**
  (`dsh-app-boot/lib/index.js:2769`, `:2932`). A profile entry that states one key of a
  plugin whose Config has a required field therefore cannot be appended — it would drop
  that field and fail the row at boot. Refuse, and say which key would be lost.
- **Prose is not code.** Two of this round's own gate assertions failed on the *comments*
  inside the object they were measuring — the same shape of defect as a check that cannot
  fail. Strip whole-line comments before asserting on source.

## 2026-09-30 Newmark2DSH 版本号约束（严格）

Newmark2DSH 子工作区**不使用标准 semver 的进位语义**。它的三段数字被重新定义为
「`0.<新增子组件的次数>.<其余改动的次数>`」，且**每一位满 10 不进位**。

### 规则

| 该次更新做了什么 | 版本变化 |
|---|---|
| **新增了一个子组件** | `<major>.<minor+1>.0` —— 例：`0.1.7` → `0.2.0` |
| **改动子组件本身**（MemoryLab / ComputerUse 内部） | `<major>.<minor>.<patch+1>` —— 例：`0.1.7` → `0.1.8` |
| **改动插件核心**（核心行、组合、控制路由、客户端面板、打包） | 同上，只进 `patch` |

**两位都不进位。** 这是刻意的，不是疏忽：

- `patch` 涨到 `0.1.9` 之后是 **`0.1.10`**，不是 `0.2.0`
- `minor` 涨到 `0.9.0` 之后是 **`0.10.0`**，不是 `1.0.0`
- 因此 **`0.12.13` 是合法版本号**

**理由**：这两段数字在这里不是「兼容性信号」，而是**计数** —— `minor` 数的是「这个包一共装进来几个子组件」，
`patch` 数的是「除此之外改了多少次」。让它们进位会把计数变成一个会溢出的语义位，
而计数本身才是这个包最需要读者一眼看到的东西：**卡片上有几个组件。**

### 因此 `major` 恒为 0

在「新增子组件」这条规则下，`major` 没有可表达的含义，保持 `0`。
若将来要改变这一点，必须先改这条规则，而不是让某次发布悄悄进到 `1.x`。

### 发布前必须满足

1. **三个清单版本一致**：`package.json`、`components/memorylab/package.json`、
   `components/computeruse/package.json` —— 它们作为一个包一起发布。
2. **版本在台账里有据可查**：每次发布在 `VERSION.md` 追加一行，写明版本、日期、以及
   **属于三类改动中的哪一类**。没有台账条目的版本视为未记录。
3. **步进合法**：新版本的 `(minor, patch)` 必须是上一版的 `(minor+1, 0)` 或 `(minor, patch+1)`。
   跳过、回退、或凭空造号都会被门禁拒绝。
4. **`files` 模式覆盖新文件**：新增子组件时，若它含有新的目录层级，
   `files` 必须同时覆盖（历史上漏掉 `components/*/package.json` 和 `components/*/lib/*.js`
   导致打包缺文件，是 `npm pack` + 临时安装才发现的）。

1. **清单版本一致**：`package.json` 与 `components/<每个子组件>/package.json` —— 它们作为
   一个包一起发布。子组件清单**由目录发现**（`verify-version-discipline.mjs` 扫
   `components/`），不再手写：「三个清单」这句在 `agent-api` 加入后就已经是错的，
   而门禁发现的是四个。（2026-10-05 修正。）

### 这条约束防的是什么

版本号是**这个包唯一的对外序号**，而它已经出过一次错：`0.1.3` 被发布后，
两次崩溃修复又升了一次 `0.1.4` —— 读者从号上无法区分「加了组件」和「修了 bug」。
把两段数字分别钉在两类事实上之后，**卡片上的组件数就可以从版本号直接读出来**。

## 模式是工具清单，不是权限（2026-10-05）

一个 Agent 预设（「模式」）决定的只是**这个会话看得见哪些工具**。它不决定这个会话
**能改什么** —— 那是沙箱与审批设置的事。所以：

- 给一个模式「增加权限」这句话，落到代码里就是**给它加行**，加完必须能说出加的是哪几行、
  这些行由哪个包的哪个文件定义。`dev` 预设的「创造模式内核修改权限」= `tool-cordis` +
  `skill-filesystem.config.customSkillDirs` + `tool-plugin-manager` 三行，逐行抄自
  `@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`。
- 抄写时**连 `!!js` 表达式一起抄**。`disabled` 是在行自己的上下文里求值的，重写一个
  「等价」的表达式得到的是另一个门禁，不是同一个门禁的改写。
- 行数用门禁钉住（20 → 21），但**计数不能代替逐行断言**：计数无法告诉你少的是哪一行。
  每一行能力都有一条按名字断言的检查。

## 声明写在两处，就必须比较（2026-10-05）

同一个预设行可以同时被 bundle 的 patch 和 profile 的 `cordis.patch.yml` 声明。二者
不是「重复」：**id 定向的 patch 会整块替换该行的 `config`**（不是深合并），所以
**profile 层的那份才是真正跑的那份**，bundle 的那份在两者分歧的那一刻就只是文档。

- 改一处不够。只改 bundle 等于没改，而这一点不会报错、不会有日志，文件看起来全对。
- 因此 `verify-preset-patch.mjs` 每次运行都比较两份声明的**能力行**，并在变异测试中
  验证过：只从 bundle 那份删掉 `tool-cordis`，检查变红。
- 比较**能力标记**而不是整份文本：两份声明里的 persona 一份是 `|` 字面块、一份是 `>`
  折叠块，逐字节比较会天天报差异，然后在一周内被关掉。
- 同样地：**四空格的 `disabled` 是 `config.disabled`，插件 Config 里没有这个字段**，
  它是被接受、被持久化、什么也不做的；只有**两空格**的 `disabled` 才是行的。
  这个残留从 2026-10-01 一直躺在 live profile 里，2026-10-05 清掉。

## 生效要说清是「哪一层」生效（2026-10-05）

- **`plugin_manager action=install_bundle` 对 profile 里已存在的依赖返回
  `application: restart-required` 且不 reload** —— 包文件更新了，运行中的树没有。
- **`action=set_bundle <name> enabled=true` 会 reload**：`reconcileProfilePatches` 重新
  读盘、重组合，且**任一 required id 挂掉就抛错**。所以 `application: applied` 且不抛错，
  本身就是「这几行是活的」的正证据 —— 这条按本工作区自己的规矩（`applied` 即 live）
  可以直接引用。
- 报告时必须分开说：**补丁层**的改动可以热组合生效；**Host 模块**的改动仍然要重启，
  因为 harness 缓存了 Host 模块代际。

## 两个声明之间的「差异」必须被计算（2026-10-05）

`rDev` 是「与 `Dev` 完全相同，只是没有那三处创造模式改动」。这是一句关于**差异**的话，
而差异恰恰是两份手工维护的声明最容易悄悄搞错的东西：给 `Dev` 加一个工具而忘了 `rDev`，
两个文件都依然「看起来对」。

- 所以门禁**计算**差异，而不是让人去比对：把两边的插件行取成 `id → 声明` 的映射，
  要求「只在 Dev 里的行」恰为 `['tool-cordis']`、「只在 rDev 里的行」为空、
  「两边都在但内容不同的行」恰为 `['skill-filesystem', 'tool-plugin-manager']`。
- 比较前**剥掉注释和空行**。注释是关于某一行的说明，不是那一行的一部分；紧贴在**下一行**
  上方的一条注释，按行切分会算到上一行头上。第一版没剥，于是 `tool-jobs`、`tool-web`、
  `present` 三行「因为散文而不同」—— 一个会被散文触发的断言，最后一定被人放宽到没有意义。
- 生成也只能保证生成那一刻：`rDev` 是从 `Dev` 块**脚本生成**的（每一处改动的形状都被断言），
  但防止此后漂移的是门禁，不是这次生成。

## 存在性匹配 ≠ 行相等（2026-10-05，同一个下午就被抓到的洞）

新写的 rDev 断言最初用**存在性正则**检查 `skill-filesystem`：

```js
/^ {10}- id: skill-filesystem\n {12}name: '...'$/m
```

变异门禁给 rDev 加回一个 `customSkillDirs`，**release gate 全绿** —— 因为
`- id: skill-filesystem` 和它下面的 `name:` 行**依然存在**，正则只要求这两行相邻，
后面接什么它不管。也就是说 rDev 可以悄悄拿回三分之一的能力，而门禁一句话都不说。

**规则**：当断言的对象是「这一行**就是**那样」时，用整体相等（把该行的声明文本与期望
文本逐字比较）；存在性正则只用于「这一行**在**」这类断言。这条不是推理出来的，是
`measure-dev-rdev-mutations.mjs` 第一次运行就打出来的。

## 引用一条约束前，先核对它约束的对象（2026-10-05）

`verify-newmark-core.mjs` 里有一条从真实事故写出来的断言：「没有任何包被多于一行作为目标」，
引用的证据是 fatal boot error `resolves from multiple active Loader sources`。这条**规则本身对**，
但**范围写宽了**：那条 fatal 属于 **client-module registry**，而它被套用到了全部 Loader 行上。

反例是出厂自带的，不是假想的：`@deepseek-ai/dsh-web-app` 一口气声明四行
（`preset-standard` / `preset-ptc` / `preset-minimal` / `preset-cordis`）**全部指向**
`@deepseek-ai/dsh-agent-preset`，应用照常启动 —— 那个包的清单里**根本没有 `dsh` 字段**，
不贡献 client bundle，自然撞不上。

- 断言现在写成它真正约束的两件事：**bundle 自己那个带 client 的包只被一行寻址**；
  **其他被多行寻址的包必须是不带 client 的那类**。
- 修正一条过宽的断言时，旧的理由不能删掉，要**改正并保留**：那条事故是真的，
  只是它的作用域被读错了。

## 没人读的期望清单比没有清单更糟（2026-10-05）

`verify-newmark-core-reinstall.mjs` 里的 `REQUIRED_ROWS` **没有任何断言读它**，而且仍然写着
`newmark-memorylab` 和 `newmark-computeruse` —— 自组件变成由核心行组合的嵌套包之后，
这两行早就不存在了。没人读的清单不会失败，只会**看起来像覆盖**。

- 发现后：把清单改成真实的行，并在原地写明它**未被强制执行**，而不是顺手把它接进
  `assertOutcome` —— 完整卸载重装循环是破坏性操作，不是那一轮该跑的东西。
- 判据：一个常量如果没有任何读者，它要么被接进断言，要么被标注为「未强制」。
  让它静静躺在那里充当覆盖，是最坏的一种。

## 17. 删一个开关，要连它的写入端一起删（2026-10-05）

用户的要求：去除插件配置中的预设 dev preset 插件开关行，不用插件配置页调控默认预设。
面板那一行只是**入口**；真正确立「配置页能改默认预设」这条事实的，是它下面的整条链：

```
面板行 → POST /newmark-core/components（presetDev 分支）
       → lib/preset-row.js（planPresetWrite / setPresetSelected）
       → <profile>/cordis.patch.yml 的 agent-preset-registry.config.selectedDefault
```

只删第一环，剩下的三环依然可以被任何能发 POST 的东西调用 —— 而这条链已经在这里
**静默失败过三次**（写进 `config` 里没用的 `disabled`、写在声明行上的 id 定向
`disabled`、面板发 `presetDev` 而路由比 `preset-dev` 的静默空操作）。留下一个
「也许以后有用」的分支，就是把一个**已经证明会失败的东西**留在可触达的位置。

- **判据**：删一个用户可见的控件时，问「它下面还有什么能被调用」。入口删除不等于能力删除。
- **被删掉的模块要问它还有什么读者。** `lib/preset-row.js` 734 行里，只有解析那一半还有
  真实读者（门禁要比较两份声明）。解析器因此**移出 package**，落到 `scripts/lib/`：
  一个 `lib/` 文件没有运行时调用者，读起来就是随插件发布的代码。留在原地、注释一句
  「现在只给门禁用」，是把「随包发布」和「只给门禁用」这两件事混在一份文件里。
- **历史不删，标注 superseded。** §13 关于那个开关的结论是真实学到的东西（读 Config
  schema 再命名字段、写 shell 自己写的那个字段、键必须同一个常量），它们解释了这条链
  为什么失败过。删掉它们，等于把「为什么不能再来一次」的证据一起删掉。

## 18. 断言一个「不存在」，必须同时断言它不会对散文开火（2026-10-05）

删掉写入端之后，门禁里最有价值的断言变成了**否定式**的：没有写在 profile patch 的模块、
没有 `profileContext` 注入、没有 preset 分支、没有 preset 行。否定式断言有一个特有的
失败模式：它匹配到**注释**就变成一个假报警，然后被人加 `stripComments` 加到自己都不信。

- 所以 `measure-preset-write-path-mutations.mjs` 里除了四个「重新长回来」的变异，还有
  **一个反向用例**：往 `index.js` 里放一行提到 `PRESET_COMPONENT_KEY` /`setPresetSelected`
  的**注释**，要求门禁保持**全绿**。如果哪天它变红，说明上面那些检查已经是在匹配散文，
  早晚会被放宽到没有意义。
- 配套动作：门禁自己先剥整行注释再匹配（`filter(line => !/^\s*(\/\/|\*|\/\*)/)`），
  让「结构性」成为代码事实而不是注释里的承诺。

## 19. 「未验证」要写成谓词，不是写成某一次会话（2026-10-05）

`SCOPE-RULE.md` §5 与 `POST-RESTART.md` §5 都写「需要你在 GUI 里开一个 **Dev** 任务」。
真正让这条检查可做的性质不是「Dev」，而是**这个会话的呈现是 `ptc`** —— 而 `rdev` 同样满足它，
所以那次检查最终是由一个 `rdev` 会话关掉的，不是按清单点的那一个。

- **判据**：写「仍未验证」时，写**可判定的谓词**（"呈现为 ptc 的会话"），不要写**一个实例**
  （"一个 Dev 任务"）。实例会过期、会认错，谓词可以从磁盘上核对。
- **顺带的好处**：谓词能被**意外的会话**满足。这一轮就是用户随手开的一个会话把上一轮的欠账关掉的 ——
  前提是当时愿意去核对谓词，而不是看到「不是 Dev」就把它记为「还是没验」。
- 核对方式要落到字节：`agentPreset` 从 `session.v4.jsonl.zstd` 的头里解出来，不是从"我觉得我是"。

## 20. 两个字段各自为真，合起来仍可以是错的（2026-10-05）

`tool_scope: "conversation"` 和 `tool_reach: "process"` **两条都是实话**，回执也照实报了。
但它们合起来描述的东西不成立：清单来自对话（42 个），执行落在进程层（11 个可达），
**中间 31 个被列出却调不动**。

这正是 `component.js:805-809` 自己写下的、这个配对「存在是为了避免」的那件事：

> a tool the list showed but the resolved layer does not carry would answer `UNKNOWN_TOOL` at call time.

- **判据**：当一个回执同时报出「谁的清单」和「哪一层执行」时，这两个字段之间有一条**独立的不变量**：
  **清单 ⊆ 可执行层**。它必须被单独断言，因为两个字段可以同时为真而整个组合为假 ——
  分别看每个字段的门禁，永远抓不到这一类。
- 0.2.17 的 13 条新断言问的是「向 registry 要了哪个 scope」，问得很对，但**没有一条问
  「要来的东西在那一层执行得了吗」**。断言了坐标，没有断言坐标之间的关系。
- 一个缺口能躲过 243 条断言，不是因为断言少，而是因为**没有一条断言落在两个字段的乘积上**。

## 21. 要证明「一边有、另一边没有」，对照必须只存在于一边（2026-10-05）

验证 ptc 下 `dispatchScope()` 是否真的没把 agent 带走时，「`memory_lab_query` 能调通」毫无判别力 ——
它在进程层里也有，两种答案都会通过。有判别力的是 `read`：**在对话目录里，不在进程层里**。

- `memory_lab_query` → exit 0（可达，但证明不了任何事）
- `read` → **`unknown_tool`**（刚被目录列出、会话也确实有它，却调不动 → 证明 agent 真的被丢下了）
- **判据**：做「A 生效了 / 没生效」的对照时，选那个**只在一侧存在**的输入。
  两侧都有的输入，无论结果如何都不构成证据，只会让人以为验过了。
- 推广：把这条做成**全量**而不是抽样 —— 42 个里 31 个非包内工具逐个探测（13 个真实参数、
  18 个空参数以免万一可达时产生副作用），31/31 `unknown_tool`、包内 0/11。
  「抽样几个都失败」和「全量都失败」在报告里是两个强度的句子。

## 22. 缺陷报告最硬的依据，是代码自己写下的意图（2026-10-05）

§20 那个缺口之所以是**缺陷**而不是**口味问题**，唯一的理由是它和组件自己的注释相反。
如果只写「我认为 ptc 下这样不好」，这就是一条意见；引了 `component.js:805-809` 之后，
它是这个组件**没有兑现自己声明的契约**。

- **判据**：报缺陷时先去被指控的那段代码里找它自己的承诺（注释、描述、`RUN_ISOLATION` 这类常量文本）。
  引得到，就是契约未兑现；引不到，就要如实降级成「建议」。
- 对照组：**根因要落到行号**。这次是 `dsh-tools/lib/index.js` L3100 的 `collapses()`、
  L3058 的 `nested = exec.parent !== void 0`、L1306 只有 `run_code` 绑定会设 `parent`。
  有了这三行，「组件无法诚实地让 ptc 的 run 抵达对话 scope」才是**结论**而不是**猜测** ——
  也因此「改清单、不改 reach」才是唯一不动摇的修法。
- 反过来也要克制：读到 `parent` 是未校验的 `Symbol` 时，**只记录、不利用**。
  利用它正是这一节刚刚拒绝的那种冒充。
## 23. 一个「减法」要成立，得由两侧各一次真实派发闭合（2026-10-06）

0.2.18 在线复核时，回执里的 `tools_withheld.count: 31` 是**被检验的那段代码**写出来的 —— 拿它当证据是自证，
把缺陷改回去也能得到同一个数字。这一轮用三件**不读它自己**的事把它闭合：

- **算术恒等式**：`47（catalog.total） − 4（agent_api_*） − 1（run_code） − 11（tool_names） = 31`。
  左边每个数由**另一次调用**独立报出，所以恒等式成立与否不取决于 `tools_withheld` 自己。
- **集合恒等式**：`tools_withheld.names` 与 `agent_api_catalog.not_dispatchable \ {run_code}` **逐项相等**
  （各 31 条，两个入口分别生成），且 `tool_names ∩ not_dispatchable = ∅`。
- **两侧各一次真实派发**：被**列出**的 `computer_use` → `exit 0`；被**减掉**的 `read` → `exit 2 / unknown_tool`，
  而 `read` 通过会话自己的传输**确实可达**（同一轮用它读到了文件）。这条对照证明的是"减法减对了"，
  不是"组件少给了"。

**判据**：一个报"我减掉了什么"的字段，必须能用**不读它自己**的事实复核 —— 算术恒等式、另一个入口给出的
集合、以及两侧各一次真实调用。只有自报计数时，"减对了"与"减错了"在报告里长得一模一样。

**顺带一条实测（同一次探针里踩到的）**：`agent_api_tool` 的 `exit 2` 信封**没有 `result` 字段**，失败信息在
`error` / `code`（`{ok:false,tool,route,exit:2,class:"invalid",error:"unknown tool \"read\"",code:"unknown_tool"}`）。
统一按 `result.*` 取值的探测脚本会在**正要检验的那条失败路径上自己崩掉** —— 非零退出码的信封要按退出码
分别取字段。同一次还会看到：这个信封当时也没有 `scope`/`presentation`/`dispatch`，而描述承诺过
`presentation` —— 于是"描述里的承诺要有断言盯着"这条又多了一个实例。


## 2026-10-06 transport 故障归因与诊断边界

Transport 包装错误的三条路径（即时拒绝、流异常、已收到工具调用后异常）统一传递原始错误给 failureText，避免只取 message 丢掉 cause。诊断回归同时检查底层原因和已收到工具调用时不重复派发。宿主已经序列化丢失的 cause 不得推测补全；跨预设及标题生成故障可削弱预设特有归因，但插件仍全局加载时不能冒称插件关闭的 A/B 验证。失败尝试日志不是总请求分母；注明解码失败和运行中日志快照边界。工作树候选、已安装版本、发布状态分别记录，保留既有并行改动。

## 2026-10-06 插件开关与真实预设复测

实机验证需先读取插件实际开关；关闭 bundle 时 UI 保留的原始预设 id 不证明该预设已加载。临时启用测试后恢复初始状态，并区分既有失败日志与本轮新请求。两个顺序短文本请求只证明当下可用，不支持长上下文、工具链稳定性或故障归因结论。

## 2026-10-07 transport debug 安装验收约定

界面组件状态与说明必须采用同一Host挂载回执；页面快照缺失不等于组件关闭，lease快照缺失不能称为lease free。安装版验收需真实包版本、逐文件哈希、重启后UI和真实原生工具/模型回执。界面完成仍需核对隐藏重试。错误包装要保留完整cause/code；有限重试只用于尚未产生工具副作用的模型请求。网络TLS原因与rDev特有缺陷须分清，未知代理因果不推断。保留全部能力和生产记忆，脚本注入验证只在隔离测试/显式scratch执行。监控只查看新增事件、无使用不视为稳定证据；异常才通知，不反复消耗真实模型请求。


## 2026-10-07 一次性全工具与长上下文 heavy 验收

长任务验收需保留同一已有上下文、真实宿主turn/end完成事件、原生工具回执和产物回读，并区分自动重试与人工重发。声明全工具覆盖时明确注册范围：插件15工具与宿主50工具不是同一集合。确定性模型夹具、真实模型结果、源码推导、直接函数运行分别记证据；历史native无run_code时不得伪造PTC完成哨兵。测试夹具拒绝应修夹具并完整重跑，不能据此误改生产代码。用户取消持续监控后删除自动任务，以一次性验收收尾。


## 2026-10-07 新发重试耗尽与限定连接修复

连接故障先比较相同origin的代理和直连，再采用明确可回退的限定请求路由；不改变全局代理、不关闭TLS校验。Electron内置fetch与外部Undici dispatcher不可假设跨版本兼容，限定覆盖需配对同版本fetch/Agent并真实模型验证。无凭据401只证明TLS/HTTP路径，不能替代模型执行。失败会话历史含发布指令时，不盲目重试发布；明确诊断限定工具，保留副作用边界。历史失败和修复后成功分别统计，记录初版修复自身错误并纠正，不扩大成永久网络可靠性结论。


## 2026-10-07 连接补丁后功能无损伤复核

功能无损伤结论需修复前安装哈希、当前源码一致性、完整组件/预设/客户端回归与全部注册工具覆盖。宿主连接补丁另核对请求序列化、鉴权、流解析、取消/重试是否只改路由；夹具模型与真实模型证据明确分开，不替代未实测的所有应用/视觉模型承诺。


## 2026-10-07 NewMate 发布拉回规则

发布使用独立的公开仓库 checkout，逐项对照已验收运行文件，避免推送主工作区并行改动。Git 标签、CI 发布成功、npm 可下载、实际 profile 安装以及 DSH 新宿主加载是独立门禁；重装后必须完整退出旧主进程及宿主，再启动并验证新进程，不能用页面刷新代替。新增公开 README 造成 tarball integrity 变化时，另保留 45 个运行文件逐字节等价和 46 个发布文件安装对照证据。



## 2026-10-07 GPU 动画与安装态验证纪律

动画计时与捕获吞吐分开验收，阶段 FPS、p95、原始回执同时保留；不把 rAF 回调当硬件显示帧。UI 线程每次只保留一个待绘制帧，像素面/轮廓数据复用，窗口尺寸固定后用合成变换动画。预览不转发输入，缓存 WebView 必须随宿主结束清理。测试已安装 pnpm 包时先规范真实路径并从同一包导入组件，避免夹具接错模块；配置实时同步需连接与 DSH 相同的用户根，结束恢复原偏好。公开发布、注册表安装、完整进程重启和源/包/安装文件一致性分别留证。


## 2026-10-08 桌面迁移与全 DSH 接管互斥（开发中，未发布）

Win32 桌面与 Task View 虚拟桌面不可混淆。原生窗口迁移受系统约束时必须说明并实测，不能把代理画面报告成原 HWND 已迁移。CU 互斥按 Windows 用户及真实/虚拟模式分别由系统持有，不用模型给出的 owner_id 代替 DSH 会话身份；同一模式的实机验收串行执行。交互映射需要独立处理被映射进程和 Job Object 的生命周期，不以静默重启或丢失进程状态冒充迁移。 [工作状态](archive/20261007-cu-transfer/STATUS.md)。


## 2026-10-08 显示同步与性能验证

以目标显示器节拍驱动渲染，不以固定 30/60 FPS 定时器封顶，也不通过关闭垂直同步追求空转 FPS。GUI 只保留最新状态和一个待处理帧；采集连接归工作线程独占，退出前停止并回收。静态内容复用 GPU 纹理，轮廓/动画按真实时间演进。WSLg 必须核对实际 GL renderer，不能把 llvmpipe 当 GPU 加速。分别记录冷启动、展开/收起、稳定预览、捕获与渲染吞吐；交换请求不等于硬件扫描回执。源码回归、正式包发布和生产 DSH 完整重启是独立结论。

显示绘制节拍不可承担控制心跳；命令、状态与进程保活在暂停绘制时仍必须前进。高刷新动画下不依赖低优先级WM_TIMER调度关键命令。发布后发现问题使用新版本，不覆盖已发布tag；验收失败原样保留，区分已确定的故障与未证实的初次失败归因。

## 2026-10-08 官方宿主适配核查（进行中）
此前社区版验收不能作为官方宿主兼容性结论。官方版 0.2.0-rc.2 / pnpm 11.7.0 已核实；发现 latest=0.2.32 而实际安装0.2.26，默认24小时发布年龄筛选及多源/缓存解析正在隔离核查。MemoryLab host 失载尚未修复。目录与证据见 archive/20261008-official-compat/REPORT.md。后续必须以官方宿主、实际注册表安装和运行态回执验收。

### 纯净官方客户端约束（取代端侧安装方案）
用户要求纯净官方 DSH 输入包名即安装 latest，旧版本只按显式版本请求安装。端侧安装脚本已撤销；本轮新增包级年龄例外已撤回。远端 latest 正确，但官方 pnpm 默认24小时过滤不能由插件包配置覆盖。0.2.33仅为未发布候选；发布端标签校验不能视作P0修复。MemoryLab首次打开读取宿主快照专项11/11通过。完整边界见 archive/20261008-official-compat/REPORT.md。

## 2026-10-08 Newmark Core 更新区（0.2.37 已推送）

配置栏末尾提供统一更新入口，三个组件依托Core更新。最新修订移除新增更新区外框、底色与状态分割线，保留留白及响应式对齐。按钮检查官方dist-tags、精确版本与安装结果，并处理空响应、HTML、401/403、404/405及标签缓存落后时的防降级。更新与位置68/68、配置样式34/34、客户端119/119、首次打开11/11、版本12/12通过；完整更新套件曾195/195，0.2.36新媒体查询触发的旧CSS扫描器误报已在专项目录修正并验证。

源码和标签v0.2.37已推送，提交e02b5a5；npm发布状态与安装回执以archive/20261008-core-update/REPORT.md为准，不将tag推送视作所有镜像已同步。本机官方管理器安装0.2.33成功；随后0.2.36安装因网络与宿主旧锁文件发布年龄策略失败，未宣称已安装新版。纯净宿主首次包名安装P0仍受宿主策略影响。


### 2026-10-09 更新确认候选（未发布）

检查更新采用官方 Modal/Button，新版确认前不安装；取消/关闭不安装，配置更新区继续无框。专项104/104、客户端119/119、首次加载11/11通过。自动完整重启尚未实现：官方桥接未暴露该操作，已询问本机辅助程序方案，不用刷新页面冒充重启。候选未发布，详情与文件职责见 archive/20261009-update-confirm/REPORT.md。


### 2026-10-09 官方安装态重启复测

已安装并启用0.2.37，完整结束旧DSH进程后重新启动，运行态更新接口current/latest均0.2.37，MemoryLab快照正常，66个安装文件与发布仓一致。安装态隔离行为79项通过，NewMate倍率保持60.1%。本次使用单次pnpm年龄豁免完成本机安装，不代表纯净客户端P0已解决；自动重启确认候选尚未发布。进程/哈希/接口/安装回执及测试边界见 archive/20261009-update-confirm/REPORT.md。


### 2026-10-09 Core本机重启辅助宿主（0.2.38）

Core新增Windows本机重启辅助程序，随包分发：官方确认弹窗后先安装核验，再通过当前进程祖先身份验证、一次性凭据与响应完成握手执行完整进程重启。PID43072→92384真实验证宿主就绪；安装后组件和快照接口正常，NewMate60.1%保留。新增lib/core-restart.js（请求与启动协调）、lib/core-restart.ps1（独立进程执行）、scripts/verify-core-restart.mjs（18项专项）；诊断于~/.Newmark/core/restart，含私密认证日志，不公开。保持配置栏末尾无边框，非Windows官方宿主明确拒绝自动重启，不修改全局pnpm策略。证据、文件职责、测试失败边界及发布状态见archive/20261009-core-restart/REPORT.md。


0.2.38最终状态：CI37814808180成功、npm latest=0.2.38，正式包已拉回安装；68文件与git tag原始blob完全一致。Core辅助宿主实测92384→39080完整重启并就绪，运行接口current/latest=0.2.38。安装态164项专项通过；边界复测25/25，Win32两项前台窗口环境限制保留。全部记录于archive/20261009-core-restart/REPORT.md。


### 2026-10-09 启动性能候选0.2.39

Core组件共享schema解析；MemoryLab仅复用完全一致磁盘文本的规范化结果，返回独立副本且每次读盘；NewMate菜单初始化延至空闲时间，复用已注入连接，CSS按原顺序分批处理并保留插件覆盖兼容。交替对照重复快照10.84→5.51ms（约49%减少），首次读取基本不变；完整DSH启动和浏览器CPU指标未显示可靠提升，不将局部缓存收益宣传为本体加速。源码文件职责、测量方法、原始数据和测试记录见archive/20261009-startup/REPORT.md。


0.2.39验收更新：重复快照读取中位数约减少49%，DSH本体约7秒启动未测出可靠提升。额外Node编译缓存实验未显示收益，已撤回到归档而未发布。完整核心194/195，剩余Win32前台窗口环境限制；68文件与v0.2.39原始tag一致，本机已安装源码标签包并完整重启。npm上传成功但latest同步验证失败，当前不能宣称npm正式包已拉回；详细回执见archive/20261009-startup/REPORT.md。

启动验收应记录旧进程退出、新主 PID、宿主就绪时间和真实运行版本；隐藏基准启动后恢复用户桌面窗口。区分宿主就绪、GUI 首帧与交互验收；连续重启不能作为冷启动提速证据。原始 stdout 含认证信息，只留本地归档。2026-10-09 实例见 archive/20261009-startup-real-retest/REPORT.md。

### 2026-10-11 用户补充后的最终设计范围

newMate以授权本地文件事件、元数据和必要差分作稀疏测量，默认消极主动响应：无变化不后台思考，无关变化不读正文，有意义才调用Agent API，有必要才唤起DSH本体对话。定制陪伴以MemoryLab确认为权威来源；自主链硬禁止删除文件及间接删除。CU读屏只作可选任务辅助。宿主真实会话创建/消息投递/导航契约待核实，不以API临时run或桌宠气泡冒充。设计、工具与文件结构均未实现。

## 2026-10-13 macOS 隔离与 Neo 最低档评估

用户暂停 Space 实现并要求评估，最低部署基线为 MacBook Neo A18 Pro／8GB。Space 不提供独立输入，另用户虚拟显示会话具有原生操作分离的官方依据，但本项目同机接入未验收；VM 系统边界更强，资源开销以测前预算记录。此次仅写评估，不改CU源码、版本、安装或发布。详见[比较与容量预算](docs/12-macos-spaces-vm-assessment.md)。

隔离结论分别描述输入、应用、文件、内核与资源边界；跨机器性能比较不能当成同机虚拟化损失，容量预算和Neo实测必须分开标识。


## 2026-10-14 README 首页格式约束（持续适用）

README.md 是面向首次访问者的 GitHub 产品首页。后续更新必须保持本轮的信息结构，直接维护当前功能，不在标题下追加按日期排列的操作日志。以本轮 README 为格式基线；本节取代旧 README 中“三组件”“预设是第三组件”“目录安装还需另装子依赖”等已经不符合自包含五组件实现的对外描述。历史证据保留在版本记录与本地归档。

### 固定信息顺序

1. **项目名与一句话定位**：先讲使用价值，再用一段介绍整体；紧接发布、npm、OVERVIEW、taste 导航。
2. **整体使用场景与功能地图**：用具体工作场景串联能力，表格列出五个组件的名称、用途和入口。Dev/rDev 单独说明为预设，不混入组件数量。
3. **每个子组件的详细介绍**：按 MemoryLab → ComputerUse → Agent API → NewMate → heartBeat 排列。每节必须有自然语言用途、当前能力、主要入口或工具、实际使用例子，以及影响选择的前提或限制。NewMate 保留对话、低打扰陪伴和待办两模式说明。
4. **Dev / rDev 预设比较**：列出共同能力与差异，说明预设选择位置及工具组合与宿主权限的关系。
5. **快速开始**：先配置 DSH 模型，再安装明确版本、选择准用模型与组件、进入页面、说明更新后的宿主重启；列明组合依赖和外部 MCP 接入方法，凭证只描述取得方式。
6. **平台支持与验证范围**：表格比较 Windows、Apple Silicon macOS、Linux/WSLg。准确说明真实/隐藏桌面、Space、X11 的区别及各自环境前提；平台验收强度不能混写。
7. **数据与协作**：说明默认用户根目录、模型调用去向和组件协作；架构图可用 Mermaid，但不得暗示未实现的通信或权限。
8. **结构与开发入口**：以公开包根目录为树的基准，另说明开发工作区路径差异；只放可在对应目录运行的命令，完整文件职责交给 OVERVIEW。
9. **当前版本与更新**：一处介绍当前基线，指向版本记录与 Release。说明文档更新和包发布是不同动作。
10. **许可与反馈**：链接实际 LICENSE 与 Issues。不得因为仓库公开就声称采用宽松开源许可。

### 写作与更新要求

- 中文为主要叙述语言，保留产品名、工具名和参数原文。文案具体、自然、有场景，不以堆砌实现细节和营销口号代替功能解释。
- 使用清晰的二级/三级标题、并列表格、适量列表和少量功能图标；不靠大量徽章、emoji 或长篇发布日志填充页面。标题、列表和表格前后留空行，代码围栏闭合。
- 每次更新先核对组件装配、工具注册、配置和相关验收；不能只读旧 README 或旧注释。不得把过时“三组件/四组件”、旧接口和已撤销安装方案带回首页。
- 五个组件“可独立启停”不等于所有组合功能无依赖。必须保留 NewMate/Agent API/MemoryLab、共享桌宠实现和 heartBeat 重启的实际依赖说明。
- 例子应标明是使用方式，不伪装成实测。将源码实现、夹具/云端、正式包、安装态与实体交互分开；不得写无证据的成本、性能、像素一致性或全平台验收结论。
- 新功能整合到对应组件章节；版本、安装方法、平台表、功能地图和结构树一起检查。历史变更写 CHANGELOG/Release，本地操作写 archive，状态和文件职责写 OVERVIEW；不再把旧发布阶段正文插回 README。
- 公开 README、公开 taste 与开发工作区对应文件须保持同一格式契约。链接在实际公开布局中可用，不链接本地 archive、私有配置、凭证、私人会话或机器绝对路径。
- 交付前核对标题结构、五组件覆盖、工具拼写、围栏、链接和 Git diff。纯文档改动不提高运行版本，不宣称重新安装、发布 npm 或完成新的运行验收。


### 2026-10-14 润色与推送后读校验补充

长 README 在定位后提供章节导航；工具与动作名称逐项写全，读者可直接搜索或复制。优先解释用户可观察的行为，将租约、回执等术语与实际作用连起来。推送后须按远端提交重新取回 README，核对正文一致，再检查 GitHub 渲染的标题、表格、代码块与导航锚点；本地校验不能替代远端读校验。


## 2026-10-14 CHANGELOG 本地归档约束

历史 CHANGELOG 归入按时间戳命名的 archive/ 子目录，archive/ 必须保持 Git 忽略且无已跟踪文件；添加忽略规则不会自动取消旧文件跟踪，须核对 git ls-files。归档先核对原文及散列，再从公开根目录移除。README 的版本历史统一链接 GitHub Releases，不链接忽略的 archive/ 或已移除的 main/CHANGELOG 文件。旧格式约束中要求公开 CHANGELOG 的部分由本节取代；既有标签与 Git 历史不改写。


## 2026-10-17 预设声明、会话日志与离线探针的三条约束

这三条不是风格偏好，是同一个故障在三处留下的判据。事故回执、前后字节与两条失败会话的尾部见 `archive/20261017-155232-preset-cwd-fix/`，故障本身另见 `evidence/20261017-preset-break/`。

### 预设声明不得插值宿主未注册的提示词变量

`persona` 的 `prefix` / `suffix` 会被渲染进 `deployment:persona-prefix` / `deployment:persona-suffix`，且**会解析提示词变量**（`dsh-persona/README.md:41,99`）；0.2.1-rc.1 只注册 `provider` 与 `model` 两个变量（`dsh-agent-loop/lib/index.js:1591-1592`）。所以声明里写 `{{cwd}}` 不是「写了不生效」，而是**整轮在提示词组装阶段抛错**：`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model`（`dsh-system-prompt/lib/index.js:174`），模型一次都没有被调用。规则：预设声明只使用宿主**确实注册**的变量；要引入新变量，先读宿主字节确认它注册了，再写进声明。判断依据跟着宿主走，不跟着旧模板的写法走。

### 挂载成功不等于能跑：离线探针只能说清它探到了哪一段

同一次故障里 `dev` 与 `rdev` 自始至终**挂载正常**（`broken: null`、无泄漏服务、`retain()` 成功），坏的是下一阶段——提示词组装。离线 mount 探针能证明行能实例化、配置通过校验、依赖服务能解析；它不能证明一轮对话能产出模型步骤。因此结论必须写明探的是哪一段：**挂载 / 组装 / 模型调用**，三者不能互相代替。声称「预设可用」时，要么给出一轮真实 turn 的事件，要么明说只到哪一步——这与本文件里「测量到的和推断出的分开写」是同一条要求。

### DSH 会话日志是多帧 zstd 拼接，单帧解压会静默截断

会话持久化每次 flush 追加**一个独立可解压、带校验的 zstd 帧**，所以整段 buffer 只解第一帧的 `zstdDecompressSync` 会把 7.8 MB 的日志读成一行 header——一次失败的会话因此看起来像「空的会话」。规则：读会话日志必须逐帧扫描、按帧解压（`scripts/probe-session-log.mjs` 复刻宿主的 `scanZstdFrames`），并把 `frames`、`compressedBytes`、`decompressedBytes`、`lines`、`tornStart` 一起记录。「日志里没有报错」这个结论必须建立在帧计数上，不能建立在一帧成功的解压上。


## 2026-10-17 变异门禁改写受跟踪文件时的三条要求

变异门禁（植入一个被拒形状 → 跑发布门禁 → 在 `finally` 还原）在**整段运行期间**把受跟踪文件留在被改写的状态。本轮实际发生了这件事：`measure-dev-rdev-mutations.mjs` 从 15:43:54 起把 `tool-drift` 行植入 `packages/newmark-core/cordis.patch.yml`，到 16:00 被终止时仍未还原，期间另有两个进程在同一棵树上读同一文件。因此：

- **串行**：运行前确认没有其他工作会读同一文件。受跟踪文件的变异窗口不属于「只读」时间，同一棵树上的其他读取必须让路或等它结束。
- **流式输出**：断言行必须实时可见。把门禁输出缓冲在 `Select-Object -Last` 之后，等于整段运行里既看不到失败、也看不到它停在哪一步——本轮因此没有任何 `ok -` 或 `SUMMARY` 行可以引用。
- **终止后必须校验字节**：任何被中断的变异门禁，都要立刻对每个它改写过的文件做 sha256 比对（与运行前哈希或已知良好副本），**不得**把「进程退出」当作「已还原」。本轮以已安装副本恢复源 patch，双方 sha256 一致（`ED9F6FFF…E228EB6`）后才继续。

一条没有任何断言行的门禁运行**不是通过**：结论只能写「未跑完、未捕获断言」，并说明它守护的性质是否由别的门禁覆盖。
## 2026-10-17 两阶段重启（广播 + 回执屏障）的五条硬规则

- **参与者只能从宿主取。** 屏障的成员集合必须来自 `agents().roots()` 这类宿主事实，绝不接受调用方传入的会话名——由被保护方之外的人点名参与者，等于没有屏障。同理，回执按宿主给的会话身份归属：一个会话不能替另一个会话回执，这条必须有能变红的变异用例。
- **回执必须与投递读同一个事实。** `ackMode:'auto'` 登记的那条持久任务**就是**该会话的回执，不是它的影子：回执说「已登记」，重启后就真的会投递，两者由同一次原子写产生。任何「先记下回执、以后再补登记」的写法都会把屏障变成一个只会点头的装饰。
- **屏障的状态必须跨进程存活。** intent 写进 durable state（本轮 schema 2 → 3），由新宿主收尾：提交过的写成 `committed` 并记下本次投递的任务；旧进程留下的 `preparing` 必须写成 `interrupted`，并告诉 requester「其实没有重启」。只活在进程里的屏障在两个方向上都撒谎——它既不认账，也不承认失败。
- **让位与过期都要有出口。** 过期且无人提交的准备要自行关闭，否则一个被遗忘的 intent 会永久拒绝新的广播：这类「锁死」缺陷在正常路径上永远不会出现，只能靠一条专门的门禁用例守住。打开屏障期间，即时重启路径必须拒绝执行，否则一次 `heartbeat_restart {}` 就能绕过所有回执。
- **默认值必须是旧行为。** 新能力一律默认关闭（`broadcast` 默认 false 等于 0.3.15 的即时重启）；更严格的语义（`ackMode:'agent'`，代价是每个会话一轮模型调用）不能成为默认。另：本轮**没有**单独的取消工具，取消等于不提交、提交一次必然缺回执的 commit、或等它过期——这是缺口，要写成缺口，不要写成功能。
- **回执终态的实现细节要让「不可达状态」不可发明。** 自动覆盖（`ackMode:'auto'`）登记的那一刻，该参与者就已经是终态：所以「自动覆盖的参与者又变成 `closed`」不是一个能到达的状态——`closed` 只会落在仍未回执的参与者身上（`agent` 模式）。写门禁时不要为了凑用例去合成一个状态机到不了的状态：把两半分成两次准备分别断言，并在注释里说明为什么它们不同时出现。这条是 `barrier-gate` 在改门禁时发现的，记在这里以免下一轮又照着错误的措辞去「修」组件。
- **门禁的每条用例都要有自己的边界。** 第一次变异运行时，有 5 个变异让**门禁本身崩掉**而不是打印判词——于是变异表把这些断言报成「unprotected」，而真相是「断言存在但从未给出判定」。修法是把每条用例包进 fail-safe 边界，让被破坏的状态变成一个点名的 `not ok`。**一条让门禁崩溃的变异，和一条让门禁变红的变异，不是同一件事**；只有后者才算覆盖。
- **改写受跟踪文件的变异门禁，必须给出还原哈希。** 本轮 `measure-heartbeat-restart-barrier-mutations.mjs` 的 16 个变异全部字节还原，并在报告里给出 `component.js` 与 `index.js` 的还原 sha256；这是「已还原」唯一可核对的证据。
## 2026-10-17 桌宠渲染：分层窗口的「绘制」与「呈现」是两件事（0.3.17）

- **逐像素 alpha 的分层窗口只由 `UpdateLayeredWindow` 呈现，而绘制与呈现是两条独立的路径。** 绘制正确不等于屏幕上正确：只要调用 `UpdateLayeredWindow` 的那条路径不被触发，上一帧（哪怕它是整块白）就会一直留在屏幕上。本轮实测：`cu:false` 且弹簧静止时 `Tick` 从不调用 `Render()`，于是「一次坏呈现 = 永久白底」，直到用户拖动或切到 CU 才恢复。**任何 layered window 都必须有有界的重新呈现节拍**（本轮复用已有的 1 s `Raise` 节拍），并覆盖那些会改窗口尺寸却不重新呈现的路径（本轮的 `WM_DPICHANGED`）。
- **`PrintWindow` 看不见 `UpdateLayeredWindow` 的内容，它画的是窗口自己那张从未绘制过的重定向表面**，实测为 WinForms 默认 `BackColor` = `(240,240,240)`、`distinctLuma=1`。**因此 layered window 的验收判据绝不可以用 `PrintWindow`**：健康实例与坏实例都返回 240，它天生无法区分——交接单里「539 字节 / luma 239–240」那条读数是这块背景，不是白底的证据。显示器合成层（`BitBlt` / `CopyFromScreen`）才是唯一能看见 layering 的通道；`PrintWindow` 只作为证据记录，不作判据。
- **「代码画错了」与「呈现过期了」在屏幕上长得一模一样，只能靠同一份字节的新实例 A/B 分开。** 本轮长驻实例整块白的同时，用**同一个 exe、同一张 PNG、同一份 settings** 新起的实例渲染完全正确（`lumaMin 26`、`white250 23/27234`），于是缺陷被定位在「呈现 / 状态」而不是绘制。**先做这个 A/B，再动绘制代码**；否则会去改一条本来就正确的渲染路径。
- **把失败「照着症状」注进去，判据才可失败。** 本轮门禁直接对宠物自己的 hwnd 调 `UpdateLayeredWindow` 注入一张不透明纯白 DIB（与观测到的故障逐像素一致），再断言它在有界时间内自愈：未修复的构建 6000 ms 后仍是整块白，修复后的构建 302 ms 恢复。**同一支探针跑两个构建**，差值是修复本身，而不是两支探针的差异。
- **先在交付物上验证「判据在坏构建上真的会红」，再声称它能防回归。** 新门禁先对**修复前的包快照**跑一次并留下原始输出；只有记录下来的 RED 才证明它不是一条只会点头的断言。同理，交接单给出的候选根因要先逐条证伪再动手——本轮四条候选里三条被实测排除、一条不适用，真正的原因不在交接单上。
- **不要结束、不要移动你没有启动的进程。** 用户桌面上有一个长驻桌宠，而门禁编译出的实例与它共用同一个 `%TEMP%/newmark2dsh-computer-use` 与同一批 `bin/<hash>` 缓存；只按 pid 操作自己启动的那一个，并在每一步前后记录「原本就在跑的 pid 集合」。
- **带空格的路径会静默吃掉 argv。** `Start-Process -FilePath <exe> -ArgumentList $cfg` 不会给参数加引号，而本仓库的绝对路径含 `Newmark Agent`；结果是子进程收到被截断的 argv[0]，读不到 config、不写 `status.json`、也不写 `error.json`，看起来像「窗口找不到」。**凡是拼接命令行，一律显式加引号**；并且「等不到 `status.json`」必须显式报错，不能继续往下走。
## 2026-10-17 视觉属性必须有像素级门禁（0.3.17，桌宠白底那一轮）

- **命中测试不是渲染断言。** `verify-desktop-pet.mjs` 的 `transparent corner passes through` 用 `WindowFromPoint` 问「点击会不会穿过去」，宠物整块变成白板时它照样 PASS——因为白板也是一个 layered 窗口，透明与否不影响命中。**一个视觉属性必须有一条真的读像素的门禁**：本轮补的是「宠物矩形的四个角点像素必须等于把宠物藏起来后同一位置的桌面像素（每通道 ±12）」和「恰好 (255,255,255) 的像素占比不得超过 0.8」。
- **量「用户看到的东西」只能用合成层。** `PrintWindow` 对 ULW 窗口返回的是它那张从未绘制过的重定向表面（实测恒为 240、`distinctLuma=1`），健康与坏实例给同一个数，天生无法判别；它可以当证据记录，**不可以当判据**。`CopyFromScreen` / `BitBlt` 才是屏幕真值。
- **判据里的阈值要对准「实测到的那次故障」，而不是一个更好看的中间态。** 本轮先写的变异是「把 surface 清成白但仍然画精灵」，实测纯白占比只有约 0.5，达不到交接单记的 0.8 判据——那不是被记录的那次故障。改成「清成白且不画精灵」（与实测逐像素一致）后，`no_opaque_white_plate` 才变红；而那个更温和的变体仍然被两条像素级断言抓住，于是把它留成第三个变异，**用来证明这两条断言在做像素占比做不到的事**。**变异要照着故障症状种，种得越像，断言被证明覆盖的就是真问题。**
- **前置条件本身就是断言的一部分。** 「陪伴模式保活重绘」必须在 `cu:false` 且 `pet_transition:'idle'` 时测：宠物一动、或描边动画在跑，它每帧都在重绘，注入进去的坏合成根本活不下来，断言会**因为错误的原因通过**。把前置条件写进判据（并在 detail 里回显它读到的值），断言才说明它想说明的事。
- **对照采样必须是同一个场景。** 角点断言要拿「藏起宠物后的同一矩形」当参照；第一次实现时闸门自己的背景窗口已经销毁，参照拍到的是真实桌面（203 个灰度），而被测帧拍的是 luma-40 背景，两者根本不可比。**任何「与另一次采样对比」的断言，先证明两次采样拍的是同一场景**（本轮改成 `desktop-under` 自己重建同 luma 的背景窗口）。
- **交接单里的「复现配方」要先跑再信，跑不出来就如实说。** 本轮按 `evidence/20261017-pet-render/measurements.md` 的配方重启宠物取 t0/+200ms/+1s/+5s 四点，两个构建各两次共 16 帧，**没有一帧出现 >80% 纯白**；再加一次 DPI 重建触发同样干净。真正可复现的只有「坏合成一旦发生就永久留存」这件事本身（活体实例实测 100% 纯白、持续数分钟），以及把故障逐像素注入回去。**把「配方没能复现」写进结论，比假装复现了强**；据此把修复定位在「让坏合成有界自愈」，而不是「消除首帧」这个没有被证实的方向。
- **探针里的注释要用宿主语言。** 这是一个 PowerShell 探针，我却给新动作写了 C# 风格的 `//` 注释，于是 PowerShell 把 `//` 当成命令名，动作直接抛错——而门禁把它报成「断言失败」而不是「探针坏了」。**探针抛错与断言不成立是两件事，detail 里必须能分辨**（本轮 `desktop-under` 的 `error` 字段就是为此）。
- **归档目录名跟仓库习惯走：`YYYYMMDD-HHMMSS-<slug>`，slug 用交接单里的说法**（本轮 `20261017-184543-pet-white-plate`）。`archive/` 与 `OVERVIEW.md` 是 gitignore 的，**不要加 `!` 否定规则**；审计链靠把归档路径 + 逐文件 sha256 写进被跟踪的 `VERSION.md` 来保住。
## 2026-10-17 读宿主的字段、夹具的形状、以及「载入 ≠ 在工作」（0.3.17 广播过度唤醒）

- **读宿主的字段，就要读它自己用的那一个。** 一个词之差就够了：组件写 `agent.running === true || agent.session.running === true`，宿主用的是 `agent.status === 'running'`——前者两个字段宿主**从不设置**，于是 `looksBusy` 恒为 false，每个载入的对话都被当成在工作的。**找不到判据时，顺着宿主自己的代码去找它用的那一个，不要凭直觉发明字段名**；本轮是 `dsh-agent` 的 `installTurnArchiveAdmission` 给出了答案。
- **夹具必须用宿主的形状，否则门禁会和 bug 一起变绿。** 这个 bug 之所以能躲过 84 条断言与 28 个变异，是因为**夹具自己带了组件读的那个诱饵字段**（`running: true`）——假的对象同意了真的 bug。这是「在盲区上通过」的第二种形态（第一种是断言不看结果）：**删掉诱饵字段本身就是断言的一部分**，本轮把夹具改成只给 `status: 'running' | 'idle'`，并把所有「多参与者」用例显式写成在工作。
- **「载入」不等于「在工作中」。** 广播、唤醒、重启保护这类动作的成员集合必须由「确认在进行中的工作」定义（这里：宿主的 `status === 'running'`），而不是「宿主里存在的对象」（`agents().roots()` 返回的是所有活着的顶层 agent）。过度广播不是更安全，它会把什么都没在跑的对话叫醒、凭空起一轮模型调用；发起方（requester）永远是成员，因为它是提出请求的那个。
- **同一个语义要在两处都收口。** 开场（`beginBarrier`）过滤成员还不够：准备期间新出现的会话也要过同一条判据（`refresh()` 里「出现 ≠ 在工作」），否则窄集合会被后出现者重新撕开。
- **报告「某个预设立失去了某项能力」时，先量再改。** 先把两段声明**逐行**比对（不是找关键词），再量一个**活会话**的工具面（`agent_api_state` 给出 `scope`/`presentation`/名字表）；两步都指向「能力还在」时，**不要动声明**——那等于为一条未能复现的报告去改正确的产物。能做的最有价值的事是把那条能力写成**点名断言**（`rDev keeps file editing: tool-fs … whole-row identical to Dev`），而不是只让它藏在差集里。另记住预设与权限的分工：**预设决定工具组合，沙箱/审批由宿主会话决定**，所以「不能写文件」优先查权限状态与 plan mode，而不是预设。
- **恢复一个存储会话，必须把它记录的预设一起挂载。** 恢复出来的 Agent 的**整份组合**来自 `agents.resume({setup})`（宿主就是 `setup?.(prepared.agent.ctx, prepared.agent)`），只还原模型等于让它跑在 **Host 组合**上：实测 45 条工具、`presentation:"native"`、没有 `run_code`、没有 read/write/edit/glob/grep/pwsh——而对该会话**永久**成立，因为 API 层只对**空白**会话套预设。参考实现是 `composeAgent` 的 `await presets.mount(agentCtx, resolvedId)`。**两个陷阱**：预设**不在** `session.requestHeader()` 里（那是 `request/header` 的 EpochHeader，只有 provider/model/tools），要用 session projection 或 session header；`mount` 必须 `await`，否则与第一轮赛跑。
- **「重启唤醒谁」必须把用户停掉的东西算进去。** 判据不能只看「在不在跑」：用户对某对话按了暂停（宿主的 goal `phase:\"paused\"`，读法就是 `ctx.goals.get(agent)` —— 与 `dsh-tool-goal` 同一个调用），重启就不该把它叫醒，因为被叫醒的对话会真的起一轮模型回合，而用户刚刚把它停下。**读不到 goal（服务缺失 / 该会话没有 goal / 读取抛错）一律按「没有暂停记录」处理，绝不因此拒绝重启。**
- **「继续」不等于「恢复」。** 会话恢复会把**进行中的 goal 解除武装**（`activation:"disarmed"`），而自动续轮只在 `armed` 时发生；所以任何「重启后继续」的入口都必须在提示词里明确要求：先读 `get_goal`，`phase:"active"` → `update_goal{action:"resume"}`，`phase:"paused"` → 保持暂停。只写「从上一句继续」，会让一个正在进行的目标静默停摆。
- **「中断」必须带「接续」，而「发起方不是对话」不是不接续的理由。** 任何会让宿主重启/终止的入口（面板、HTTP 更新路由、心跳广播）都要**在动手之前**为「确认在工作的对话」登记接续。更新路由没有发起对话，于是它此前谁都不接续——正在飞的回合被静默杀掉，用户看到的就是「没有继续却中断重启了」。判据仍然只有宿主的 `agent.status === 'running'` 一个；注意这个修复对**执行安装的那次重启**无效（跑的还是旧代码），从下一次更新重启起生效。
