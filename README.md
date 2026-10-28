# Newmark2DSH

**让 DeepSeek Harness 记住项目背景、完成桌面操作，并为你提供适时的日常陪伴。**

Newmark2DSH 将 Newmark 的持久记忆、桌面自动化与私人秘书式陪伴带入 **DeepSeek Harness（DSH）**。你可以把项目背景和长期偏好留在 MemoryLab，让 Agent 借助 ComputerUse 处理图形界面工作，由 NewMate 处理日常对话和定时待办；需要更新、重启后继续工作时，heartBeat 负责把已经登记的任务交回正确的对话。

所有组件随一个插件包交付，无需分别安装。五个开关让你按需启用功能，数据默认保存在 `~/.Newmark`。模型使用 DSH 已配置的供应商与插件中选定的授权模型，界面跟随宿主主题，NewMate 与 ComputerUse 共享桌宠。

[获取发布版本](https://github.com/positer/newmark2dsh/releases) · [npm 包](https://www.npmjs.com/package/newmark2dsh) · [项目结构](https://github.com/positer/newmark2dsh/blob/main/OVERVIEW.md) · [维护约定](https://github.com/positer/newmark2dsh/blob/main/taste.md)

**阅读导航：** [整体能力](#从一次聊天到持续的工作与陪伴) · [五个子组件](#五个子组件逐一认识) · [Dev / rDev](#dev-与-rdev按工作范围选择预设) · [快速开始](#快速开始) · [平台支持](#平台支持与验证范围) · [数据与协作](#本地数据与组件协作) · [项目结构](#项目结构与开发入口)

## 从一次聊天，到持续的工作与陪伴

想象你正在维护一个长期项目：MemoryLab 留下项目约定和研究线索，下一次需要时可按标签找回；Dev 在代码仓库里规划、实现并整理记录；ComputerUse 打开只能通过窗口操作的应用；NewMate 根据已有记忆回应你，也能在约定时间激活一轮对话或发送原文提醒。更新宿主前登记后续任务，heartBeat 会在新进程就绪后交接，让原对话在重启后收到已经登记的后续任务。

这些能力可以按需求组合使用：

| 组件 | 帮你完成什么 | 主要入口 |
| --- | --- | --- |
| **MemoryLab** | 长期树状记忆（用户画像、知识图谱）与短期到期列表（跨对话任务交接） | MemoryLab 侧栏、记忆工具 |
| **ComputerUse** | 观察屏幕和应用，执行鼠标、键盘及窗口操作 | `computer_use`、`screen_capture`、原生接管提示与预览 |
| **Agent API** | 用统一接口发现工具、派发工具、调用授权模型完成一次 Agent 运行 | `agent_api_catalog`、`agent_api_tool`、`agent_api_send` |
| **NewMate** | 带记忆的对话、实时引导、低打扰主动联系与定时待办 | NewMate 侧栏、共享桌宠、对话工具、认证 MCP |
| **heartBeat** | 登记重启后任务，在宿主恢复后可靠交接并留下消费回执 | `heartbeat_after_restart`、`heartbeat_restart`、插件更新流程 |

另外随包提供 **Dev / rDev 两种 Agent 预设**。预设决定对话使用的工具组合，不计入五个组件开关。

## 五个子组件，逐一认识

### 🧠 MemoryLab：把值得记住的内容，变成可查找的知识

项目的命名约定、反复引用的理论推导、已经确定的个人偏好，都可以成为长期记忆。MemoryLab 用 Markdown 内容和标签关系组织这些信息，让 Agent 既能查到具体段落，也能了解一条记忆在知识图中的位置。

- **两种记忆，分工写在每一条工具描述里。** MemoryLab 是长期、稳定、树状的持久记忆（标签父链构成知识图），适合用户画像与知识图谱；`shortMemory_*` 是扁平列表式的短期记忆，默认七天到期、过期行保留并标记，用于跨对话的临时任务交接。13 个记忆工具的描述都以各自那一句开头，模型读到一个工具就知道该写哪一边。
- **长期记忆与共享文件格式。** 默认使用 `~/.Newmark/Memory Lab`，包含索引、记忆正文、历史归档和操作记录，与 Newmark 用户库共用文件格式。可配置根目录。
- **可探索的标签图。** 总览展示知识关系，详细视图显示标签与关联记忆；支持搜索、拖动、缩放、选择和双向／父链／子树／直接四种关注方式。
- **按需检索。** 查询可限定结果数量和返回文本长度，支持读取记忆、获取根标签和子标签树，避免每次都把整座知识库塞进上下文。
- **可核对的更新。** 支持新建、追加和局部替换。修改前归档旧版本，用 `expectedUpdatedAt` 检查记忆是否已被其他操作更新，重建索引并回读核对后才报告完成。
- **标签整理。** 重建索引会规范化标签，重复重建得到一致的标签关系；标签审阅与应用工具帮助进一步整理关系，保留明确的修改记录。
- **短期记忆。** 默认七天到期，可指定到期时间。页面展示序号、存入与到期时间；过期内容灰显保留，召回返回最近十条并标注是否过期。它适合跨对话的临时任务交接（做到哪一步、下一步做什么），长期内容写 MemoryLab。

主要工具：`memory_lab_read`、`memory_lab_query`、`memory_lab_root_tags`、`memory_lab_subtag_tree`、`memory_lab_update`、`memory_lab_delete`、`memory_lab_reindex`、`memory_lab_tag_review`、`memory_lab_tag_apply`，以及 `shortMemory_add`、`shortMemory_recall`、`shortMemory_where`、`shortMemory_size`。

**一个例子：** 将“项目采用何种单位制、变量命名和误差定义”保存为带标签的记忆；下次讨论模型时按标签读取，并在结论变化后增量更新。NewMate 会自动取得完整标签树、全部短期记忆与工具组 schema 作为背景，具体长期正文仍按需查询。

### 🖥️ ComputerUse：让 Agent 看见窗口，也能动手操作

当任务需要使用图形界面，ComputerUse 提供从观察到操作的统一入口。它可以列出应用、观察窗口、等待变化、组合连续动作，也能执行点击、拖动、滚动、输入文本和组合键。

- **观察与操作分开。** `screen_capture` 只读采集，不改变接管租约；`computer_use` 负责观察、应用操作和接管生命周期。
- **完整与稀疏观察。** 完整观察提供当前画面；稀疏观察在限定范围内检查画面或控件变化，减少重复采集，需要具体画面时再做完整观察。Windows 可结合 UI Automation，macOS 可选择像素或 Accessibility（AX）通道。
- **真实与隔离桌面路径。** Windows 支持真实桌面与隐藏桌面，Linux 提供 X11 / Xvfb 路径；macOS 采用用户预先准备的 Mission Control Space 与 AX 操作，具体区别见“平台支持与验证范围”。
- **明确的接管归属。** 租约绑定调用者，冲突返回占用信息；停止与异常退出执行释放和清理。Windows 与 Linux 支持将已有窗口映射到另一桌面的预览与输入界面，并通过推出／拉入切换呈现位置，应用继续在原进程中运行。
- **看得见的工作状态。** 真实桌面接管使用黑白动态包边；共享桌宠显示相应状态，展开后可查看只读目标预览。预览用于了解进度。
- **用户优先。** macOS Space 输入等待用户键鼠空闲，操作后尝试恢复原前台窗口和鼠标；用户重新操作时让出。Space 共享用户输入，按键或滚动可能短暂激活目标窗口。

主要动作包括 `observe`、`app_list`、`app_observe`、`wait_for`、`sequence`、`takeover_start`、`takeover_stop`、`move`、`click`、`drag`、`scroll`、`type`、`key` 和应用级操作。

**一个例子：** 先观察目标应用，确认窗口和控件，再输入内容并回看结果；较长工作可通过桌宠预览查看进度，结束后释放接管。Windows 隐藏桌面与 macOS Space 的行为不同，应按平台选择路径。

### 🔌 Agent API：把模型和工具，接到同一套调用接口

Agent API 是组件间复用模型与工具能力的桥梁。NewMate 的推理也通过这条入口完成，因此它沿用 DSH 的模型解析、请求准备与标准流回复处理。

- **先发现，再调用。** `agent_api_catalog` 列出调用环境中的工具，`agent_api_tool` 派发具体工具，`agent_api_send` 发起带步骤与超时限制的 Agent 运行。
- **明确模型身份。** 按供应商与模型成对选择，同名模型保持隔离，复用宿主公开适配层；配置页可选择允许插件使用的模型。
- **按任务提供工具。** 运行可配置允许／拒绝列表、工作目录和结构化输出，回执说明哪些工具可见、哪些可从当前入口执行。
- **视觉输入。** 对支持图像的模型，将图像接入宿主附件结构；完整 ComputerUse 捕获可进入视觉上下文，仅有稀疏观察结果时，仍需完整采集才能取得图像。
- **统一结果与错误。** 保留完整 JSON，返回 `ok`、`exit`、错误分类及调用范围等信息，方便调用方判断成功、拒绝或失败。
- **有界恢复。** 对尚未交付可用内容的特定传输故障进行有限重试；已经返回工具调用的失败流不自动重发，避免重复执行。

**一个例子：** 让一次独立运行读取指定记忆并返回结构化判断；调用方可核对所用模型、执行步骤和结果。PTC 模式下，对话可见的工具与 Agent API 能直接派发的工具可能不同，工具目录会说明这一区别。工具名单不能替代会话权限和操作系统沙箱。

### 🐾 NewMate：带着记忆，在合适的时候出现

NewMate 是一位亲近、务实的私人秘书式 Agent。它拥有独立聊天入口、持久任务队列和共享桌宠，可以回应你，也可以根据可信的新内容低频主动联系。

**日常对话**

- 初始化上下文一次给全：人格 prompt、完整 MemoryLab 标签树（全部标签与每个记忆节点的名称/所属标签，不含正文）、全部短期记忆（每行带到期标记）与本轮工具组 schema；工具组按当前注册表暴露只读对齐，缺失项显式列出，兼容插件提供的工具。每次推理前检查是否需要更新，记忆正文仍按需读取。
- 当前轮运行时可以继续补充要求，输入作为实时引导在模型／工具边界生效；用户工作优先于后台任务。
- 支持只读历史与关注保护，结合阅读、草稿、输入和任务状态决定是否适合自动换新对话，旧记录保留。
- 回复中的真实文件链接在 NewMate 侧栏调用 DSH 已注册的原生预览；无法预览时定位到文件管理器。
- 自包含 HTML 可直接在回复内交互，支持按钮、输入、展开、源码查看和复制。脚本在隔离 iframe 内运行，不开放同源宿主访问或外部网络。

**低打扰陪伴**

- 提供主动开关、安静／适中／活跃频率、静默时段与暂停设置。输入、阅读、宿主工作、CU 忙碌等状态会延后后台激活。
- 有可信且有用的新内容才主动发信，通常保持简短；没有合适内容就安静，连续未回应会逐步降低打扰频率。
- 新消息通过共享桌宠气泡提示，完整正文留在聊天；主动消息不自动弹出主窗口。双击桌宠或点击消息可进入 NewMate。
- 桌宠沿用浅色／深色／系统主题，支持大小配置与右键设置入口；退出陪伴释放陪伴的所有权，CU 可继续使用共享桌宠。
- 可显式指定目录做浅层文件变化观察，默认不启用；根据变化标记，在次数和范围限制内判断是否需要回应，文件事件可能合并或遗漏。

**定时待办 toDoList**

页面、任意 DSH 对话、NewMate 和认证 MCP 都可以创建、查询或取消待办。每项保存明确的激活时间（含时区）和内容，有两种到期方式：

| 方式 | 到期后的行为 | 适合的需求 |
| --- | --- | --- |
| `conversation`（新待办默认） | 在关注保护允许时，以原生记忆和已有上下文运行一轮 NewMate | “明天九点，结合已有计划帮我梳理今天要推进的事情” |
| `reminder` | 投递保存的原文，不额外调用模型 | “明天九点提醒我提交材料” |

**两种到期方式的闸门不同，这是刻意的**：

| | 需要满足 | 不需要满足 |
| --- | --- | --- |
| `reminder` | 陪伴开关开启 + **NewMate 自己空闲**（没有正在运行或排队的对话轮次） | 宿主有没有别的会话在跑、桌宠、阅读、键鼠输入、草稿、静默时段、暂停 |
| `conversation` | 上面两条 **加上**完整注意力闸：非静默、非暂停、桌宠就绪、**宿主无会话运行**、页面未在阅读、无草稿、键鼠空闲 ≥ 60 秒 | — |

**提醒不等宿主**：投递一条原文提醒不花模型、不打断任何人的回合，所以「别的会话正在跑」不会让提醒迟到。**静默时段与暂停只静音气泡，不延迟消息**——消息与回执照常落盘，「它到了」和「它打扰你了」是两件可以分开说的事。

被拦下时面板会说出原因（`todo.deferred`：等陪伴开启 / 等 NewMate 空闲 / 等宿主空闲 / 静默时段 / 已暂停 …），而不是笼统一句「等待合适时机」。稳定任务身份和消息回执用于防止重启后重复激活或提醒；失败和运行中崩溃不会自动重试。

主要工具：`newmate_chat`、`newmate_task_status`、`newmate_memory_context`、`newmate_state`、`newmate_message`、`newmate_todo_add`、`newmate_todo_list`、`newmate_todo_cancel`、`newmate_mcp_info`。有宿主绑定的原对话时，`newmate_task` 可把具体后续任务交回该对话；模型参数不能另选目标。

NewMate 可以读取、新建和增量更新可信记忆、整理标签及添加短期记忆；其工具组合不开放记忆删除、任意 Shell 执行或 CU 操作。需要更广权限的工作由原 DSH 对话继续处理，记忆内容本身不会增加授权。

### 💓 heartBeat：让一次重启，有明确的交接点

heartBeat 负责持久化重启后任务与消费回执，也为插件更新流程提供宿主重启入口。

- **先登记后续任务。** `heartbeat_after_restart` 仅绑定调用它的当前 DSH 对话，目标身份从宿主取得。
- **等待新宿主就绪。** `heartbeat_restart` 发起全局重启，辅助程序核对新进程身份与路径后再交接登记任务。
- **投递需要持久化确认。** 任务交接会等待宿主确认消息已持久保存，并以固定消息身份核对恢复状态；失败保留任务和错误。
- **消费后不再重放。** 成功交接时移除可执行任务载荷，仅保留永久消费回执。交给 NewMate 表示其队列已接受，模型完成状态仍需查询。

**一个例子：** 更新插件前登记“重启后核对新版本并继续当前工作”；宿主恢复后，任务交回原对话。当前自动全局重启面向官方 **Windows DSH Desktop**，其他平台的自动重启尚未提供同等支持。

## Dev 与 rDev：按工作范围选择预设

两种预设都采用 **PTC 工具呈现**（`run_code` 与生成的工具 SDK），并要求先读取项目文档、完成后更新说明与归档，适合需要长期管理的软件与研究项目。

| 预设 | 共同能力 | 区别 |
| --- | --- | --- |
| **Dev** | 项目文件、命令、搜索、技能、规划、任务与子 Agent 等工具 | 额外提供 DSH 运行时组合检查、组合开发技能，以及有 profile 上下文时的插件管理 |
| **rDev** | 同一套项目工作工具与文档协议 | 去掉运行时组合检查、额外组合技能目录，禁用插件管理 |

在 DSH 对话的预设选择器中选用。插件配置页只管理组件与插件偏好，不提供 Dev 预设开关。rDev 缩小工具组合；实际文件权限、沙箱和审批仍由宿主会话决定。

## 快速开始

1. 在 DSH 配置好模型供应商，确认所选模型可用。
2. 通过 DSH 插件管理器安装 **`newmark2dsh`**。安装时可显式指定版本，避免宿主的新发布包等待策略选中较旧的包。
3. 打开 **Newmark Core** 配置页，选择允许插件使用的供应商／模型，并开启需要的组件。
4. 从侧栏打开 **MemoryLab** 维护记忆，或打开 **NewMate** 开始聊天；需要桌宠陪伴时，再开启陪伴设置；桌面操作则通过 `computer_use` 发起。
5. 更换已经加载的后端或原生代码后重启宿主；官方 Windows 容器可使用启用的 heartBeat 完成交接。

五个组件分别可以启停，但组合能力有依赖：**NewMate 推理需要 Agent API，原生记忆背景需要 MemoryLab；桌宠功能复用 ComputerUse 的原生实现；自动更新重启需要 heartBeat。** 停用组件会释放对应入口、工具与运行资源，持久用户数据保留。

对话中的首次体验可以从这三件事开始：

> “请把这个项目已经确定的命名约定保存到 MemoryLab。”
>
> “先观察目标应用，告诉我当前窗口里有什么。”
>
> “明天上午九点提醒我提交材料，只发送原文提醒。”

外部 Agent 接入 NewMate 时，调用 `newmate_mcp_info` 获取 MCP 路径与本地凭证文件位置。使用宿主实际 HTTP 地址加 `/newmark-newmate/mcp`，通过 Bearer 凭证访问，并满足宿主自身鉴权。凭证应留在本地受保护环境。

## 平台支持与验证范围

| 平台 | 当前桌面路径 | 已有验证与使用前提 |
| --- | --- | --- |
| **Windows** | 真实／隐藏桌面、UIA 与像素观察、共享桌宠与窗口呈现；官方容器自动重启 | 已在官方 Windows DSH 安装并核对包内容，通过完整验收及原生预览、菜单、待办、MCP、重启恢复检查；原生辅助程序使用系统 .NET Framework 编译并按源码缓存 |
| **macOS · Apple Silicon** | 像素／AX 双通道、用户准备的 Mission Control Space、共享桌宠与真实桌面接管包边 | macOS 14／15／26 ARM 云端原生与网页矩阵、真实双 Space 夹具及 1x／2x 渲染检查；按所用通道授予 Accessibility／屏幕采集权限 |
| **Linux / WSLg · X11** | 真实 X11 应用观察与输入、带认证的 Xvfb 隔离会话、Qt 桌宠及呈现映射 | 已有 X11／WSLg 路径验证；依赖 Xvfb、xauth、Openbox、xdotool、wmctrl、Python Xlib／PIL／PyQt5；WSLg 路径针对 Linux GUI 应用，原生 Wayland 控制尚不支持 |

Mac 云端夹具验证不等于官方 Mac DSH 整机安装、实体键鼠时序、多屏／全屏组合或最低硬件性能验收；Space 也不提供完整输入隔离。跨平台保持相近的包边、桌宠比例与主题风格，原生菜单和物理像素表现会随平台与 DPI 变化。

[Mac 原生／网页矩阵](https://github.com/positer/newmark2dsh/actions/runs/38394193819) · [Mission Control 双 Space 矩阵](https://github.com/positer/newmark2dsh/actions/runs/38395064819) · [Mac 验收边界](https://github.com/positer/newmark2dsh/blob/main/MACOS-CANDIDATE.md)

## 本地数据与组件协作

默认数据根目录是 `~/.Newmark`。MemoryLab 长期与短期记忆、NewMate 状态和持久任务在这套用户库中保存；用户可以配置根目录。模型请求经 DSH 已配置的供应商发出，使用哪家模型由授权选择决定。

```mermaid
flowchart LR
    User[用户与 DSH 对话] --> ML[MemoryLab · 记忆与标签]
    User --> CU[ComputerUse · 观察与操作]
    User --> NM[NewMate · 对话与待办]
    NM --> ML
    NM --> API[Agent API · 授权模型与工具]
    CU --> Pet[共享桌宠 · 状态与预览]
    NM --> Pet
    User --> HB[heartBeat · 重启后交接]
    HB --> Resume[原对话或 NewMate 持久队列]
```

图中箭头表示能力协作关系。NewMate 与 CU 共享桌宠，但陪伴消息、CU 接管租约与各自启停状态分别管理。开启陪伴不等于给 NewMate 开放整台电脑操作权限。

## 项目结构与开发入口

公开 GitHub 仓库以可交付插件包为根目录：

```text
newmark2dsh/
├── index.js / client.js       宿主组合与网页界面
├── cordis.patch.yml           Core 装配及 Dev / rDev 预设
├── components/
│   ├── memorylab/             长短期记忆、索引、标签与工具
│   ├── computeruse/           平台自动化、原生桌宠与窗口呈现
│   ├── agent-api/             模型接入、Agent 运行与工具派发
│   ├── newmate/               聊天、关注保护、待办、MCP 与持久队列
│   └── heartbeat/             重启任务、交接和消费回执
├── lib/                       用户根目录、模型选择、状态与更新等公共模块
├── locale/                    界面本地化
├── docs/                      公开技术说明
├── scripts/                   发布检查与专项验证
├── .github/workflows/         CI 与发布流程
└── README.md / OVERVIEW.md / taste.md
```

开发工作区中，这个插件包位于 `Newmark2DSH/packages/newmark-core/`，专项脚本与时间戳归档位于 `Newmark2DSH/scripts/` 和 `Newmark2DSH/archive/`。本地用户配置、会话、凭证及开发档案不属于公开包。

在公开仓库根目录可运行发布结构检查：

```sh
node scripts/check-release-bundle.mjs .
```

此检查核对五组件自包含装配，平台原生行为和真实模型运行需执行各自专项验证。更多文件职责见 [OVERVIEW.md](https://github.com/positer/newmark2dsh/blob/main/OVERVIEW.md)，后续文档与实现遵循 [taste.md](https://github.com/positer/newmark2dsh/blob/main/taste.md)。

## 更新与版本

README 只描述当前功能，不标注具体版本号：每个版本带来了什么、何时验收，以 [GitHub Releases](https://github.com/positer/newmark2dsh/releases) 为准；更早的 CHANGELOG 留在本地归档中。

文档更新不代表重新发布 npm 包，也不改变你已经安装的版本；需要版本号时，请以插件管理器显示的已安装版本或 GitHub Releases 为准。

## 许可与反馈

项目采用 [LICENSE](https://github.com/positer/newmark2dsh/blob/main/LICENSE) 中的专有许可条款。源码、文档、品牌与项目资产的使用及再分发须取得条款要求的授权；第三方依赖遵循各自许可。

欢迎通过 [GitHub Issues](https://github.com/positer/newmark2dsh/issues) 提交建议与可复现问题。报告时附上插件版本、DSH 版本、系统与复现步骤，分享日志前去除凭证、私人记忆和用户文件内容。
