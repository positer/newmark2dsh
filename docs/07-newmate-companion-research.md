# newMate 陪伴内核：产品与实现机制预研

日期：2026-10-11（Asia/Shanghai）。状态：**设计研究，未实现、未安装、未发布**。

本轮把 newMate 定义为 Newmark2DSH 的拟新增陪伴组件；既有 **NewMate** 桌宠是 ComputerUse 的呈现层，不能据此宣称已有陪伴内核。设计详见 [内核规格](08-newmate-kernel-design.md)。

**用户补充后的最终范围：** 稀疏测量主要检测授权本地文件变动，通过事件、元数据与必要差分降低开销；消极主动响应默认安静。newMate无主动删除文件权限，能够主动唤起DSH本体对话，定制陪伴由MemoryLab驱动。CU灰度采样只提供分层测量的原理来源与可选电脑任务辅助，不作为默认常驻读屏。

## 1. 调研对象与证据口径

这里的 Dot 指 OpenAI Dots，Grokbot 指 xAI Grok Bot，Cue 指 Manus 的 cue.im。New Computer 的历史 Dot、Agent Cue 菜单栏工具和其他同名 Cue 不混入比较。若后续指定其他同名产品，应追加独立调研。

证据分三类：**官方披露**（产品文档说明的机制，不代表独立实测）；**源码核查**（本工作树能读到的行为，未运行）；**设计提案**（newMate 拟建机制）。闭源产品的模型循环、记忆检索实现和后台采样算法没有获得源码，不能做逆向实现已证实的陈述。本轮没有登录竞品、购买服务或执行用户电脑操作。

## 2. 官方披露的可借鉴机制

| 对象 | 公开机制 | 对 newMate 的启发 | 未知或不应照搬的部分 |
|---|---|---|---|
| OpenAI Dots | 持续身份、云电脑、连接应用、长期责任、偏好学习、工作检查与动作审批 | 陪伴对象跨任务延续；用户授予责任后可持续推进；成果与待决策事项回到用户 | 未公开内部状态机、记忆算法、调度与计算成本；本机 DSH 不具备离线云端运行保证 |
| Grok Bot | Bot roster、聊天、Skills/Routines、产物；头像呈现工作状态 | 身份、任务、运行状态分离；桌宠动作承载状态，详情按需展开 | 视觉设计文章说“自己的电脑”，实际电脑文档明确账户级共享，不能把 Bot 头像当隔离边界 |
| Manus Cue | 每个 Agent 的邮箱、电话号码、钱包与电脑；群聊分工、连接服务和 routines；用户定义审批边界 | 长期身份可以绑定职责和资源；未来可设计协作，但单个伙伴先闭环 | 未公开钱包托管、身份隔离、群聊调度及记忆实现；本地组件不应首期引入支付和电话服务 |
| OpenClaw（开源参考） | 官方记忆文档描述工作区 Markdown 持久化；heartbeat 文档描述周期检查、安静返回与投递控制 | 状态写盘、长期事实可查看、后台检查不必每次通知 | 不把周期模型心跳照搬成高频看屏；本轮未审计整个代码库或做运行验证 |

上表仅概括来源披露；迁移到 newMate 的决策是本项目提案。

- Dots：[Introducing dots](https://openai.com/index/introducing-dots/)。官方发布页为 2026-09-29，本轮读取于 2026-10-11。
- Grok 产品对象与头像状态：[Designing Grok Bot](https://x.ai/news/designing-grok-bot)。
- Grok 账户级共享电脑：[Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)，页面注明 2026-10-09 更新：cookies、文件和命令行凭据共享；各 Bot 屏幕是工作面，不是安全边界。
- Grok 动作审查：[Grok Bot security](https://docs.x.ai/grok-bot/security)：审查覆盖多种动作，但不覆盖所有副作用，记忆写入也是明确例子。
- Cue：[官方主页](https://cue.im/) 与 [Manus 2.0 官方说明](https://www.manus.im/zh-cn/blog/introducing-manus-2-0)。主页正文直接提取为空，搜索索引可读；具体机制以 Manus 正文交叉核对。主页与发布文对桌面下载可用性的口径存在差异，本轮不作实际可用性保证。
- OpenClaw：[仓库](https://github.com/openclaw/openclaw)、[Heartbeat](https://docs.openclaw.ai/gateway/heartbeat)、[Memory overview](https://docs.openclaw.ai/concepts/memory)。

## 3. “陪伴”的产品定义

newMate 的价值是：**记得已确认的偏好与承诺，在授权范围内持续跟进，在合适时机提供帮助，并让用户随时知道它为何出现。** 首期服务研究、开发、学习等长期活动，同时支持用户主动闲聊与轻量关怀。

陪伴体验的四个组成：

1. **连续性**：重启后仍知道未完成的责任；每次 Agent API run 的临时上下文由持久化状态重新构造。
2. **适度主动**：用户明示的提醒、任务完成、失败和需要决策可主动出现；普通窗口变化只触发候选事件，不能直接成为打扰理由。
3. **有据可查的熟悉感**：引用用户确认过的习惯和以前的承诺；用户纠正后同步撤销旧事实、索引和待发提醒。
4. **真实状态表达**：桌宠安静、思考、执行、等待用户、失败等状态来自内核事实。动画不伪造进度，持续显示不意味着模型持续推理。

不以读屏推断“焦虑、抑郁、孤独”等心理事实，不用关系分数刺激留存，不以“你不理我”制造压力。用户拒绝主动建议后可关闭对应主题；这种偏好不撤销用户明确要求的失败通知。情绪表达可以由用户主动提供，系统仍需保留来源与有效期。

## 4. Newmark2DSH 当前源码提供了什么

本轮工作树 `packages/newmark-core/package.json` 标称 **0.2.39**。这是源码基线，不是本轮安装态或注册表验证。现有 Core 挂载 MemoryLab、ComputerUse、Agent API 三个组件，NewMate 显示和大小配置已经存在于 CU/Core。

| 已核查文件 | 源码可支持的结论 | 对设计的限制 |
|---|---|---|
| `packages/newmark-core/index.js`：`COMPONENTS` | 三组件独立挂载，Core 承担共用配置与模型选择 | newMate 拟作为第四组件，需要另行注册、UI与生命周期设计 |
| `components/agent-api/component.js`：发布契约、`callScope` / `dispatchScope` / `buildRunTools` | 有 `agent_api_state/catalog/tool/send`；run 自有循环调用 DSH llm；使用 Core 准用模型；工具范围可显式筛选 | 默认 `memory_lab_*` 含写工具；空 allow 被拒绝；进程级/PTC reach 不自动继承会话 guard；临时 run 不是持久聊天 |
| 同文件：工具结果转换与结果 envelope | 成功、无能力、失败、取消分开；工具结果转成文本或 JSON 文本 | 没有在这条链上证明截图以视觉块进入模型；不能靠文件路径弥补 |
| `components/agent-api/lib/llm-seam.js` | 对接 DSH Provider 和流式回复，保持工具调用参数的协议形状 | 不另配 API key；以实际调用处为准，旧注释中“可独立模型覆盖”不应覆盖 Core 现行契约 |
| `components/computeruse/lib/win32.js`：`sparseObservation` | 32×18 灰度测量；采样最小间隔200ms；单次采样等待参数最大5000ms；独立 sparse lane | 返回 `must_reacquire_full_observation: true`；不是视觉理解，也不是长期订阅 |
| 同文件：差分与结果 | 相对本次调用首样本，灰度差≥24计普通变化，≥64计强变化；至少4普通格或2强格触发 | 跨调用没有连续基线保证；细字、等亮度颜色、小区域变化可能漏检 |
| `lib/newmate-settings.js`、CU 的 `desktop-pet.*` | 已有桌宠配置与原生呈现 | 现有桌宠随 CU 生命周期；常驻陪伴呈现需要独立生命周期，不能长期占用接管槽 |

**与母项目历史边界的差异必须保留：** 此处 Win32 `sparseObservation` 返回稀疏回执，不自动跟随完整观察；调用者必须显式补采。`deadline` 在 `prepareLane` 之后创建，采样 worker 自有超时，因此5000ms不是含初始化的墙钟总时限。不能把母项目旧描述直接当移植版现状。newMate 必须增加外层总预算、取消和测量证据。

隐藏桌面、Windows真实/虚拟、Linux X11/WSLg 应分别报告能力。已有 Linux 桌面呈现不能证明稀疏哨兵等价；原生 Wayland 不作自动兼容承诺。Windows hidden-desktop 与一般 HWND 观测的稀疏路径也应单独验收。

## 5. 收敛结论与取舍

采用 **MemoryLab定制伙伴 + 本地文件分层测量 + 消极主动响应 + 有界 Agent API 判断 + DSH本体对话唤起**。主动链硬禁止删除，首期本机部署、单伙伴、一个活动run、多个责任排队。不另建LLM客户端或MemoryLab替代库。

从 Dots 学长期责任，从 Grok Bot 学身份与状态表达，从 Cue 学资源与职责契约，从 OpenClaw 学可查看的持久状态与安静心跳。newMate 的差异化是让低成本本地信号承担“是否值得再观察”的问题，把模型预算用在用户授权的有意义变化上。

首期P0：文件watcher丢事件恢复与读取预算、主动删除硬禁止、MemoryLab定制上下文、真实宿主对话创建/投递/导航契约、进程级权限与持久恢复。独立呈现需保留；视觉输入和CU采样墙钟契约在后续可选电脑任务阶段补足，不阻断纯文件陪伴。

文件检测选型与可靠性参考 [Node fs.watch](https://nodejs.org/api/fs.html#fswatchfilename-options-listener)、[ReadDirectoryChangesW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw)。这些API文档支持事件通知有遗漏/平台差异的边界，不证明newMate已实现或零漏检。

本轮成果是可评审设计；以上机制均未据此新增运行组件。后续实验、开发和发布分别设门禁，见 [内核设计与验收矩阵](08-newmate-kernel-design.md)。
