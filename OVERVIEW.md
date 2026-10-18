# Newmark2DSH — Overview

## 2026-10-18 `sweep`：按方向/速度/时长的连续相对鼠标运动（0.3.18）

**用户诉求**：Agent 反馈「cu 和虚拟桌面无法进行游戏转向」，要求补全拖动鼠标逻辑并更新 newmark2dsh；随后指定新行为的形状为「向指定方向、什么速度、移动多久」。

**根因（实测，不是推断）**。同一支注册了原始输入的 WinForms 探针（`RIDEV_INPUTSINK`，在自己的窗口过程里数 `WM_INPUT`）上：

| 调用 | 指针 | 原始包 | 原始增量合计 |
|---|---|---|---|
| `SetCursorPos` 连做两次 | **移动** | **0** | (0,0) |
| `drag`（文档形状 start→end） | 移动 200 px | **0**（总包 2 = 两次按键跳变） | (0,0) |
| `mouse_event(MOUSEEVENTF_MOVE, 120, -60)` | 移动 | 1 | **(120, -60)** |
| `sweep` 方向 0 / 1200 px·s⁻¹ / 250 ms | 移动后被放回 | 16 | **(300, 0)** |

即**移动指针 ≠ 交付运动**：绝对定位对读取原始增量的消费方完全不可见，所以绝对拖动无论走多远都不能转向游戏视角；相对注入交付的正是注入的增量。**顺带修掉一条真实缺陷**：`desktopPhysicalAction` 把 `x`/`y` 的 `point_required` 守卫排在 drag 分支之前，按文档只给 `start_x/start_y/end_x/end_y` 的 `drag` 直接 `point_required`，只有同时给哑元 `x`/`y` 才走得到拖动脚本——本轮门禁的 A/B 一开始因此根本跑不起来。改法是 `drag` 豁免该守卫，保留自己的 `drag_points_required`。

**新增动作 `sweep`（Windows）**。参数就是用户的三问加三项：`direction`（方向名或屏幕角度，0 向右、90 向下）、`speed`（px/s，1..8000）、`duration_ms`（1..15000）、`button`（`none`/`left`/`right`，整个手势按住，`finally` 释放）、`inject_steps`（1..240，默认约 16 ms 一步；不叫 `steps` 是因为那是 `sequence` 的参数名）、`restore_cursor`（默认真，用不产生原始运动的绝对调用把指针放回起点）。位移是闭式 `dx = round(cosθ·speed·duration/1000)`、`dy = round(sinθ·…)`，每步取**累计差**，最后一步吃掉余数，保证注入之和**精确等于** `dx,dy`。门禁实测：`sum_dx` 在 1/2/5/20/100/240 步都精确等于 200。回执同时给 `dx`/`dy`（原始增量）与 `cursor_displacement`（光标实际位移）——本机 `MouseSpeed=1`，加速让光标多走（实测 300 px 注入走出 805 px / 923 px，gain 2.68 / 3.08），**判据只能用前者**。

**隐藏桌面 = 按名拒绝，拒绝理由就是一次测量**。第一版把 `sweep` 路由到隐藏桌面上的常驻 agent，agent 的 C# 原语逐步注入并报告成功；但该桌面上注册了原始输入的探针（`registered=1`、手势期间每秒自发布 13→15 次、文件时间前进）收到 **0** 个包、增量 (0,0)，而本桌面的指针与前台窗口前后未变。原因是结构性的：**隐藏桌面永远不是输入桌面**，系统不在那里维护指针、也不派发原始运动；隐藏桌面能接受的只有投递式窗口消息，而读取原始增量的消费方不看它们。因此路由改为**注入前**就按名拒绝 `sweep_unsupported_on_hidden_desktop`，回执带 `measured_raw_packets: 0`；`mode_report` 把它列进 `hidden_desktop.not_routed` 并在 `refused_by_name` 里点名；`app_drag` 的拒绝文案改为指向真实桌面。agent 侧 `sweep` 原语保留（已编译、方言门禁 9/9 通过），作为该否定结论的仪器与将来换 Windows 版本重测的入口，工具面不可达。

**门禁**：新增 `scripts/verify-cu-sweep.mjs`（9 条命名检查，1 条需要 `--mutations` 才跑）与 `scripts/measure-*` 式变异（把注入换成 `SetCursorPos` 要求检查 3 变红、还原后逐字节核对 sha256 并要求变绿）。检查 1（物理）、2（旧 drag 的缺陷）、3（sweep 的交付与按键跳变）、4（闭式算术与逐步求和）、5（光标放回、且只有被要求时）、6（每个拒绝码且不交付）、7（隐藏桌面按名拒绝 + 该 0 包测量）、9（动作在模型可及处被广告）在 07-19 那一轮全部 PASS，检查 8 因未加 `--mutations` 而 SKIP。**控制组的一次失败**（还原后重跑的检查 3 报 `Cannot read properties of null`）被判定为夹具竞态而不是产品缺陷：同一次还原后的文件哈希 `b4b5af31…` 与变异前一致，且同一哈希在上一轮检查 3 通过；夹具已改为等待探针发布句柄后再断言。既有门禁 `verify-computeruse-win32.mjs` **25/25**、`verify-computeruse-native-dialect.mjs` **47/0**（9/9 payload 编译）在本轮源码上复跑通过。**最终字节上的全量运行（`2026-10-18T07-33-49-384Z`）为 PASS 8 / FAIL 0 / SKIP 1**（check 6 报出六个拒绝码、check 7 拒绝隐藏桌面并引用 0 包测量、check 9 广告），`--mutations` 为 PASS（plant `f567aece…`，check 3 变红，还原 `b4b5af31…` 后控制组变绿）。**期间两次环境事故都已记档**：(a) 门禁进程打印判定后不退出，导致变异 parent 卡住、`win32.js` 在磁盘上停留为 planted 版本十余分钟——Lead 杀掉残留进程后文件回到 `b4b5af31…`，并用独立 harness 重做同一结论（plant→RED→restore→sha 校验→control→GREEN），门禁侧补 `process.exit`、恢复校验与信号处理器；(b) 一个 `takeover-lock.exe`（`… 102604 virtual`）被**活着的**宿主进程持有而宿主的 `mode_report` 报 `lease.held:false`（活进程内的泄漏锁，无看门狗），使 07-30 全量运行的 check 6/7 以 `takeover_lease_occupied` 失败——**环境项而非代码项**（同次运行 1/2/3/4/5/9 全绿）；Lead 终止该锁进程后重跑即通过。**但后续发现这条判断错了，必须更正**：15:35 的 `mode_report` 显示 `lease.held:false / overlay stopped` 的同时，同一份报告里 `hidden_desktop.active_routes` 仍有一条**活着的**隐藏路由（agent 108360，`launched[0]` 在隐藏桌面上起 `gradlew.bat runClient`，`requests_served` 两次读数 15 → 19）——**这就是用户报「虚拟桌面无法进行游戏转向」的现场（Minecraft 客户端）**，锁属于它。因此：(a) 我 15:33 终止的 `takeover-lock.exe`（pid 100368）**可能同样属于一条活路由**，宿主随后 15:35:37 重新 arm 了新路由（pid 104084），这条事故记在 Lead 头上；(b) 由此浮出一条**产品缺陷**（本轮未修，需单独立项）：`stop_all` 释放 lease 对象却**不拆隐藏路由与其锁子进程**，于是外部看到「锁被活着的宿主持有、租约却说没人持有」；(c) 门禁此后**先审计槽位**（列出每个锁的 owner / owner 是否存活 / 锁 pid）：活 owner → 该检查 SKIP 并写明原因，死 owner → 仍判 FAIL，从而既不在忙碌机器上伪造失败，也不放过真正的泄漏。**最终 umbrella（`verify-newmark-core.mjs`，最终字节、gate sha `034c7492…`）为 PASS：206 passed / 0 failed / 2 skipped / 208**（两个 skip 是 `tool-output-boundary` 的安装前提与 `cu sweep gate` 的 opt-in mutation 项）。同一轮里还修好了 `verify-newmark-core-activation.mjs` 里硬编码的动作数 23（改为与组件声明逐项比对，57/57 PASS），以及新门禁 check 2 的判据——**旧判据「观测位移 ≥ 声称矩形的一半」恰好落在正解上（观测 100 px vs 声称 200 px），阈值落在正解上的判据不是性质**；现在断言精确性质：真实拖动的最后一次写入是 `SetCursorPos(end_x,end_y)`，因此指针必须落在终点（±4 px）且确实走过 ≥50 px，失败最多重试 3 次并逐次记录读数。

**macOS 云实测（用户要求）**：把 0.3.18 同步到发布仓库的新分支 `codex/macos-sweep-0.3.18`（commit `d432ab2`，**未动 main**）并 `workflow_dispatch` 触发既有 `Apple Silicon release validation` —— [run 39110503481](https://github.com/positer/newmark2dsh/actions/runs/39110503481) **success**：`macos-14`（14.8.9）/ `macos-15`（15.7.9）/ `macos-26`（26.6.2, build 25G83, Swift 6.3.3, arm64）三腿全绿，判定为 `PASS 12 / 18 / 22 / 27 / 19 / 20 / 21 / 39`（dispatch、AX、Space、桌宠呈现、通道、todo、定时激活、短期记忆+MCP），并从 npm 打包产物执行了 todo kernel（`PASS 20`）与 Chromium/WebKit 真实渲染；`space_probe` 因 `probe_only=false` 按设计 skipped。**同时修掉一处 CI 缺陷**：该工作流把 `newmark2dsh-0.3.14.tgz` 写死在「Execute todo kernel from npm artifact」里，版本一动整条矩阵就会因与 macOS 无关的原因变红——改为从 `npm pack` 产物推导（日志实测 `unpacking …/newmark2dsh-0.3.18.tgz`）。**边界**：这证明 0.3.18 在 macOS 上没有回归、打包产物可用；**不证明 `sweep` 在 macOS 可用**（Darwin 后端无物理相对注入，`sweep` 仅 Windows 实现，macOS 上按未知动作拒绝）；三条腿是 GitHub 托管 ARM 虚拟机，不是官方 Mac DSH 整机、实体键鼠时序或 Retina 物理像素验收。

**落点**：`packages/newmark-core/components/computeruse/lib/win32.js`（`sweep` 规划/脚本/调度/回执、`drag` 守卫修正、隐藏路由拒绝、广告）、`components/computeruse/component.js`（动作表、参数、工具描述）、`components/computeruse/lib/hidden-agent.js`（agent 侧 `NmAgentInput` 与 `sweep` op，9 个 payload）、`scripts/verify-cu-sweep.mjs`（新）、`scripts/verify-computeruse-native-dialect.mjs`（payload 数由硬编码 8 改为按映射推导）、`scripts/verify-newmark-core.mjs`（登记新门禁）、`docs/14-cu-sweep.md`（新契约）、`docs/03-computer-use-playbook.md`（§5 更正 + §7 新增）、`README.md`、`taste.md`、`VERSION.md`、本文件、六个 manifest → **0.3.18**（未新增子组件 → patch +1）。

**本轮边界（不得写成已证）**：①没有任何真实游戏被驱动——探针是这里唯一的原始运动消费方；滤掉合成输入、或以更高完整性级别运行的游戏不在范围内。②隐藏桌面的结论只对本机这个 Windows 构建成立（门禁每次现场测量，不做跨版本推断）。③Linux 后端本轮不广告 `sweep`（`unknown_action` 自带动作清单），macOS 无物理相对注入；两者都未运行、也未声称。④按住键的异常路径释放由脚本 `finally` 与 lane 级释放守卫覆盖，未单独注入故障验证；本桌面上的物理按键路径刻意未在用户桌面按压（会拖动窗口/图标），改在隐藏桌面测量。

## 2026-10-17 0.3.17 收尾：heartbeat 取消/失败终结 + 桌宠像素级门禁

**heartbeat（补 0.3.16 的四个尾巴）**：`components/heartbeat/` 注册 **5** 个工具 —— `heartbeat_after_restart`、`heartbeat_restart`、`heartbeat_restart_commit`、`heartbeat_restart_cancel`、`heartbeat_restart_ack`；intent 仍在 `state.json`（schema 3）的 `intent`/`intents[]`。`heartbeat_restart_cancel {intentId}` 把 `preparing` 关成 `aborted(reason:'cancelled')` 并向 requester 发一条 durable 通知，只允许开这个 intent 的会话调用、只在 `preparing` 阶段（`not_requester`/`unknown_intent`/`not_preparing` 分别拒绝，`not_requester` 不关闭 intent）；`heartbeat_restart_commit` 现在只认被点名的 intent（新拒绝码 `intent_mismatch`），否则一个已撤销的 `intentId` 能花掉重新打开的新屏障。armed 任务的投递失败策略：`DELIVERY_FAILURE_LIMIT = 3`，第 3 次**失败**终结为 `failed(final)`，原因写入新增状态键 `terminated[]`（与 committed 投递同一原子清扫形状），`tasks` 同步扫出；**等待态不计失败**。门禁 `verify-heartbeat-restart-barrier.mjs` **84** 条（case 11 cancel、case 12 termination），`measure-heartbeat-restart-barrier-mutations.mjs` **28** 个 planted mutation 全部变红并逐字节还原，`verify-newmate-heartbeat.mjs` 57 条。实测生产 `~/.Newmark/heartBeat/state.json`（只读）7 条 armed 全部 `error:null`、其 helper `status.json` 全为 `state:"failed"`；隔离根 dry-run：旧组件 3 tick 后 armed=7/terminated=0，新组件 armed=0/terminated=7。

**桌宠门禁从 6 条扩到 8 条**：新增 `no_opaque_white_plate`（恰好 (255,255,255) 占比 > 0.8 判红）与 `transparent_corner_matches_the_desktop`（藏起宠物窗口拍同一矩形作参照，四个合成角点必须等于该参照、每通道 ±12，参照本身不得全白）；`stale_presentation_self_heals` 更名为 `companion_idle_keeps_redrawing` 并补上前置条件（先断言 `cu:false` 且 `pet_transition:'idle'`）与正向一半。新增 `scripts/measure-desktop-pet-render-mutations.mjs`：3 个变异全部变红并逐字节还原（去掉 1 Hz 重绘 → 保活断言红；清成白且不画精灵 → 占比断言 + 角点断言红；清成白但仍画精灵（占比只到约 0.5）→ 两条像素级断言红，证明它们在做占比断言做不到的事）。

**交接单 §A.3 的「复现配方」实测不能复现，照写**：重启宠物后取 t0 / +200 ms / +1 s / +5 s 四点、两个构建各两次共 16 帧，**没有一帧出现 >80% 纯白**（`pure255` 全为 0%），再补一次 DPI 重建触发同样干净。候选 A（首帧/尺寸）未被证实；候选 B（BI_RGB + `Format32bppPArgb` 的 alpha 语义）由同源 `PetSurface` 复跑排除（`alpha min=0 max=254 zero=22987/27234`）。可复现的只有「坏合成一旦发生便永久留存」（活体实例 100% 纯白、470 帧不变）与逐像素注入。

**门禁自身的三条失败（0.3.17）**：`verify-newmark-core.mjs` 不再用子门禁 stdout 里的 `PASS` **子串**判定 —— 改为「退出码 + 子进程最后几行的判定行」，四种结果 `pass`/`skip`/`unreturned`/`timeout`，并在摘要里单列 `timedOut=`；前提缺失（退出 2 且打印 `PREMISE ABSENT:`）显式计入 `skipped=`，不再算失败。实测父门禁的假阴性来自子门禁 `verify-newmark-core-activation.mjs` 打印 `passed=56 failed=0 total=56 / PASS` 后**不退出**（父门禁干等 15 min 预算）：现在该子门禁在打印判定后 `process.exit`，1.1 s 返回；父门禁另外把「预算内被杀但 stdout 末尾确有判定」判为 `unreturned`，判据代码从真实文件字节提取后用 6 个夹具测过（6/6）。`verify-desktop-pet-gpu.mjs` 无参数不再抛 `ERR_INVALID_ARG_TYPE`，默认证据目录为 `<scripts>/../archive/20261007-virtual-desktop-pet/evidence-gpu`。完整门禁 **200/5/0/205（17 min 34 s）→ 全绿**（修复后逐条：`verify-newmark-core-activation.mjs` 56/56 1.1 s、`verify-memorylab-tools.mjs` 168/168、`probe-compose.mjs` 25/25、`verify-memorylab-store.mjs` 46/46）。**两条定性为门禁 bug 而不是产品 bug**：(1) 三个门禁把 34 件工具硬编码成 33/31 —— `heartbeat_restart_cancel` 使组合工具数 33→34、MemoryLab 侧 31→32，三处清单已同步且仍保留「第 6 个/重名/改名即变红」的可失败性；(2) `verify-memorylab-store.mjs` 的断言假定**真实库**只有 `kind:"file"` 组件，而库里有**两个** `kind:"folder"`（本轮的桌宠交接单与 heartbeat 设计组件）—— `path=<dir>` / `coreMd=<dir>/memory.md` 正是该模块自己 check 20 断言的 folder 契约，三处改为按 `kind` 分支。**已修的真实产品缺陷**：`verify-desktop-pet.mjs` 的 `virtual startup does not activate a desktop window` 是**真实的**前台窃取 —— 接管新起的桌宠进程把自己那个隐藏的菜单宿主窗口（`NewMate · DSH 菜单`，`IsWindowVisible=false`）推到前台；创建它的是 `lib/desktop-menu.cs` 的 `DshPetMenu` 与其 `Warm()`。修法：`Warm()` 保存调用前的前台句柄，且**仅在菜单不可见时**恢复（菜单被呈现时的行为一字未改）。修复后该断言通过，`verify-desktop-pet.mjs` **11/12**。该断言本身仍偏脆（跨 10–30 s 比较一个全局且易变的前台句柄，第二个桌宠启动即会误伤），这一点保留登记。
**0.3.17 上线后的活体核验**：更新路由（`POST /newmark-core/update`，显式传 `0.3.17`）核验通过并重启成功；但它**不给调用方会话接续**（只 `schedule(…, 'newmate')`），所以「重启后没有接续」是路由语义而非接续失效。随后广播两阶段实测：intent `1158cadf…`、2 参与者 auto 回执、`commit` → `phase:'committed'`、`delivery.tasks` 两条都投递成功，**本对话即由自己的接续恢复**。生产 `state.json` 变为 `tasks=0 / terminated=7`（终止策略首次在生产上执行）；宠物 pid 13380 运行的正是修复后源码算出的 `bin/0f1907fe260d42439ff4`，实测 `pure255 0%`。

**广播重启不再过度唤醒**：判据原来读的是 `agent.running` / `agent.session.running`（宿主从不设置的字段），于是每个**载入**的对话都被当成在工作的、都进 `participants` 并在重启后收到接续；宿主自己的判据是 `agent.status === 'running'`（`dsh-agent` 的 `installTurnArchiveAdmission`）。现在参与者 = **确认在运行**的对话 + requester，`refresh()` 里新出现的会话同样要满足这一条。夹具也改成宿主的形状（`status: 'running' | 'idle'`，不再自带那个诱饵 `running` 字段），新增 case 13 钉住窄集合。门禁 89/89，变异 30/30 detected。

**更新重启也带接续**：面板/更新路由的重启没有发起对话，此前只给 NewMate 发一条通知，正在飞的回合被静默杀掉（实测：更新路由重启时本对话正在工具调用中途，重启后无任何接续）。现在 `restart(ticket, update=true)` 为**确认在运行**的对话各登记一条持久接续（同一判据 `agent.status === 'running'`），`commit()` 与广播一样 arm 并交由新宿主投递；空闲对话仍不唤醒；回执新增 `continued`。门禁 94/94，变异 32/32 detected。

**接续要恢复 goal 状态**：会话恢复会把进行中的 goal 解除武装，自动续轮只在 armed 时发生，所以接续提示词现在先读 `get_goal`：`active`+`disarmed` → `update_goal{action:'resume'}`；`paused` → 保持暂停；无 goal → 跳过。广播与更新路由入队的是同一条文本（case 15 逐字比对）。门禁 **97/97**、变异 **33/33 detected**。这是提示词级恢复（读+改由被接续的对话自己做）。**MemoryLab 交接内容已清空**（两份交接的 6 个归档修订移入工作区 archive，`#交接`/`#NewMate` 标签退役）。

**落点**：`components/heartbeat/{component.js,index.js}`、`components/computeruse/lib/desktop-pet.cs`、`scripts/{verify-heartbeat-restart-barrier.mjs,measure-heartbeat-restart-barrier-mutations.mjs,verify-desktop-pet-render.mjs,lib/desktop-pet-render-probe.ps1,measure-desktop-pet-render-mutations.mjs}`、`docs/09-newmate-heartbeat-implementation.md`、`VERSION.md`、`README.md`、`taste.md`、本文件。六个 manifest 同步 **0.3.17**，`verify-version-discipline.mjs` 12/12。归档（gitignore，不外发）：`archive/20261017-184543-pet-white-plate/`、`archive/20261017-195224-heartbeat-tails/`、`archive/20261017-195432-gate-triage/`，路径与逐文件 sha256 引用在 `VERSION.md` 的「0.3.17 审计链」。
## 2026-10-17 NewMate 桌宠白底 / 闪烁：分层窗口的**呈现过期**（0.3.17）

**症状实测（不是推断）**：用户桌面上那颗桌宠的窗口矩形（`NewMate`，hwnd `0x48F0A6E`，pid 84856，rect 2358,1327 178x153）在**显示器合成层**上是一整块纯白——用 `BitBlt` 裁该矩形，`27234/27234` 个像素全为 luma 255，连续 470 帧（含 200 帧 cu=false 空闲、200 帧描边逐帧重绘）**一帧未变**。这就是用户说的「白底」。

**判别结论：交接单的四条候选根因三条被实测排除、一条不适用。** ①窗口本来就是 layered 且处于 `UpdateLayeredWindow` 模式（`GetLayeredWindowAttributes` 对**活窗口**与**健康新实例**同样返回 false，两者 exstyle 都是 `0x08090088`）；②逐像素 alpha 的 DIB 内容正确（用同源 `PetSurface` 路径复跑同一张 1402x1122 素材：`alpha min=0 max=254 zero=22987/27234`）；③移动只改位置、内容不受影响（`SetWindowPos` 仅移动后内容完好）；④桌宠本体是 GDI 绘制，**没有任何 GPU 参数在它的路径上**，`--disable-gpu` 二分无从下手（进程里的 WebView2 只属于右键 DSH 菜单，把菜单打开与否做成 A/B 也不改变结论）。

**根因（A/B 定位）**：同一份字节的新实例在**同一时刻**渲染正确（`lumaMin 26 lumaMax 253 white250 23/27234`，精灵透过透明留白合成在深色桌面上），长驻实例却是纯白 → 绘制的代码是对的，**过期的是「呈现」**。`Tick` 只在弹簧运动或 CU 描边动画时调用 `Render()`，而 `cu:false` 且静止的陪伴桌宠两者都不满足，**于是任何一次坏呈现都再也不会被覆盖**（实测持续数分钟）；强制一次 `Render()` 后完全恢复（`dark40 18986`、`meanLuma 82`）并保持正确。与之同源的第二个缺口：`WM_DPICHANGED` 会 `BuildBody` 并改变窗口尺寸，**却不重新呈现**。

**修复（`cu/lib/desktop-pet.cs`，3 处、+28 行，无新机制）**：①在已有的 1 s `Raise` 节拍上补一次 `Render()`，把任何坏呈现的寿命限制在约 1 s；②`WndProc` 处理 `0x02E0` 时在 `base.WndProc` **之后**重新呈现（基类才会应用 lParam 给出的新 bounds）；③`UpdateLayeredWindow` 被拒时重建一次 surface 再呈现，仍失败才抛——此前该分支会把桌宠直接打死，而不是恢复一帧。抽出 `Compose(w,h)` 复用「清透明 + 贴 `painted`」的绘制，避免在重试路径上写第二份。

**验收（同一支探针跑两个构建）**：把观测到的故障**逐像素**注入回桌宠自己的 hwnd（对同一矩形调 `UpdateLayeredWindow` 呈现一张不透明纯白 DIB）——修复前的快照构建 6000 ms 后仍是整块白（`white250 27234/27234`），修复后的构建 **302 ms** 回到正确帧（`min=5 max=253 white250 476/27234`）。屏幕合成层是唯一能看见 layering 的通道：`PrintWindow(hwnd,hdc,2)` 画的是窗口那张从未绘制过的重定向表面（实测 `(240,240,240)`、`distinctLuma=1`），健康与坏实例都返回 240，**交接单验收判据 1 因此被更正而不是被满足**。新增 `scripts/verify-desktop-pet-render.mjs`（+ `scripts/lib/desktop-pet-render-probe.ps1`）把这条做成可失败的门禁，并对**修复前的包快照**跑出 RED 留档。

**落点**：`packages/newmark-core/components/computeruse/lib/desktop-pet.cs`、`packages/newmark-core/package.json`（0.3.16 → 0.3.17）、`scripts/verify-desktop-pet-render.mjs`、`scripts/lib/desktop-pet-render-probe.ps1`、`VERSION.md`、`taste.md`、本文件。本轮档案：`archive/20261017-pet-render-white/`（修复前包快照、逐文件 before/after、注入探针的原始读数与帧图、既有 `verify-desktop-pet*.mjs` 的基线日志）。未新增子组件 → `patch` +1 = **0.3.17**。

**验收实测（修复后，同机同命令）**：新门禁对**修复前快照** 5/6（exit 1 —— 注入不透明纯白 ULW 表面后，2500 ms 内 12 次采样**始终整块白** `97682/97682`）；对**修复后包** 6/6（exit 0 —— 注入后 **515–657 ms** 恢复内容帧，两次运行分别为 515 ms 与 657 ms）。五条既有门禁对修复后包复跑：`verify-desktop-pet.mjs` 10/12（与基线同一对红：桌面激活 + 遮挡）、`verify-desktop-pet-preferences.mjs` 5/5、`verify-desktop-pet-lifecycle.mjs` 7/7（**该脚本忽略包路径参数、静态 import 活仓库**，所以那一项不描述快照）、`verify-desktop-pet-gpu.mjs` 一次因探针读 `frame.png` 撞上截图进程的文件替换锁报 `IOException`（**复跑 exit 0**，快照复跑同样 exit 0 → 门禁自身的竞态，非渲染回归）、`verify-desktop-pet-motion.mjs` 修复后 4/11、6/11，快照 5/11、6/11、6/11 —— **同一批既有时序检查（`release rebounds` / `close zoom`）在两种构建上都会来回翻转**，属本机负载下的门禁抖动；唯一一次多出来的 `close zoom` 红未复现。**没有任何一条既有门禁会因为白底缺陷而变红**，这就是新门禁存在的理由。

**仍未证实的部分（不写成已证）**：**坏呈现最初由什么触发，尚未定位**。已证的是「任何一次坏呈现都会永久留存」，修法把它的寿命收敛到约 1 s，并有自愈判据盯着；触发源头与 WebView2 运行时版本的关系没有证据，因此不写进结论。

## 2026-10-17 heartBeat 两阶段重启（广播 + 回执屏障）实现（0.3.16）

`heartbeat_restart` 增可选两阶段形式：`broadcast:true` 打开屏障，按宿主 `agents().roots()` 枚举运行中的对话（不接受调用方传入的目标名），`ackMode:'auto'`（默认）为每个参与者登记持久接续、不花模型 token、忙会话也覆盖，`ackMode:'agent'` 投递持久通知并要求该会话自己回执；`heartbeat_restart_commit` 只在全部参与者终态且 requester 自己已登记时才提交重启，否则返回 `aborted` 并点名缺失者，宿主继续运行。新增 `heartbeat_restart_ack`，`heartbeat_after_restart` 增可选 `intentId`。

intent 持久化到 `~/.Newmark/heartBeat/state.json`（schema 3，新增 `intent` 与最多 20 条 `intents`；schema 2 文件照常读），由新宿主清扫：`committing` 在 helper 报告新进程身份后变成 `committed` 并记下本次投递的 `delivery.tasks`；旧进程留下的 `preparing` 变成 `interrupted` 并通知 requester「上一次没有提交就中断」。过期且无人提交的准备自行关闭。`broadcast=false` 与 0.3.15 行为一致，且屏障打开期间即时重启被拒绝。

落点：`packages/newmark-core/components/heartbeat/{component.js,index.js}`（状态机 + 四个工具）、`docs/09-newmate-heartbeat-implementation.md`、`VERSION.md`、`README.md`、`taste.md`、本文件。门禁：新增 `scripts/verify-heartbeat-restart-barrier.mjs`、`scripts/measure-heartbeat-restart-barrier-mutations.mjs`；更新 `scripts/verify-newmark-core.mjs`、`scripts/verify-version-discipline.mjs`。未新增子组件 → patch +1 = **0.3.16**。

本轮档案：`archive/` 下 2026-10-17 的 heartbeat 两阶段重启条目（含推送/拉回、打包安装、重启实测回执）。

## 2026-10-13 Newmark2DSH 0.3.14正式发布

0.3.14 已发布 GitHub/npm latest，并取回官方包核对全部 93 文件；Windows安装已替换为同一正式包，逐字节一致，官方ASAR与原配置/消息保留，heartBeat重启不重复投递。不可变标签 b5c8a3b46152da88bb1b16713fc93be9f575c320；只读官方云验收也通过。上一轮200/0/0完整门禁与Mac ARM六作业作为同一运行代码的验收证据；发布源只规范化Git文本换行，正式安装再次通过23项共享桌宠原生检查。

[发布证据](archive/20261013-release-0.3.14/REPORT.md)。


## 2026-10-13 Windows安装与Mac包边对照（0.3.14候选）

0.3.14 已安装本机官方DSH，尚未发布。修复Mac屏幕四层灰度框为顺时针周长黑白渐变，桌宠按Alpha裁剪保持比例；修复Win隐藏CU先启动后开启陪伴重建桌宠的问题。200/0/0完整门禁、92文件源码/安装一致；23共享桌宠、5尺寸、20原生GPU预览、3菜单检查通过。实际宿主待办模型激活、阅读保护、MCP和heartBeat重启不重放通过，原设置/消息/其他插件保留。Mac14/15/26 ARM六云作业成功，原生52场景、生产渲染1x/2x及实际双Space通过。视觉风格与比例对齐，不宣称逐物理像素一致、官方Mac DSH整机或Neo性能实测；Win不激活桌宠实体双击/右键本轮未独立复验。

本轮构造：darwin-native.swift 统一屏幕包边的周长渐变；desktop-pet-darwin.swift 裁剪精灵、保持比例与持久化尺寸；desktop-pet.js 保留已有 CU 桌面；共享桌宠/原生菜单/云渲染脚本扩展回归。archive/20261013-win-mac-parity 下 before 与 governance 快照保存基线，mac-final/mac-spaces-final 为三系统最终云图，windows-* 为隔离原生夹具，installed-host/native-suite/restart/audit mjs 为实际宿主路径，日志/JSON/PNG/tgz为可复核记录，REPORT.md列明目录作用及证明边界。

[完整证据与边界](archive/20261013-win-mac-parity/REPORT.md)。


## 2026-10-13 macOS动态包边专项（0.3.14候选）

修正Mac桌宠矩形外框为图片Alpha轮廓波形，normal CU用四层平滑灰度边框，单调时钟3秒相位、30Hz common-mode计时器；CU决定闪边，预览展开/仅陪伴无闪边，右键菜单不中断动画，释放清理正常。ARM macOS14/15/26原生51场景与双Space均通过；实际连续像素变化、静态无闪边、轮廓邻接0脱离像素通过，生产渲染类1x/2x离屏检查通过。不是实体Retina或官方Mac DSH整机验收。0.3.14仍为未安装发布候选，包含此前toDo对话激活。

[专项证据](archive/20261013-macos-dynamic-border/REPORT.md)。

构造：desktop-pet-darwin.swift缓存透明掩模/波形和独立动画计时器；darwin-native.swift四层屏幕边框/common计时器；verify-darwin-render-pipeline与macos-pipeline-driver比较原生连续RGBA及轮廓邻接；verify-darwin-border-scale与macos-border-scale-probe编译原生产渲染类测1x/2x。archive/20261013-macos-dynamic-border含before、cloud/cloud-final/spaces、packed、日志/散列/REPORT与规范快照。


## 2026-10-13 toDoList 适时激活 NewMate（0.3.14 候选）

新待办默认激活一轮 NewMate，结合原生MemoryLab记忆和上下文回应或处理明确委托。阅读、草稿、输入、运行任务、静默和暂停时等待；适时按现有关注策略选当前或新对话。回复通过桌宠气泡、点击进入页面，不自动弹出窗口。页面/对话工具/MCP可选择仅原文提醒，旧待办保持原语义。持久化唯一激活任务与消息回执，失败/运行中崩溃不自动重试。21激活、20提醒、23steer、12网页与12版本检查通过；完整门禁200/0/0。六manifest同步0.3.14，无新组件；本轮未安装发布。

[实现与候选包记录](archive/20261013-todo-activation/REPORT.md)。

文件：todo-list.js模式校验；component.js适时门禁/领取/调度/恢复；index.js与mcp.js同源模式参数；client.js到期方式及状态；verify-newmate-todo-activation.mjs激活证据。archive/20261013-todo-activation含before、governance前后、packed全包、web明暗响应式图片、日志、package-receipt和REPORT。


## 2026-10-13 0.3.13 已发布：Windows安装与Apple Silicon云验收

NewMate toDoList 已随现有五组件发布，未新增子组件。GitHub v0.3.13、npm latest=0.3.13；93个包内文件与Windows官方DSH安装逐字节一致。完整门禁200通过、零失败/跳过；实际GUI创建、到期等待陪伴开启、精确投递、第二次heartBeat重启不重放，以及实际宿主MCP创建/查询/取消通过。原39条消息、其他插件依赖和Loader配置保留，陪伴恢复原关闭状态。Apple Silicon macOS14/15/26完整和双Space六作业通过；每环境269项检查与5组真实Space场景，不包括官方Mac DSH整机安装、实体输入时序及Neo性能验收。首次npm传播门禁超时，后续官方取回及只读CI完整验证成功；同版本未重发。

[完整发布验收记录](archive/20261013-release-0.3.13/REPORT.md) · [公共发布](https://github.com/positer/newmark2dsh/releases/tag/v0.3.13)。

本轮新增档案 archive/20261013-release-0.3.13：before/after保存私有配置和用户状态，mac-full/mac-spaces保存原生与网页云证据，publication-cloud保存官方包验证，official-desktop-sdk/test-deps为隔离验收依赖，governance-before/after保存规范前后快照；REPORT.md为入口，操作mjs、日志、json散列与实际Windows截图构成复核链。以上开发档案不上传公共包。


## 2026-10-13 NewMate toDoList（0.3.13 候选）

NewMate 新增 toDoList 页面按钮，可手动填写激活时间和发送内容、查看状态并取消未投递项目。任意 DSH 对话、NewMate 本身及认证 MCP Agent 可通过 newmate_todo_add/list/cancel 创建与管理。到期直接投递预存内容，复用现有关注保护和自动换新对话策略，不额外调用模型；陪伴关闭时等待开启，静默/暂停/气泡冷却沿用现有规则。固定消息 ID 和持久化投递回执防止重启重复发送，历史及取消记录保留。版本为 0.3.13 源码候选，属于现有组件更新，无新增子组件。尚未安装或发布。

文件构造：components/newmate/lib/todo-list.js 校验带时区的时间、有效日历日期与内容，定义稳定投递 ID；component.js 在同一 state.json 持久化 todos、到期领取/回执恢复、保护聊天并复用 thread-handoff.js；index.js 提供 todo-add/list/cancel 页面操作；lib/mcp.js 注册对话及 MCP 的同源工具；client.js 提供页面内面板、手动表单、时间/状态/内容与取消按钮，并跟随主主题的原生日期控件。scripts/verify-newmate-todo.mjs 验证调度/权限/重启，verify-newmate-todo-web.mjs 渲染实际 React 页面并连接实际 NewMate 内核。archive/20261013-newmate-todo 保存基线、日志、截图、候选包和包内执行证据。

[实现、测试及候选包记录](archive/20261013-newmate-todo/REPORT.md)。


## 2026-10-13 Apple Silicon 渲染至操作验收

0.3.12 源码候选的渲染至操作验证已扩展：macOS 14.8.9、15.7.9、26.6.2 ARM64 每环境通过 93 组 JS 契约、45 组原生场景、28 组 Chromium/WebKit 页面场景。修复自身输入误判、组合键、macOS 26 滚动、桌宠预览遮挡、预览帧清理及 React fallback snapshot。视觉与 AX 同时可用、分别选择，交叉核验可选；Space 共享输入，100ms 用户 idle 优先。后续仅面向 Apple Silicon，Intel 旧结果仅归档。本地 288 项检查通过。尚未验收官方 Mac DSH 整机、实体键鼠、多屏组合与 Neo 硬件性能；候选未发布或安装。
文件构造：verify-darwin-render-pipeline.mjs 验证原生管线；verify-darwin-web-render.mjs 渲染真实 client.js 与 React；verify-darwin-channels.mjs 验证通道选择；verify-macos-distinct-spaces.mjs 和 macos-space-probe.swift 用公开 Mission Control AX 准备自产窗口跨桌面测试。macos-ui-fixture.swift 构造窗口，macos-pipeline-driver.swift 仅操作允许的自产 PID。归档目录保存前后源码、六份治理文档、所有场景清单、截图及失败轮次。

[完整报告与逐项证据](archive/20261013-macos-render-pipeline/REPORT.md)。

补测：macOS 14/15/26 ARM64 的真实双 Space 流程全部通过。修正离屏 AX 首次绑定、异步 Space 动画和原窗口可见性恢复；离屏像素可通过显式 activate_for_observation 受保护采集，默认/桌宠预览不会自动切换。官方 DSH Mac 容器及实体设备验收仍单列。



## 2026-10-13 免费Mac云验证结果

0.3.12候选已利用公开仓库免费标准Mac CI完成两轮测试：macOS 14.8.9/15.7.9 ARM64均编译CU与桌宠，通过原生只读协议及自产AppKit窗口AXPress/原前台窗口恢复集成；normal边框创建、Space无全屏边框也通过运行检查。210项本地检查通过。鼠标恢复目前为原生返回值证据；真实跨Space、实体键鼠100ms时序、桌宠点击/DSH恢复和边框视觉、Neo硬件仍待独立验收。没有取得可长期交互的免费云Mac，当前安装与npm latest仍为0.3.11。

文件构造：macos-validation.yml承载两系统云端矩阵；macos-native-readonly-smoke.mjs检查只读协议；verify-darwin-native-fixture.mjs和macos-ui-fixture.swift构造仅针对自产窗口的集成。archive/20261013-macos-cloud-test保存服务筛选、提交、原生日志及结论。

[报告与证据](archive/20261013-macos-cloud-test/REPORT.md)。

## 2026-10-13 Mac桌宠展开与normal CU边框

0.3.12候选补上Mac原生共享桌宠：Space接管单击展开/收起只读目标窗口预览，双击复用open-chat事件并唤起DSH，原生菜单退出陪伴/打开设置，气泡沿用主主题；没有独立托盘。normal CU以显式mouse_mode:real保留原生输入路径，边框按每个NSScreen渲染、点击穿透、跨Space/全屏显示，并在停止/退出时清理。CU主线程不再阻塞读取stdin。预览只在展开时500ms检查，不更换Agent AX标识，最多保留2张自产临时画面。此前100ms用户优先与操作后恢复约束继续适用。Windows本机安装和公开发布仍为0.3.11；此候选未发布。

文件构造：desktop-pet-darwin.swift承载AppKit桌宠、只读图像预览、菜单、气泡和状态文件；desktop-pet.js按平台编译并复用相同归属/事件协议。darwin.js连接Space租约与展开时观察，darwin-native.swift管理normal多屏边框与异步NDJSON/AppKit循环。verify-darwin-pet-border.mjs验证路由和源码契约；verify-darwin-native-fixture.mjs与scripts/lib/macos-ui-fixture.swift提供仅针对自产窗口的云端原生集成验收。

[本次记录](archive/20261013-macos-pet-border/REPORT.md)。

## 2026-10-13 Space 用户优先输入与恢复

按用户最终选择，macOS CU 采用 Space＋AX，不接入额外账户或VM。Space租约绑定用户预先放入目标Space的现有窗口；不创建Space或使用私有Space ID。Agent输入等到物理键鼠连续空闲至少100ms、且无按键/鼠标按钮保持按下后投递，最多等待5秒，超时不投递旧动作。每个输入保存鼠标位置和原前台AX窗口，成功/失败均尝试恢复；新用户操作优先，恢复失败明确报告，已执行动作不自动重放。后台点击/文本仅使用支持的AX动作；按键/滚动可能短暂激活目标Space再恢复。仍是0.3.12源码候选，Mac编译、100ms硬件时序及焦点/鼠标恢复均未实机验收。Windows安装/公开发布维持0.3.11。

文件构造：darwin-space.js保存Space租约绑定与固定输入策略，darwin.js将实际调用接到该分派；darwin-native.swift新增硬件输入状态轮询、输入检查点、前台精确窗口与鼠标快照/恢复，并覆盖成功及异常。component.js扩展desktop:space参数，非Mac明确拒绝。verify-darwin-space-input.mjs验证实际JS分派与Swift源码约束；本轮archive保存基线、65项检查日志、打包清单及源文件快照。

[本次记录](archive/20261013-macos-space-input/REPORT.md)。

## 2026-10-13 macOS 无障碍辅助候选

已将 macOS CU 源码更新为无障碍 AX 优先：返回有界控件树，使用 AXPress 点击、AXSelectedText 插入选中文本、AXRaise 激活指定窗口；目标标识仅供同调用者和同窗口使用，有效期30秒。无需屏幕录制权限也可观察 AX 结构，像素采集失败时保留 AX 结果。稀疏测量结合控件标题、角色、状态、动作及几何变化，不将随机目标标识当成变化；不读取输入框值，安全字段拒绝编辑。无明确目标且控件不支持语义动作时保留 CoreGraphics 回退，已尝试失败的 AX 动作不重复投递。版本为0.3.12源码候选，尚未在Mac编译或实机验收；本机已安装/发布的0.3.11不变。

文件构造：components/computeruse/lib/darwin-native.swift 增加 AX 访问、唯一窗口匹配、有界树遍历和语义输入；darwin.js 增加语义指纹、调用者隔离的观察缓存与AX目标校验；component.js 描述macOS无障碍调用和已有target_id参数；scripts/verify-darwin-accessibility.mjs 验证调度/测量及Swift源码契约，verify-darwin-native-build.mjs 提供Mac SDK编译门禁，本机明确SKIP。

[本次记录](archive/20261013-macos-accessibility/REPORT.md)。

## 2026-10-13 0.3.11 回复内交互与原生侧栏

0.3.11 已安装并经 heartBeat 重启。生成式 HTML 直接在回复中渲染，支持输入、按钮、展开收起、源码及复制；当前对话和只读历史复用相同实现。文件链接在 NewMate 自己的侧栏挂载 DSH 实时注册的原生组件，未委托本体对话或自写文档预览器；无法支持时通过原生文件管理器定位。NewMate 获得 MemoryLab 新建、增量更新和标签工具，以及 shortMemory_add，仍没有删除许可。259 项相关检查通过，真实模型生成的计数器及原生 Markdown 已实机验证；89 个交付文件源码、包、安装一致。原有 37 条消息均保留，增加 2 条验收消息，陪伴开关保持关闭。0.3.11 已推送 main/v0.3.11 并发布 GitHub Release，CI 成功；官方 npm latest=0.3.11，下载的90个公开文件与发布源码一致。

本轮构造：client.js 的 NewMateInteractive 挂载每条回复的隔离 iframe；NewMateNativeDocument 绑定原生 slot 组件、store、locale 和内容契约。components/newmate/lib/file-navigation.js 在引用授权后读取有界且未变化的原文件字节，index.js 提供 file-content 操作，component.js 限定记忆写入工具。scripts/verify-newmate-generative-ui.mjs、verify-newmate-file-navigation.mjs、verify-newmate-memory-writes.mjs 分别覆盖交互隔离、原生侧栏及真实隔离库写入；本轮 archive 包含生成模型输出、截图、安装包及三方哈希审计。

[本次验收记录](archive/20261013-generative-ui-test/REPORT.md)。

## 2026-10-13 0.3.10 原生兼容与 Mac 原型

0.3.10 已本地安装，并由 heartBeat 完成重启。Agent API 统一接到 DSH 公共模型解析、请求准备和标准流回复解析，兼容能力由供应商适配层提供；同名模型按供应商隔离，未安装或点名外部供应商插件做特殊适配。NewMate 文件链接采用原生侧栏能力优先、文件管理器定位回退，实时发现未来注册类型；无边框、加粗下划线，历史仍只读。桌宠菜单修复启动主题快照缺失、预热及重复加载，原生隔离窗口测得预热后 38 ms 打开。699 项相关检查通过，包含真实 DSH Runtime/BlockAssembler 内存适配器测试和 Windows WebView 集成测试。macOS 原生 CU 与 Virtualization VM 已加入源码原型，但未经过 Mac 编译/硬件验证，guest CU 仍未接通，virtual 请求明确拒绝物理回退。未远端发布。

本轮文件构造：components/agent-api/lib/llm-seam.js 接入原生 prepareCall 与 BlockAssembler；core-model.js/visual.js 复用原生模型元数据与供应商隔离；components/newmate/lib/file-navigation.js 校验引用并调用原生文件定位；client.js 提供实时预览注册表导航、只读历史滚动与窗口内草稿保留。components/computeruse/lib/desktop-menu-client.js 采集 DSH 菜单样式，desktop-menu.html 承载同主题文档，desktop-menu.cs 预热并复用 WebView，desktop-pet.cs 接管菜单启动时序。darwin.js 为 macOS 延迟调度/稀疏测量，darwin-native.swift 为公共 API 原生观察与输入原型，darwin-vm.swift 和 darwin-vm.entitlements.plist 为隔离 Linux VM 启动试验。scripts/verify-dsh-native-model-seam.mjs、verify-newmate-file-navigation.mjs、verify-darwin-prototype.mjs、verify-native-menu-render.mjs 分别验证真实 DSH 模型边界、文件导航、Mac 调度保护和 Windows WebView；scripts/lib/newmate-menu-render-probe.cs 是隔离原生渲染验收窗口。docs/11-native-model-and-macos.md 记录兼容原理、Mac 实现和待验收边界；本轮 archive 保存基线、官方模块摘录、测试日志、各次候选包、最终安装审计及视觉证据。

[本次验收记录](archive/20261013-native-provider-darwin/REPORT.md)。


## 2026-10-12 0.3.9 主动消息内容约束

0.3.9 已本地安装并完成 heartBeat 重启。NewMate 明确区分用户提问与后台触发：主动联系要有具体可信的新内容，自然简短，最多两句、240 字符；没有可核实内容就保持安静，不主动发送能力边界、权限清单或“我不能为你做什么”的无请求说明。发送前拦截常见能力声明与长篇报告格式，不写聊天、不弹气泡、不触发换新或占消息额度；用户明确询问能力时仍如实回答。外部 agent 主动发信使用同一能力声明防线，完整正文和气泡摘要仍分离。

385 项相关检查通过。实际模型处理重启后台任务后 completed / not_actionable，未追加消息，35 条基线消息保持一致；任务物理消费为永久回执。最终源码、包、安装 84/84 文件同哈希。限频、静默、关注保护和记忆缓存保持，未新增模型审核或子组件，未远端发布。
本轮结构：components/newmate/lib/proactive-message.js 统一主动发信风格与内容校验；newmate/component.js 在消息写入和换新之前抑制不合适内容；newmate/lib/mcp.js 向外部 agent 声明气泡投递和主动内容边界；scripts/verify-newmate-proactive-format.mjs 为 21 项行为检查。archive/20261012-newmate-proactive-format/ 保存 before/after、最终包、测试日志和实际后台静默消费证据。

[本次验收记录](archive/20261012-newmate-proactive-format/REPORT.md)。


## 2026-10-12 0.3.8 重启恢复、桌宠配置与气泡投递

0.3.8 已本地安装并由 heartBeat 重启加载。修复原对话冷恢复缺少 `{{model}}`：在提示词装配前恢复该对话的供应商、模型和推理等级，保留运行中选择，禁止混用供应商或退回全局默认模型。重启辅助程序跳过已退出子进程的复用 PID，同时保留主进程身份检查。真实后台冷恢复已完成模型回复，任务物理移除并留下永久消费回执；随后再次更新重启，没有重复投递。

NewMate 取消 Windows 系统通知，仅使用桌宠气泡提醒，完整消息保存在聊天。右键菜单改为“退出伴随”“打开设置”；退出只释放陪伴的桌宠所有权，CU 可继续使用同一桌宠。配置页重构为组件卡片、模型与桌宠配置、插件更新、陪伴偏好四个区域，使用 DSH 的主题变量，独立开关和供应商模型隔离继续保留。

此次相关门禁 401 项通过；最终源码、包、安装 83/83 文件同哈希。真实重启与配置页截图已留痕，原生菜单动作经过独立窗口测试，工具限制下未完成用户桌宠的物理右键手势验收。未新增子组件，未远端发布。
本轮结构：lib/conversation-delivery.js 负责冷恢复模型上下文，components/heartbeat/component.js 登记模型与消费回执，lib/core-restart.ps1 实施进程身份约束；components/newmate/{component,index}.js 固定气泡投递并处理退出伴随；computeruse/lib/{desktop-pet.js,desktop-pet.cs,desktop-menu.html,desktop-menu-client.js,desktop-menu-theme.js} 负责两项菜单及主题桥接；client.js 提供配置布局和设置导航。scripts/verify-heartbeat-model-context.mjs、verify-restart-identity.ps1、verify-newmate-menu.mjs 与 scripts/lib/newmate-menu-probe.cs 是新增门禁。archive/20261012-heartbeat-model-context/ 保留 before、after、最终包、日志、实机截图和报告。

[本次验收记录](archive/20261012-heartbeat-model-context/REPORT.md)。


## 2026-10-12 0.3.7 NewMate 实时引导与关注保护

0.3.7 已本地安装：NewMate 用户输入直接加入当前运行的 steer guide，不再为每次补充另建排队轮次；界面运行中显示“引导”，补充要求在模型/工具边界生效，旧工具调用被配对为未执行结果，旧回答不会作为最终回复发出。用户打断自动 JSON 判断时复用同一持久任务转为普通回复；显式换新对话的输入会中断旧运行，用户任务优先于后台投递。

自动换新基于可观察的关注状态：正在阅读、近期输入/关注、已有草稿及用户任务保护当前对话。话题变化且至少八小时未互动，或一天以上且连续两次未回应时，在主动消息确实被允许发送前考虑换新；每天最多自动换新一次，旧对话只读保留，不清零预算、冷却或未回应退避。多窗口草稿具有所属窗口与事件序号，其他窗口和旧事件不能清除保护。用户消息上方只保留时间，删除两个“你”；NewMate 回复头像、名称、时间和格式保持不变。

实时引导/关注/换新 23/23、Agent API 268/268、客户端 123/123、低打扰激活 57/57、shortMemory/MCP 37/37、聊天 21/21、供应商隔离 18/18、版本 12/12，共 559 项通过。真实模型验证第二次输入 mode=steer，与第一次共用任务 ID，最终只回复“引导已收到”；实机截图确认用户气泡只显示时间，NewMate 标签完整。最终源码/包/安装 83/83 同哈希，25 条基线消息保留。heartBeat 重启 running，更新后任务已消费为永久回执。未新增子组件，未远端发布。

本轮结构：components/newmate/lib/thread-handoff.js 为无模型成本的关注保护及换新判定；newmate/component.js 管理同一运行的引导缓冲、用户优先、持久草稿和换新记录；agent-api/component.js 通过原生 AsyncLocalStorage 上下文传入 pollSteer/hasSteer，lib/loop.js 在模型及串行工具边界消费引导；newmate/index.js 提供 interaction 和 attention 路由；client.js 显示引导入口并上报草稿，同时简化用户消息元数据。scripts/verify-newmate-steer-handoff.mjs 为 23 项并发/换新行为门禁。archive/20261012-newmate-steer-handoff/{before,after,package-expanded} 分别存放基线、最终文件和 tarball 展开物；real-steer-*.json/mjs 为真实模型证据，installed-steering.jpg 为实机气泡证据。

[实现与实机证据](archive/20261012-newmate-steer-handoff/REPORT.md)。


## 2026-10-12 0.3.6 NewMate 唤起、气泡与回复预览

2026-10-12 用户实机确认：关闭 DSH 主窗口、保留后台运行后，双击桌宠可以恢复主窗口并进入 NewMate。此项验收通过；原生消息气泡点击仍待确认。下文待确认措辞为反馈前的历史记录。

0.3.6 本地更新：发送按钮保持正常右对齐；桌宠显式清除 Electron-as-Node 启动变量，通过已验证的 DSH 单实例入口唤起隐藏主窗口，并请求进入当前 NewMate。气泡跟随主设置的浅色/深色/系统外观，展示最多 80 字的独立摘要；完整正文保存在聊天页，MCP newmate_message 可传 summary。NewMate 回复约束为亲近务实的私人秘书，真实文件链接在回复内可点击，只读打开已引用的文本文件（2 MB 上限）。自包含 HTML 回复以卡片打开独立面板，支持展开、页面/源码切换和复制；iframe 采用不带同源能力的脚本沙箱及受限资源策略。未新增子组件、未远端发布。

客户端 123/123、版本 12/12、聊天 21/21、shortMemory/MCP 37/37、低打扰激活 57/57、呈现行为 8/8、原生共享桌宠 19/19，共 277 项通过；另有两条实机 HTTP 文件边界拒绝测试。实机验证 HTML 按钮计数 0→1、展开面板、文件预览及主设置浅色切换后原生 bubble_dark=false，已恢复原来的跟随系统外观。物理桌宠双击和原生气泡点击尚待用户确认，电脑控制工具拒绝对其他原生窗口的点击；不将页面测试计为这两项验收。

本轮文件结构：components/newmate/lib/presentation.js 为纯摘要与引用解析；component.js 为秘书回复约束和独立 summary；index.js 为主题桥及有引用约束的只读文件预览；lib/mcp.js 为可选摘要入参；client.js 为内联文件链接、HTML 回复卡片和独立预览面板；computeruse/lib/desktop-pet.js/.cs 为摘要传递、原生主题与单实例唤起。scripts/verify-newmate-presentation.mjs 与 verify-shared-companion-pet.mjs 验证呈现及原生状态。archive/20261012-newmate-bubble-preview/{before,after,package-expanded} 分别保存基线、最终文件和安装包展开物；LOG/JSON 为门禁/状态/哈希，JPG 为实机证据。

[实现与实机证据](archive/20261012-newmate-bubble-preview/REPORT.md)。


最终包与安装 82/82 同哈希，23 条基线消息保持完整；heartBeat 终态 running，更新后任务已完成并真实消费为永久回执。

## 2026-10-12 0.3.5 NewMate 发送按钮对齐

已本地安装 0.3.5：移除 client.js 中按桌宠运行状态固定添加的发送按钮右外边距，陪伴开启和关闭沿用同一输入框行布局。客户端 123/123、版本约束 12/12；源码/包/安装 81/81 一致，实机截图确认陪伴开启时发送按钮位于输入框右侧。未新增子组件，未远端发布。

[修复与实机证据](archive/20261012-newmate-send-alignment/REPORT.md)。


## 2026-10-12 0.3.4 NewMate 低打扰自主激活

已实现并本地安装 0.3.4：NewMate 不再依赖用户先开口、文件变化或外部任务才工作。开启陪伴后约 20 分钟进入自主检查；默认适中频率，每天最多 4 次自动模型判断、2 条自主消息，未回应后间隔从 4 小时逐步退避至 8/16/24 小时。夜间 23:00–08:00（北京时间）、正在输入、阅读聊天、DSH/后台任务或 CU 忙碌、锁定/安全桌面、离开设备 90 分钟时延后。读过主动消息也算回应兴趣，不要求打字。文件事件先合并，长期记忆正文的元数据变化、标签/短记忆变化与低频空闲检查共用预算；没有必要内容时不发消息。第一整天没有主动内容时允许一条不调用模型的轻量问候，后续同类兜底至少间隔三天。自主消息不抢焦点，首次系统提醒静音，持续未回应后只保留气泡/未读；外部 agent 连发保留全部内容但 30 分钟内只打扰一次。配置页新增主动开关、安静/适中/活跃频率、静默时段和暂停八小时。未新增子组件，patch +1；未远端发布。

主动激活 57/57、原生共享桌宠 16/16、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、Agent API 268/268、供应商隔离 18/18、版本 12/12；最终源码/包/安装 81/81 一致，原有 19 条消息保持完整。七天无用户主动输入的模拟共 8 次模型检查、8 条消息、首次 1 条系统通知。长周期以模拟时间及确定性模型结果验证；实机验证设置、暂停/恢复和原生可用性，未把模拟结果冒称真实七天运行或实际费用。实际定时模型已复验通过：本次没有合适内容保持静默，预算只加一次，旧失败任务未重放。

本轮结构：components/newmate/lib/initiative.js 为新增纯策略模块，定义本地日期、频率/预算、静默、退避和话题去重；component.js 接入持久预算、独立唤醒、合并信号与本地问候，index.js 从宿主 agents/jobs 和共享桌宠获取粗粒度可用性并返回策略状态；client.js 为主动陪伴配置与静音通知；computeruse/lib/desktop-pet.cs 增加只读输入空闲/当前桌面信息，desktop-pet.js 增加同一进程的短时状态缓存和静音传递。scripts/verify-newmate-initiative.mjs 包含 57 项行为测试与七天模拟；verify-newmark-core.mjs 接入该门禁。archive/20261012-newmate-initiative/before/ 为基线，after/ 为最终源码与六份治理文档，package-expanded/ 为最终 tarball；LOG/JSON 为测试、安装、模拟和策略状态，JPG/TXT 为实机配置证据，manifest.json 为哈希。

[策略与验收证据](archive/20261012-newmate-initiative/REPORT.md)。


## 2026-10-12 0.3.3 NewMate 打开链路与界面细节

实机闭环：用户已确认在其他应用前台时，双击桌宠可以正常恢复 dsh 并打开 NewMate 当前聊天（2026-10-12）。下文的待反馈措辞属于确认前记录。

0.3.3 已本地安装：桌宠打开聊天时先恢复并激活已验证的 dsh 主窗口，保留单实例启动兜底；新增双击松键判定与重复事件抑制，单击/拖动不会误打开。打开事件优先处理，恢复焦点时立即检查，缺少布局服务时保留重试；已在历史或设置页时切回当前聊天并聚焦输入框。侧栏头像降低亮度并以更克制的比例向右显示；NewMate 标题、欢迎文案、快捷按钮、历史行、输入框细节和设置页陪伴开关几何已完善。历史仍为按钮进入的只读记录，CU 仍独占闪边，NewMate 无独立托盘。未新增组件，patch +1，未远端发布。

原生点击处理 6/6、共享桌宠 15/15、客户端 123/123、聊天 21/21、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、版本 12/12；最终包 80/80 文件与源码和安装一致。已实机检查界面与历史/设置到聊天的导航。真实鼠标双击因无激活工具窗口不能被电脑控制工具直接定位，等待用户反馈；不把事件单测或显式 IPC 夹具声称为物理双击验证。

本轮文件构造：client.js 负责头像、聊天细节和打开事件优先级/视图复位；components/computeruse/lib/desktop-pet.cs 负责双击识别、去重与已验证宿主窗口恢复；六份 package.json 与 newmate/lib/mcp.js 统一 0.3.3。archive/20261012-newmate-polish/before/ 保留治理/源代码基线，after/ 保留最终治理与包内源文件，package-expanded/ 保留最终 tarball 内容；NativeClickUnit.cs/.exe 与 native-click.log 是无真实鼠标注入的原生回归，navigation-fixture.mjs 和 *ipc-fixture.json 是显式标记的实机 IPC 夹具；JPG/TXT 是 UI 证据，installed-integrity.json 与 manifest.json 是安装与归档哈希。

[本轮验收记录](archive/20261012-newmate-polish/REPORT.md)。


## 2026-10-12 0.3.2 NewMate 页面与陪伴体验

已实现并本地安装 0.3.2：NewMate 提供常驻输入框、独立只读历史入口、新对话、设置和陪伴开关。历史不常驻，不允许编辑、重新激活、继续发送或重试历史任务；新对话关闭上一段记录，旧消息完整保留。侧栏共用桌宠图片，横向翻转朝向右侧，先放大 20% 后按反馈缩小 10%（最终为原尺寸 108%）。陪伴与 CU 共享一个桌宠，CU 单独决定闪边。NewMate 内核由 dsh Cordis 托管，原生辅助窗口只负责呈现并随宿主结束；无独立托盘，系统通知由现有 dsh 窗口承载。焦点不在 NewMate 聊天页时主动消息显示桌宠气泡，返回页面后收起。未新增子组件，patch +1，未远端发布。

专项通过：聊天 21/21、客户端 123/123、共享桌宠原生 15/15、陪伴/heartBeat 57/57、shortMemory/MCP 37/37、供应商隔离 18/18、Agent API 268/268、版本 12/12；最终源码/包/安装 80/80 字节一致。实机查看正常聊天、按钮进入历史与无输入框的只读阅读、右向图标、后台气泡和前台抑制。双击的原生事件单测与实际 IPC 导航通过；自动化工具不能直接定位无激活桌宠窗口，未声称完成真实鼠标双击。系统通知调用归属 dsh，不声称观察到 Windows 通知中心弹窗。旧总门禁的两个宿主/源码前提失败不归入本轮专项通过。

本轮构造：packages/newmark-core/client.js 负责当前聊天、只读历史和宿主通知；components/newmate/component.js 负责线程持久化、当前线程写入边界与陪伴策略，index.js 负责 Cordis 生命周期和 HTTP 路由，lib/mcp.js 暴露四个 MCP 工具；components/computeruse/lib/desktop-pet.js 负责共享所有权、声明状态和一次性通知领取，desktop-pet.cs 负责前台核验、气泡与呈现。scripts/verify-newmate-chat.mjs 和 verify-shared-companion-pet.mjs 为新增行为专项；archive/20261012-newmate-ui/ 中 before/ 保存基线，after/ 保存最终源码与治理文件，host/ 为已安装官方宿主接口的只读取证，package-expanded/ 为最终包，日志/JSON/JPG/TXT 为测试、协议和实机证据，manifest.json 为哈希清单。

[本轮验收与证据](archive/20261012-newmate-ui/REPORT.md)。


## 2026-10-12 0.3.1 供应商同名模型隔离

已修复并安装 0.3.1：Agent API 可用性与视觉能力以供应商和模型 ID 同时匹配，核心目录拒绝将外部供应商模型重标为自身；每次 run 固定原始供应商、模型与 reasoningEffort，后续切换不改变重试和后续轮次。记忆缓存仅复用模型无关的背景文本，不共享供应商能力或凭据。未新增组件，patch +1，未远端发布。

隔离专项 18/18、Agent API 268/268、客户端 123/123、陪伴 57/57、版本 12/12；已安装 80/80 文件与源码和 tarball 一致。真实同名 deepseek-flash 的两个供应商 profile 隔离，MCP 0.3.1 与 NewMate QA031_OK 回复通过，原准用模型已恢复。总门禁 195/197，帧循环源码断言及旧 CLI 宿主前提未通过，详见报告。[验收报告](archive/20261012-provider-isolation/REPORT.md)。

本轮修改 core/lib/model-selection.js（目录隔离）、agent-api/lib/core-model.js（准用校验）、visual.js（图像能力）、llm-seam.js（run 选择快照）；scripts/verify-provider-isolation.mjs 验证同名、目录污染、切换及重试。archive/20261012-provider-isolation/ 保存 before 基线、日志、包展开、三方哈希、重启、真实模型身份与 MCP 回执。


## 2026-10-12 0.3.0 本地安装与实机验收

Windows DSH 已安装 0.3.0，80/80 包内文件与最终 tarball 和源码一致。实机验证 NewMate 侧栏/对话、DSH 与外部 MCP 调用、shortMemory 七天到期与灰显、两个独立开关、真实视觉识别，以及两次 heartBeat 全局重启：第一次自动投递后任务载荷移除，第二次不重复投递。实机修复冷启动入口缺失和 opencode-go 缺传输 sessionId，并补齐完整短记忆日期与输入框样式。准用模型恢复原 DeepSeek，桌宠倍率保持 60.1%。未发布远端。

[安装与实机证据](archive/20261012-installed-030/REPORT.md)。下文的“源码候选/未安装”是先前阶段记录；当前状态以本节为准。旧 CLI 完整 ToolRuntime 导入门禁仍未闭环，实际宿主路径已另行验收。

本轮新增 archive/20261012-installed-030/：before/ 保存 profile 与六份治理基线；安装日志和 installed-integrity.json 保存三方字节一致性；PNG/TXT 保存真实窗口与可访问性；MCP JSON、两个 restart status 和 consumed JSON 保存协议与一次性投递；vision-fixture.png 及 validation JSON 保存非个人图样真值；REPORT.md 汇总边界，manifest.json 记录哈希。运行修改位于 client.js（启动状态、样式、日期）、agent-api/component.js（每 run correlation）与 lib/llm-seam.js（宿主传输参数），对应 client/companion 验证脚本补回归。

## 2026-10-11 0.3.0 新组件实现（源码候选）

已接入 NewMate 陪伴内核与 heartBeat 重启投递，五子组件独立开关；Agent API 支持真实图像附件；MemoryLab 增加 shortMemory（默认七天）及“总览/详细/短期”。NewMate 在首轮推理前原生注入全部标签关系和最近十条短期记忆，并开放 DSH/MCP 共用接口；无文件删除工具，文件测量默认关闭、变动去重且低打扰。heartBeat 成功投递后移除可执行任务，保留无正文收据。

本轮为源码实现与本地候选打包，尚未发布或覆盖本地安装。[验收记录](archive/20261011-newmate-heartbeat/REPORT.md)。[实现和接口](docs/09-newmate-heartbeat-implementation.md) · [OpenDot 参考边界](docs/10-opendot-reference.md)。下文的“仅设计”是先前预研记录，当前实现状态以本节与本次验收报告为准。

新增文件树及职责：

```text
packages/newmark-core/
  components/newmate/
    index.js               注册工具、HTTP/MCP、监听器及后台生命周期
    component.js           陪伴持久队列、源对话唤起与文件元数据测量
    package.json           子组件版本与模块入口
    lib/memory-context.js  全标签关系和短记忆原生前缀、内容指纹缓存
    lib/mcp.js             共用工具定义、MCP JSON-RPC 和 HTTP 鉴权
  components/heartbeat/
    index.js               当前对话重启工具与后台生命周期
    component.js           任务登记、重启确认、持久投递和消费收据
    package.json           子组件版本与模块入口
  components/memorylab/lib/short-memory.js  七天短记忆列表与四工具
  components/agent-api/lib/visual.js       附件入库、捕获路径约束、BMP 转 PNG
  lib/durable-state.js          原子 JSON 写入与重载读取
  lib/conversation-delivery.js  当前身份、真实 followup、去重和 flush
  lib/newmate-context.js        仅陪伴调用的原生记忆上下文
scripts/
  verify-newmate-heartbeat.mjs  视觉、重启投递、消费和组件开关行为验证
  verify-short-memory-mcp.mjs   短期记忆、原生缓存、唤起和真实 HTTP MCP 验证
docs/09-newmate-heartbeat-implementation.md  已实现契约、配置及验收边界
docs/10-opendot-reference.md               提交固定的源码参考与采用范围
archive/20261011-newmate-heartbeat/         执行前源码、参考冷数据、测试日志、候选包、报告及哈希
```

既有 index.js/core 更新流程、client.js 页面/组件开关、memorylab/index.js 短期列表路由、memorylab/component.js 工具合并、agent-api/index.js 服务注入、agent-api/component.js 视觉及记忆前缀、发布文件检查和现有测试门禁按上述契约扩展。每个新增文件的详细构造见实现文档。

## 2026-10-11 newMate 新组件设计研究

目标：以现有 Agent API 为推理入口，设计可持续记忆、责任驱动、适度主动的陪伴内核。当前只完成设计；源码基线 package.json 为0.2.39，未重新验证安装/发布状态。拟议第四组件目录尚未建立，现有CU桌宠不等于陪伴内核。

本轮新增文件树与职责：

```text
Newmark2DSH/
  docs/
    07-newmate-companion-research.md  产品身份、官方来源、实现机制和本地源码边界
    08-newmate-kernel-design.md      内核模块、测量理论、状态机、API、权限、数据与验收
  archive/20261011-newmate-kernel-research/
    before/                         六份治理文档的执行前快照
    after/                          六份治理文档及两份新设计文档的执行后快照
    source-baseline.json            五个运行源码/元数据文件的SHA256基线
    source-verification.json        同五个文件执行后哈希与未变断言
    documentation-checks.json       文档存在、相对链接、提案标识和改动边界检查
    manifest.json                  本轮维护文件的大小与哈希
    REPORT.md                      工作范围、来源、结论、验证与限制
```

docs/的完整新文件索引见上；既有源码目录结构沿用原文件树。[调研](docs/07-newmate-companion-research.md)区分官方披露、源码核查与提案；[设计](docs/08-newmate-kernel-design.md)包含未来组件每个拟议子文件的职责。archive/仅保存本轮冷记录，未保存用户屏幕、Provider密钥或竞品账户数据。

## 2026-10-08 最终安装：0.2.31

NewMate 显示同步优化及 Linux X11/WSLg 支持已接入并发布。最终远端提交 c7b7165 / v0.2.31 经全新网络克隆拉回，Windows 和 WSL 分别重装同一 tarball；Windows DSH 已完全退出旧进程并重新启动，三个组件均由新宿主激活。65/65 发布文件一致，64 运行文件匹配源码；用户当前倍率 60.1% 保持不变。

0.2.31 另将窗口映射控制心跳与显示绘制分离，解决显示时钟停止时控制也停止的问题，避免 WM_TIMER 在高刷新绘制下饥饿。最终安装态：核心195/195、Windows原生专项102/102、CU边界34/34、方言45/45、隐藏路由54/54、Linux后端47/47与Qt15/15、真实模型33/33，以及配置slider门禁通过。实装桌宠约151绘制回调/秒，WSLg稳定预览约60交换回调/秒；不等同物理扫描帧率。测试映射、接管槽和辅助进程已清空。

npm索引当时仍返回404，当前明确安装远端拉回的tarball；不声称从注册表解析安装。首轮失败、后续修正、真实输入范围和完整文件树均见 [最终验收报告](archive/20261008-release-031/REPORT.md)。


## 2026-10-08 Linux / WSL 本地候选

ComputerUse Linux 入口新增 `lib/linux-desktop.js`（Node 协议及生命周期）、`lib/linux-desktop.py`（Qt 界面、认证 Xvfb、XComposite/SaveSet 映射、UID flock）、`lib/linux-process-guard.py`（私有服务器管道看护），原 `linux.js` 保留真实输入和观测后端并串行整合槽位校验。包清单包含 Python 辅助文件。组件继续绑定真实 DSH session。

`scripts/verify-linux-desktop.mjs` 为源码／安装包双用集成门禁；`scripts/lib/linux-desktop-fixture.py` 是仅由测试显式启动的应用；`scripts/verify-linux-newmate.py` 为 Qt 合成事件、渲染和认证门禁。`docs/06-linux-desktop.md` 描述调研、来源、部署与限制。`archive/20261008-linux-wsl/` 保存 before、各轮回执、失败诊断、source-final、installed-final、ui、tarball 和哈希校验，详细子文件作用见该目录 REPORT.md。

源码／安装候选各 47/47，UI/认证 12/12，64/64 发布文件一致。当前只验证 X11/WSLg；未发布，未替换 Windows DSH。完整 CSS 菜单与进程覆盖动画尚未移植，不能把核心桌面验证等同于全部视觉功能完成。

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

## 2026-10-08 桌面迁移与全 DSH 接管互斥（开发中，未发布）

真实/虚拟模式各一个跨 DSH 进程的 Windows 用户级接管槽已在本地实现；调用身份绑定 DSH 会话，停止一个模式保留另一个模式。该阶段最初安装 0.2.26；最终 0.2.28 的发布与验收见上方。实现背景：Win32 不支持保留现有窗口直接迁移所属线程，已用独立原生夹具复现 error 170，用户已于 2026-10-08 接受保留进程的交互映射语义，现已实现双向映射、NewMate 飞入飞出、退出保活与恢复，已执行完整回归，前台自动化限制见本轮报告。 新增 computeruse/lib/takeover-lock.cs 管理系统互斥体，takeover-lock.js 编译/管理锁进程；lib/cu-caller.js 保留异步会话身份。scripts/verify-takeover-lock.mjs、verify-takeover-slots.mjs、verify-takeover-session.mjs 分别验证内核锁、后端双槽和宿主身份。archive/20261007-cu-transfer 中 before 是备份、evidence 是日志回执、gpu-regression 是隔离原生回归；PLAN/STATUS 记录待决事项，DesktopTransferProbe.cs 是系统限制实测。 [工作状态](archive/20261007-cu-transfer/STATUS.md)。

## 2026-10-07 NewMate 分级配置与 GPU 动画（0.2.26，已发布并重装）

配置板块按「智能体 / 准用模型」和「桌面助手 / NewMate」分级，使用响应式卡片、说明及保存提示。桌宠复用绘制缓冲，虚拟桌面预览以 GPU 变换展开/收起并复用就绪渲染器。本机隔离动画基准：桌宠约 35→55 FPS、展开 4→56 FPS、收起 30→60 FPS；不代表源桌面采集帧率或恒定硬件刷新率。

0.2.26 已推送（ab40ba6d / v0.2.26）并发布 npm，经远端拉回、注册表精确版本重装、完整重启 DSH。57 个发布文件与远端一致、56 个运行文件与源码一致。插件全工具门禁 25/25、ComputerUse 34/34、真实模型 33/33、原生 GPU 12/12、偏好启动 5/5；范围与初次夹具失败见报告。实际配置滑杆 65→65.1→65 与桌宠同步，用户大小保留 65%。

[验收与发布记录](archive/20261007-newmate-smooth-release/REPORT.md)。

实现结构：client.js 管理配置卡片；desktop-pet.cs 内 PetFrameClock 调度、PetSurface 复用位图、DesktopViewer 管理只读 GPU 预览与缓存；desktop-pet.js 清理临时 viewer.html。新增 scripts/verify-desktop-pet-gpu.mjs 编译生产代码并运行隐藏桌面集成，scripts/lib/desktop-pet-gpu-probe.cs 检查动画/偏好/清理。工具回归脚本支持指定已安装包并规范 pnpm 实路径。archive/20261007-newmate-smooth-release 下 before 为备份、bench 为阶段性能数据、gpu-* 为真实隐藏桌面回执、candidate 为包、release-repo/retrieved-repo 为独立发布及拉回仓、各 installed 测试目录为隔离数据、evidence 为安装与实机证据；逐目录用途见报告。

## 2026-10-07 NewMate 配置与 DSH 主题菜单（0.2.25，本地已安装）

插件页面分为「组件」与「配置」两大板块，准用模型归入配置。配置页和 NewMate 右键菜单共用 30%–300% 连续滑杆（0.1 个百分点精度）、实时双向同步并记住最后大小。默认倍率仍为 100%，本体基准宽度从 160 缩至 120（原尺寸的 75%）；旧版保存值按版本换算以保留实际大小。

右键菜单渲染 DSH 实际 Menu DOM 与有序 CSS，支持主题与插件覆盖；按 WebView 实际 DPI 定尺寸，并在桌宠旁展开，修复 200% 缩放下菜单裁切。候选包已重新安装并完整重启 DSH；本次 0.2.25 尚未发布至 npm，公开版本仍为 0.2.24。

[验收与安装记录](archive/20261007-newmate-dsh-menu-css/REPORT.md)。

新增文件：`lib/newmate-settings.js` 管理版本化倍率读写与旧偏好换算；ComputerUse 的 `desktop-menu-theme.js` 接收经校验的同源样式快照，`desktop-menu-client.js` 捕获真实 DSH 菜单与 CSS，`desktop-menu.html` 承担滑杆交互，`desktop-menu.cs` 管理 WebView2 窗口/DPI/定位。`vendor/webview2/` 保存固定版本 SDK DLL、许可证与来源哈希。`scripts/verify-newmate-settings.mjs` 验证配置读写与迁移，`scripts/lib/desktop-pet-menu-probe.cs` 用生产原生类验证菜单。归档目录 `before/` 为修改前材料，`dependencies/` 为 SDK 来源，`candidate/` 为本地安装包，`native-probe/` 为窗口夹具与配置，`native-preferences/` 为隔离启动测试，`evidence/` 为日志、哈希与画面，`REPORT.md` 为结果和局限。

## 2026-10-07 正式发布、拉回重装与完整重启

0.2.24 已推送至公开仓库（515482f / v0.2.24），经 GitHub OIDC 发布到 npm，再从注册表下载并以精确版本重装。46 个发布文件与发布仓一致，其中 45 个运行文件与此前实机验收版本逐字节相同。DSH 已完整退出并重启，旧主进程及宿主退出、新宿主重新加载；当前 profile 依赖为注册表 0.2.24，不再引用本地候选 tgz。 [发布记录](archive/20261007-newmate-release-0.2.24/REPORT.md)。

新增归档 `20261007-newmate-release-0.2.24/`：before/ 保存安装前配置及文档，release-repo/ 是独立发布仓，download/ 保存拉回 tarball 与解包，evidence/ 保存 CI/注册表/文件哈希/安装门禁/进程重启与 UI 证据，after/ 保存最终文档；verify-retrieved.mjs 逐文件核对，complete-docs.mjs 在安装与重启门禁通过后更新文档，REPORT.md 说明各项作用和边界。

## 2026-10-07 虚拟桌面桌宠与动效，0.2.24 已发布

吉祥物正式名称为 **NewMate**；桌宠窗口、右键菜单与预览提示统一使用此名称。

安装状态：本机 DSH 2.0.17 已加载 0.2.24，全部组件启用；实际五次 ComputerUse 调用完成启动/状态/停止检查，测试租约已释放。45 个包文件与源码/隔离安装一致。归档中的 `installed-before/` 为回退材料，`candidate/newmark2dsh-0.2.24.tgz` 为历史候选包，已由注册表依赖替代，`evidence/dsh-*` 为原始工具回执和 UI 证据。

目标：用用户提供的透明图片替换 Windows 虚拟模式的全屏边框提示，并提供同屏全屏只读预览。真实模式边框、隐藏桌面动作路由和工具参数保持兼容。旧文档将所有模式统一描述为屏幕边框；虚拟模式以本节及当前代码为准。

新增/修改的文件结构与职责（`cu` 指 `packages/newmark-core/components/computeruse`）：

| 路径 | 构造与作用 |
|---|---|
| `cu/assets/desktop-pet.png` | 用户原始透明 PNG，原样随 npm 包提供；运行时裁去透明留白 |
| `cu/lib/desktop-pet.cs` | 原生 WinForms 桌宠、alpha 轮廓描边、弹性出场/点击/退场、拖动、右键倍率菜单及原子持久化、可反向缩放的同屏只读预览、独立截图进程及宿主身份 watchdog |
| `cu/lib/desktop-pet.js` | 按源码哈希编译缓存、解析共用用户根目录下的倍率文件位置、进程启动/取消/退出清理、状态与模式契约 |
| `cu/component.js` | 将宿主解析的用户根目录传入后端；倍率不增加模型工具参数 |
| `cu/lib/win32.js` | 租约按鼠标模式选择边框或桌宠；先停止预览截图再审计隐藏桌面释放 |
| `packages/newmark-core/package.json` 与三组件 manifest | 统一候选版本 0.2.24；包清单包含 `.cs` 与 PNG |
| `scripts/verify-desktop-pet.mjs` | 生产隐藏租约、物理输入、像素截图、捕获崩溃恢复和停止释放；可指定实际解包后的包路径 |
| `scripts/verify-desktop-pet-lifecycle.mjs` | 取消启动、多宿主描边同步、宿主死亡及子进程清理 |
| `scripts/verify-desktop-pet-motion.mjs` | 可指定实际 npm 安装包，创建生产隐藏租约并启动独立原生动效录制器；测试用户根目录隔离 |
| `scripts/verify-desktop-pet-preferences.mjs` | 通过生产后端验证显式用户根目录优先级、环境根目录恢复、损坏/越界偏好的默认值回退 |
| `scripts/verify-desktop-pet-render.mjs` | **屏幕合成层**渲染验收：PrintWindow 摘要只作证据不作判据；判据是 BitBlt 宠物矩形连拍不得出现整块单色/整块白黑翻转、透明留白必须随背景变化，并把观测到的故障（不透明纯白 ULW 表面）注入宠物自己的 hwnd，要求在有界时间内自愈 |
| `scripts/lib/desktop-pet-motion-probe.cs` | 真实菜单/鼠标输入、独立线程截图和原生状态采样，检查动效、快速反向、大小边界及新进程恢复倍率 |
| `scripts/lib/desktop-pet-probe.cs` | 隔离窗口夹具，以应用自己写出的点击/按键计数验证输入隔离 |
| `scripts/lib/desktop-pet-driver.ps1` | 仅向已确认未遮挡的测试窗口发送物理输入，读取原生窗口事实并截图 |
| `scripts/lib/desktop-pet-owner.mjs` | 可被结束的独立测试宿主 |
| `scripts/lib/desktop-pet-pixels.ps1` | 两张实机图像的灰度动画像素与本体稳定性比较 |
| `scripts/lib/desktop-pet-render-probe.ps1` | DPI 感知的合成层采样与故障注入：BitBlt 宠物矩形、逐帧灰度统计、PrintWindow 摘要，以及对目标 hwnd 注入不透明纯白 DIB 并测量自愈时延 |
| `archive/20261007-virtual-desktop-pet/` | `before/`、`after/` 快照；`evidence/` 历轮结果与截图；候选包和隔离安装；计划与验收记录 |
| `archive/20261007-pet-motion/` | 本轮动效与倍率持久化的前后快照、计划、原始检查、真实截图动图、候选包与验收报告 |
| `<resolved user root>/computer-use/desktop-pet.json` | 运行时用户偏好：版本、最后选择的倍率、更新时间；首次显示前读取，菜单选择后原子替换 |

已完成实现与原生编译；最终结果以该归档 `REPORT.md` 为准。当前正式发布与重装完成。单屏 2560×1600 / 200% DPI 为本机实测环境，多显示器位置计算已实现但未在多屏硬件上验收。PrintWindow 对 GPU 专有或受保护窗口的显示能力沿用 Windows 限制。

The whole-workspace state: what this sub-workspace is, what every folder is for,
what every file contains and does, and where the work stands.

## 1. What this is and why it exists

Newmark Agent is a Windows Electron agent product. DeepSeek Harness (DSH) is a
different runtime with a different plugin model: a Host half in the Node process
and a Client half in the browser page, wired through Cordis slots and services.
This sub-workspace exists to carry two Newmark features across that boundary as
first-class DSH plugins, without dragging the retired research line along and
without pretending the two runtimes are the same.

The user's brief, verbatim:

1. `Newmark-MemoryLab` — 移植 Newmark 的 MemoryLab，插件要在左侧栏有正确完整的
   入口与呈现窗口。
2. `Newmark-ComputerUse` — 移植 Newmark 现有的 ComputerUse，包含所有模式和接管窗口
   特效，且不包含 CULab 已废弃的实验性功能。

Two follow-up corrections, both decisive:

3. ComputerUse 是内置隐式插件，不需要出现在侧边栏。
4. MemoryLab 侧边栏点进去要是**正确的渲染呈现**，不是插件介绍。

## 2. Goals and acceptance criteria

| Goal | Acceptance |
|---|---|
| MemoryLab is a sidebar destination | `sidebar.panellist` carries the id `memory-lab` and `main` carries the same key, both live; clicking it renders the Memory Lab itself |
| MemoryLab renders the real thing | the panel shows the overview graph, the detail tag graph with component preview, tag/component search, reset and reindex, all served from ONE visualization snapshot with a generation token |
| MemoryLab keeps the durable contract | bounded query (64000-char per-component scan cap, 1000–48000-char budget, 1–12 results, 35% adaptive early stop), `expectedUpdatedAt` stale-write rejection, archive-before-mutation, append-only `policy.jsonl`, one normaliser, verified rebuild receipts |
| ComputerUse has no sidebar presence | no `sidebar.panellist` and no `main` registration from `@local/newmark-computeruse` |
| ComputerUse carries every mode | all four axes — `mouse(real|virtual) × observation(sparse|full) × lane(7) × lease(takeover_start|takeover_stop)` — plus the action surface |
| ComputerUse shows the takeover effect | the frame-wide `shell.overlay` stroke, reproduced with the frozen Newmark token values, live only while the lease is held |
| The retired line is absent | a machine-checked assertion that neither plugin's source references CULab / NES-T / NMEP / ONNX / NPU |
| The sub-workspace is self-governing | `README.md`, `OVERVIEW.md`, `taste.md`, `docs/00-governance.md` and `archive/` all current |

## 3. File tree

Legend: **[H]** host half, **[C]** client half, **[D]** document, **[G]** gate.

```
Newmark2DSH/
├── README.md                                   [D] outward description, quick start, status
├── OVERVIEW.md                                 [D] this file
├── taste.md                                    [D] the port's code/behaviour/evidence style
├── docs/
│   ├── 00-governance.md                        [D] the parent rulebook, extracted with citations
│   ├── 01-dsh-plugin-contract.md               [D] the verified DSH contract the port is built on
│   ├── 02-tool-output-boundary.md              [D] the lossless-JSON boundary every tool return must survive
│   ├── 03-computer-use-playbook.md             [D] how to drive this desktop, and the habits each rule was measured from
│   ├── 04-agent-run-settling.md                [D] what the model receives on a tool failure, and how a run settles
│   ├── 05-acceptance-0.2.12.md                 [D] the per-function acceptance record, and the store's net effect
│   ├── 06-linux-desktop.md … 13-handoff-*.md    [D] the Linux path, the companion research/design, the native model boundary, the handoff
│   └── 14-cu-sweep.md                          [D] relative mouse motion: the contract, its refusals, its measured boundaries
├── packages/
│   ├── newmark-memorylab/                      the MemoryLab bundle
│   │   ├── package.json                        bundle manifest: `dsh.bundle.patch` + `dsh.client`
│   │   ├── cordis.patch.yml                    inserts the one Host row
│   │   ├── index.js                            [H] store + nine memory_lab_* tools + HTTP routes
│   │   ├── client.js                           [C] sidebar entry + the Memory Lab presentation
│   │   ├── lib/memory-store.js                 [H] the durable store, pure Node, no DSH import
│   │   ├── locale/en.json, locale/zh.json      display metadata per language
│   │   └── icon.svg                            the bundle icon the Manager card reads
│   └── newmark-computeruse/                    the ComputerUse bundle
│       ├── package.json                        bundle manifest
│       ├── cordis.patch.yml                    inserts the one Host row
│       ├── index.js                            [H] tools + takeover lease + HTTP state route
│       ├── client.js                           [C] the takeover stroke in `shell.overlay` only
│       ├── lib/win32.js                        [H] lanes, native helper, action surface
│       ├── locale/en.json, locale/zh.json      display metadata per language
│       └── icon.svg                            the bundle icon
├── scripts/
│   ├── verify-memorylab-store.mjs              [G] the store gate
│   ├── verify-computeruse-win32.mjs            [G] the automation-layer gate
│   └── verify-cu-sweep.mjs                     [G] the relative-motion gate: raw-input A/B, every refusal, the hidden-desktop negative
├── evidence/                                   machine-readable gate output
└── archive/                                    timestamped operation records, append-only
```

> **Note (2026-10-18, a named conflict).** The tree above still draws the pre-consolidation
> package layout (`packages/newmark-memorylab/`, `packages/newmark-computeruse/`). The shipped
> package is one bundle at `packages/newmark-core/` with five components under
> `components/{memorylab,computeruse,agent-api,newmate,heartbeat}/`. **The code wins**
> (`docs/00-governance.md` A2); the drawing is stale and its per-file paragraphs below are read
> with that in mind. This round's additions are named with their real paths.

## 4. What each file contains

### 4.1 `packages/newmark-memorylab/`

**`package.json`** — declares `~/.dsh`-installed bundle metadata: `dsh.bundle.patch`
points at `cordis.patch.yml`; `dsh.client` declares `platform: web`,
`immediately: true` and an **empty** `inject` list, because a name no enabled row
provides fails composition and our only hard dependency is the `slots` service
declared inside `client.js`. `icon` and `meta` feed the Plugin Manager card and
the settings inventory **without activating the plugin**.

**`cordis.patch.yml`** — one `insert` row, `id: newmark-memorylab`,
`name: @local/newmark-memorylab`, `config.root: ''` (empty means "resolve from
`$DSH_HOME`").

**`index.js`** **[H]** — exports `name`, `inject = ['tools']` and
`apply(ctx, config)`. Inside `apply` it:
- resolves the root (`config.root`, else `$DSH_HOME/newmark-memorylab`), constructs
  the store once and calls `ensureLayout()`;
- registers the five model-facing tools. `memory_lab_update` and
  `memory_lab_delete` route through `verifiedReceipt()`, which runs the
  deterministic rebuild **and** a read-back verification and returns
  `receipt: { rebuilt, verified, revision, updatedAt }`; a failed verification is a
  structured `{ ok: false }`, never a silent success. `memory_lab_reindex` does the
  same for the normalisation entry point;
- registers one `webServer` prefix route at `/newmark-memorylab` with
  `/visualization` (the one-shot snapshot the panel consumes), `/state`,
  `/reindex`, `/query` and `/component`;
- reads `webServer` through `ctx.inject(['webServer'], …)` so a composition without
  a web server keeps the plugin active and simply loses the HTTP seam.

**`client.js`** **[C]** — one `window.__ModuleLoader__.load({ id, factory })`.
The factory holds one snapshot store, one generation counter and one in-flight
guard. It registers exactly two things:
- `sidebar.panellist` with `id: 'memory-lab'`, `order: 20` and a label thunk;
- `main` with `key: 'memory-lab'`.

The presentation itself is three components. `OverviewView` draws the graph as an
SVG: a deterministic layout (root at centre, root tags on an inner ring, leaves
outward, up to 24 components as addon dots), `parent`/`child` links each with a
static stroke and an animated `ml-flow` dashed overlay, pointer drag moving **only
the camera** (never a node), wheel zoom clamped to `[0.18, 2.4]`, a zoom readout,
and a dot mode below a `0.28` scale — the parent's own point-mode threshold — with
a default camera of `0.88`. `DetailView` draws the three-column tag graph
(parent tags or root tags | the selected tag | child tags and components) beside a
preview pane carrying the selected component's Markdown, its description, its tags
and its revision. `SearchBox` filters tags and components from the retained
snapshot and jumps to the detail view. The stylesheet renders as a React element
inside the panel's own tree, so unmounting removes it and the plugin never touches
`document.head`. The reindex button paints a brand-coloured inset ring on the panel
and sets `aria-busy`, mirroring the parent's busy treatment of the same surface.

**`lib/memory-store.js`** **[H]** — the durable store. Pure Node (`node:fs`,
`node:path`, `node:crypto`), no DSH import, no build step, so it is directly
testable outside the Harness. It owns `index.json`, `components/`, `archive/` and
`policy.jsonl`; every write is atomic (`*.tmp` + rename) with a `.bak` of the
previous good index; a malformed index reports a structured error rather than
silently emptying the store; component paths are containment-checked. `reindex()`
is the single normaliser: it rebuilds the tag graph **from each component's own
`tags`/`tagPaths`**, folds bilingual synonyms to one language-preferred canonical
tag while keeping the alternatives as aliases, rewrites the components to canonical
names, drops orphaned synonym nodes and recomputes a deterministic
`relationshipVersion`. `query()` enforces the parent's exact bounds.

### 4.2 `packages/newmark-computeruse/`

**`index.js`** **[H]** — exports `name`, `inject = ['tools']` and `apply`. It owns
the takeover lease (one owner at a time, a structured occupied response naming both
owners, and `mouseMode` restored to `real` on every exit path including expiry), the
action surface and one `webServer` prefix route at `/newmark-computeruse/state` that
the Client half polls. It carries no learned model, no artifact loader and no NPU
path.

**`client.js`** **[C]** — one factory, and exactly ONE registration:
`shell.overlay` with `id: 'newmark-computeruse-takeover'`. **There is deliberately
no `sidebar.panellist` and no `main` registration**: ComputerUse is an implicit
capability. The component returns `null` unless the lease is held, and when held
renders a single ring element plus a visually hidden `role="status"` line. The ring
is the frozen Newmark stroke and nothing else, with `@property`-registered angle
animation, the `@supports not` hue-rotate fallback, and `pointer-events: none` so
it can never block the application underneath.

**`lib/win32.js`** **[H]** — the Windows automation layer: seven independently
stoppable PowerShell lanes, the C# native helper, the action surface, the four-axis
mode inventory, DPI-correct physical coordinates, the foreground and process-id
ownership checks, the `finally` release on drag, SendKeys normalisation and
escaping, and the sparse 32×18 digest sampler. On a non-Windows platform every
action returns a structured `unsupported_platform` result instead of throwing.

### 4.3 `scripts/`

**`verify-memorylab-store.mjs`** **[G]** — creates its store in a unique temp
directory, removes it in a `finally`, and prints one line per named assertion plus
`PASS n/n`. Covers ADD/UPDATE/DELETE, revision advance, stale-write rejection,
archive-before-mutation, normaliser idempotence, bilingual folding, the 35% early
stop, the budget clamps, the 64000-char scan cap, matched-field reporting,
append-only `policy.jsonl` with no memory body text, containment rejection and
`.corrupt` recovery.

**`verify-computeruse-win32.mjs`** **[G]** — asserts the lane list and the
four-axis mode inventory against literal expected values, the input constants, the
SendKeys mapping and escaping, the anti-coupling prohibition on the retired line,
the virtual-mode prohibition region, the lease contract (single owner, occupied
response naming both owners, `mouseMode` restored to `real` on stop, and no action
able to switch its own mode), and — on Windows — a real lane readiness probe, a live
scroll refused as `point_required`, a live unmatchable `app_target` refused, and the
native-helper/gate contract checks. **Correction (2026-10-18, a named conflict):** this
paragraph used to say it "performs no real mouse or keyboard input". It does: the live
checks move the pointer, click a probe, and scroll, and never press a key. The code wins;
the sentence was stale.

**`verify-cu-sweep.mjs`** **[G]** — the relative-motion gate, entered by name into
`verify-newmark-core.mjs`. It builds a WinForms probe that registers raw input
(`RIDEV_INPUTSINK`) and counts `WM_INPUT` in its own window procedure, publishes its
counters to a state file and its own title, and then measures, in named checks: the physics
(`SetCursorPos` moves the pointer and injects no raw packet; one relative `mouse_event`
delivers exactly its delta), the defect (`drag` moves the pointer and injects no raw
**motion**; its two button transitions are raw input and are asserted separately), the fix
(`sweep` delivers exactly `dx`,`dy` and presses/releases the button once each), the
arithmetic (closed form plus per-step remainder), the cursor restore (and the
`restore_cursor:false` half), every named refusal with nothing delivered, and the
hidden-desktop refusal together with the zero-packet measurement that justifies it. Check 8
plants `SetCursorPos` in place of the injection, requires check 3 to go RED, restores the
file byte for byte, re-verifies its sha256, and requires the control run to be GREEN again.

### 4.4 `docs/`

**`14-cu-sweep.md`** — the contract for relative mouse motion: the action's arguments and
their bounds, the closed-form displacement and the exact-sum requirement, the delivery
mechanism (relative injection; the absolute call is used only to restore, because it
produces no raw motion), every refusal code, the receipt's fields, the measured
acceleration caveat (`dx` is the raw delta, `cursor_displacement` is the accelerated
travel), the hidden-desktop refusal and the 0-packet measurement behind it, and a
boundaries section that names what was not verified.

**`00-governance.md`** — the parent project's governing rules, extracted with a
`path:line` citation on every rule, organised as documentation hierarchy (A), hard
rules (B), prohibitions including every retired/frozen item (C), verification and
evidence gates (D), visual and motion taste with exact values (E), port-relevant
constraints (F) and the adoption checklist. It contains two recorded corrections
where this workspace's earlier claims were wrong.

**`01-dsh-plugin-contract.md`** — every DSH fact the port depends on, each traceable
to a live Inspect query, a shipped `README.zh.md`, or an observed installation
result: the two sidebar seats and why the entry id and the main key are the same
string, the Client module shape, why `host.call` is unavailable to an installed
bundle and the HTTP route replaces it, the admission policy that makes a bare
unauthenticated `GET` return 403, the Host plugin export forms, the bundle manifest,
and what installation does and does not prove.

## 5. Progress

**Done**
- Sub-workspace created with the project protocol.
- The DSH plugin contract established from live inspection and written down.
- Both bundles authored, installed into the `desktop` profile and reported
  `application: applied`.
- MemoryLab sidebar entry + main panel live (`Slots` Inspect); ComputerUse overlay
  seat live (`Slots` Inspect); `computer_use` Host tool callable.
- The takeover stroke reproduced with the frozen token values and **confirmed by
  the user** in the running GUI.
- MemoryLab panel rebuilt from the installation probe into the real presentation.

**In progress**
- `lib/memory-store.js` and `lib/win32.js` and their gates.
- Wiring `index.js` of both bundles onto those modules and re-verifying.

**Open**
- No browser control in this environment, so rendered-UI verification rests on the
  live slot registration plus the user's observations.
- The ComputerUse real-input paths are not exercised against a live desktop by any
  gate here.

---

# Round 2 (2026-09-30) — Newmark-Core: one plugin, two components

**This section supersedes §3 (file tree), §4 (what each file contains) and §5
(progress) above.** The two separate bundles are retired; one plugin now carries
both features.

## R2.1 Why the shape changed

The user's directions, in order: *"MemoryLab不要做Host端口，这是偷懒行为，我要求你做成
原生内置渲染器"*; *"computerUse是内置隐式插件不需要出现在侧边栏"*; *"Memorylab要求侧边
栏点进去是正确的渲染呈现而不是插件介绍"*; *"Newmark2DSH子项目的所有配置都要与Newmark共享，
即采用user/.Newmark文件夹以及同等文件类型存储其用户级配置"*; *"将这两个插件聚合为一个插件的
两个组件，统称为Newmark-Core插件，但注意左侧栏要正确呈现为MemoryLab"*; *"两个组件需要可以
独立开关"*; *"将两个插件功能在Newmark本体执行的门禁一并复制到对应的发布门禁，然后修改至插件
适用的门禁，执行测试并修复"*; *"两个插件要有与Newmark相同的Linux端兼容性，且所有功能要在插件
内部原生实现"*; *"保留页面中组件渲染的通用接口接入，暂不强行移植CSS渲染部分"*; *"但总览的核心
渲染要完全完整移植"*; *"MemoryLab重建索引附带完成重建后刷新页面"*.

## R2.2 File tree

```
Newmark2DSH/
├── README.md, OVERVIEW.md, taste.md            the three resident documents
├── docs/
│   ├── 00-governance.md                        the parent rulebook, extracted with citations
│   └── 01-dsh-plugin-contract.md               the verified DSH contract
├── packages/
│   ├── newmark-core/                           **the one plugin**
│   │   ├── package.json                        one bundle; `dsh.bundle.patch` + `dsh.client`
│   │   ├── cordis.patch.yml                    root / language / leaseTtlMs / component switches
│   │   ├── index.js                            host half: the shared root, both components, the index injection
│   │   ├── client.js                           client half: MemoryLab seats + the ported overview + the takeover stroke
│   │   ├── components/memorylab.js             the MemoryLab component: store, five tools, snapshot
│   │   ├── components/computeruse.js           the ComputerUse component: backends, two tools, lease
│   │   ├── lib/memory-store.js                 byte-compatible with Newmark's Memory Lab/index.json
│   │   ├── lib/win32.js                        Windows automation backend
│   │   ├── lib/linux.js                        Linux automation backend
│   │   ├── locale/{en,zh}.json, icon.svg       display metadata
│   │   ├── newmark-memorylab/                  RETIRED: superseded by newmark-core, kept for its gate
│   │   └── newmark-computeruse/                RETIRED: superseded by newmark-core, kept for its gates
├── scripts/
│   ├── verify-newmark-core.mjs                 the plugin release gate (68 assertions)
│   ├── verify-memorylab-store.mjs              the store gate
│   └── verify-computeruse-win32.mjs            the automation-layer gate
├── evidence/                                   machine-readable gate output
└── archive/
    └── 20260930-014200-newmark-core-merge/     this round's operation record
```

## R2.3 What each new file does

**`index.js`** resolves the shared Newmark root (`~/.Newmark`, overridable by
`config.root`), activates each component that its switch leaves on, registers the
tools those components declare, and contributes exactly one thing to the page: a
`webServer.tapIndex` transform that embeds the snapshot as
`window.__NEWMARK_CORE__`. It registers no route.

**`components/memorylab.js`** owns `memoryLabDir(root)` = `<root>/Memory Lab`, the
store, the nine `memory_lab_*` tools, and `snapshot()` — which optionally runs the
deterministic rebuild and returns the wire index plus every component's markdown.
Mutations pass through `verifiedReceipt`, so a success means the rebuild and the
read-back both agreed.

**`components/computeruse.js`** owns the two automation tools, the platform
dispatch (lazy `import()` so a missing backend degrades instead of crashing), the
21-verb action surface and the synchronous lease mirror the snapshot carries.

**`client.js`** registers, per switch: the MemoryLab `sidebar.panellist` entry
(id `memory-lab`) and the matching `main` key, and the ComputerUse
`shell.overlay` stroke. The overview is a complete port — classification, three
radial seeds, two edge kinds, bounded rotating repulsion, per-kind springs,
ambient drift at 72% retention, one dirty-frame scheduler, the 0.28 zoom-dots
threshold, four focus modes, synchronous pan, pointer-anchored wheel zoom,
toggleable selection and the dot-mode tooltip — rendered imperatively inside a
thin React wrapper.

**`lib/linux.js`** presents the same exported surface as `lib/win32.js` over
`xdotool` / `xte` / `ydotool`, `wmctrl`, `xprop` and a capture fallback chain.
It probes rather than assumes, and refuses rather than falling back to real input.

## R2.4 Progress

**Done and verified**
- One bundle `@local/newmark-core`, installed, `application: applied`, no warnings.
- Both component switches implemented and asserted; the sidebar entry and `main`
  key are both `memory-lab`; ComputerUse registers no entry and no panel.
- The plugin release gate is green on everything except the one sub-gate that was
  being rewritten concurrently.
- The store is byte-compatible with the live `~/.Newmark/Memory Lab/index.json`
  (91 tags, 15 components, no rename, no membership change, single-node
  `tagPaths` kept) and its own gate passes 30/30.
- The takeover stroke was observed by the user and matched the original.
- The Linux backend exists with the same export surface as the Windows one.

**Defects found and fixed this round** — the full list with evidence is in
`archive/20260930-014200-newmark-core-merge/REPORT.md`: the store writing into the
user's Newmark root (repaired, live store verified byte-identical), a probe that
misdiagnosed that bug, the retired line named in a comment, a gate assertion
looking at the wrong file, the panel printing the local store path, and the
takeover overlay drawing no stroke.

**Open**
- No browser control, so the rendered panel and the overview's motion are asserted
  in source, not observed running. A page reload is needed for the index injection
  to take effect in an already-open page.
- No Linux desktop, so every `xdotool` / `wmctrl` / `xprop` / capture invocation is
  unexecuted.
- No gate here performs real mouse or keyboard input.

---

# Round 3 (2026-10-05) — the Dev preset becomes a creator mode

**This section supersedes §5 and R2.4 (progress) and adds one component's behaviour.
It changes no file tree entry other than the rows listed below.**

## R3.1 The brief, and what it turned out to mean

The user's request: *"为Newmark2dsh添加附属preset:dev创造模式，将dev模式加入创造模式内核
修改权限"*.

Two things had to be established before the request could be implemented, and both
are recorded in `docs/01-dsh-plugin-contract.md` §7 with citations:

1. **「创造模式」 is a preset, not a feature.** It is the shipped `cordis` preset
   (`@deepseek-ai/dsh-web-app/presets/cordis.patch.yml`), and the "kernel-modification
   permission" it carries is exactly three rows: `tool-cordis` (runtime inspection),
   `skill-filesystem` + `customSkillDirs` (the composition skills), and
   `tool-plugin-manager` (persistent plugin management).
2. **The Newmark2DSH Dev preset already existed and already sat in the picker as the
   new-task default** (`agent-preset-registry.config.selectedDefault: dev`), but it
   had none of those three rows: no inspector, no composition skills, and
   `tool-plugin-manager` hard-`disabled`. Selecting Dev got the project-management
   persona and PTC presentation and nothing that could touch the harness.

So the work was to grant Dev the same three rows, and to make the grant actually
reach the running composition.

## R3.2 What changed

| File | Change |
|---|---|
| `packages/newmark-core/cordis.patch.yml` | `preset-dev` gains `tool-cordis`, `skill-filesystem.config.customSkillDirs`, and `tool-plugin-manager` under the shipped `!ctx.get('profileContext')` gate; description names the capability; 20 → 21 top-level plugin rows |
| `packages/newmark-core/package.json`, `components/*/package.json` | 0.2.15 → **0.2.16** (all four manifests), description names the creator mode |
| `VERSION.md` | the 0.2.16 ledger row, kind `sub-component change` |
| `scripts/verify-newmark-core.mjs` | the plugin-row count 20 → 21, plus four assertions naming each capability row and the description |
| `scripts/verify-preset-patch.mjs` | a new section comparing the **profile layer's copy** of the declaration against the bundle's capability rows; the nested-`!!js` count 2 → 3 |
| `docs/01-dsh-plugin-contract.md` | new §7: creator mode, preset-scope rows, layer order and `config` replacement, the resolution overlay, reload semantics, header-vs-mounted preset |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | the profile layer's `preset-dev` mirror gains the same three rows; the inert four-space `config.disabled: true` is removed |

## R3.3 Why the profile patch had to change too

This is the round's substantive finding, and it was measured, not assumed.

The layer order is bundle layers → the desktop's own patch → market provider →
**the profile's `cordis.patch.yml`** → home patch → `--patch` overlays, and an
id-targeted patch **replaces the matched row's `config` wholesale**
(`cordis-plugin-include/lib/index.js:99-102`). So the profile layer's copy of
`preset-dev` is what the composition runs; the bundle's copy would have been
documentation the moment the two disagreed. Editing only the bundle would have
changed nothing.

The gate now compares the two copies' capability rows on every run, because that
divergence is silent: both files look right, and the file that reads as the source
of truth is not the file in force. It was mutation-tested — deleting `tool-cordis`
from the bundle copy alone turns it red (`not ok 11`), and the file was restored
byte-identically.

The `disabled: true` that had sat at **four spaces** in the profile copy since
2026-10-01 was inside `config`, where no plugin Config has such a field: accepted,
persisted, inert. It is the exact mechanism `verify-preset-patch.mjs` already names
in its header ("mechanism 1"). It is gone; neither copy disables the declaration.

## R3.4 What was measured, and what was not

**Measured**

- The release gate: **175/175**, 0 failed, 0 skipped — including the four new
  capability assertions and the new two-copy comparison.
- Version discipline: 12/12 on 0.2.16.
- `verify-newmark-core-reinstall.mjs --check` against the live profile: 13/13.
- The installed bundle is `newmark2dsh@0.2.16` as a junction to this workspace, and
  its `cordis.patch.yml` sha256 equals the workspace's (`38c2ce9a…`).
- The composed Dev preset, through `dsh --profile … --dump-config` (which shares
  the Loader's own `applyEntryPatches`): **21 plugin rows**, with `tool-cordis`,
  `customSkillDirs`, the gated `tool-plugin-manager`, and no row-level `disabled`.
  Captured in `evidence/dev-creator-mode/2026-10-05-postinstall/composed-preset-dev.yml`.
- `customSkillDirs`' target resolves and carries four `SKILL.md` files.
- The running tree was re-composed:
  `plugin_manager action=set_bundle target=newmark2dsh enabled=true` →
  `changed: false`, `application: applied`, `warnings: []`, and the Host log gained
  no line. `reconcileProfilePatches` throws when a required id fails, and
  `preset-dev` was one of the required ids, so a non-throwing `applied` is positive
  evidence the row is live.
- `install_bundle` on an already-present dependency answers
  `application: restart-required` and does **not** reload — the manager's own
  `Object.hasOwn(before, name)` branch. That is why the patch change needed the
  reload step above rather than the install alone.

**Not measured**

- **A live Dev session's tool list.** No inspect provider projects a preset's
  composition (`Config.listConfigs` lists the root tree only), so the row list rests
  on the composition dump plus the reload's failure gate. Creating a Dev task and
  reading its tool catalog is the observation that would close this, and it needs a
  user-side session.
- **Rendered UI.** Unchanged from R2: no browser control.

## R3.5 Open, and one finding recorded rather than fixed

- A Dev task's session header and the preset it actually mounts can disagree. Two
  consecutive sessions on 2026-10-05 read `agentPreset: "dev"` in the header and
  `{"agentPreset":"cordis"}` in their `agent-preset/selected` event, with the
  `cordis` persona and tool list actually mounted. `agent-preset/selected` is the
  result; the header is the request. This is client-side selection behaviour, not
  something a bundle patch can change, and it is recorded in
  `docs/01-dsh-plugin-contract.md` §7.6 and in the ledger rather than papered over.
- The profile layer still carries a full copy of the declaration where the bundle's
  own comment says the bundle "only *declares*" it. Collapsing the copy to a
  config-free enable patch would make the bundle the single source of truth, but the
  preset gate's fixture assertions are built on the nested `!!js` keys that copy
  carries, and removing them would remove the hazard that gate exists to test. Left
  as a mirrored pair, with the comparison gate enforcing the mirror.

---

# Round 4 (2026-10-05) — rDev, the restricted twin

**This section supersedes R3's "two presets" wording where it conflicts: the bundle now
carries two preset rows, not one. Round 3's changes stand unchanged.**

## R4.1 The correction, and what it settled

The user's clarification: *"我的意思是新增一个preset而不是在原preset上修改，既然你已经改动了Dev
作为包含创造模式的preset，那就新增一个标识为rDev的preset内置预设，意思是restricted
developer，其他功能与现有Dev一致，除了没有创造模式改动运行时dsh权限"*.

So: **keep** the upgraded `Dev`, and **add** `rDev` — the same agent with the
kernel-modification capability withheld. The choice between "can reach the harness" and
"cannot" is then made when a task is created, in the picker, instead of by editing one
preset back and forth.

## R4.2 What changed

| File | Change |
|---|---|
| `packages/newmark-core/cordis.patch.yml` | a third Loader row, `preset-rdev` (`id: rdev`, `name: rDev`, `order: 2.6`), generated from the `preset-dev` block with the three capability changes undone — 21 rows → 20. Header comment and row comment rewritten to describe the pair |
| `packages/newmark-core/package.json`, `components/*/package.json` | version **not advanced**: rounds 3–5 are one release, 0.2.16 (see R4.7) |
| `VERSION.md` | **no new row**: the 0.2.16 row covers the whole update (see R4.7) |
| `scripts/verify-newmark-core.mjs` | preset assertions are now scoped to a **slice per preset** instead of the whole file; Dev/rDev identities and row counts asserted separately; a computed row-by-row difference assertion; two obsolete one-row-per-package constraints corrected (see R4.4) |
| `scripts/measure-dev-rdev-mutations.mjs` | **new gate**: plants three rejected shapes, runs the release gate, restores the patch byte-identically |
| `scripts/check-release-bundle.mjs`, `scripts/verify-market-install.mjs` | the declared-row expectation 2 → 3 |
| `scripts/verify-newmark-core-reinstall.mjs` | `REQUIRED_ROWS` corrected to the rows that exist, with a comment recording that nothing reads it |
| `README.md`, `OVERVIEW.md`, `taste.md`, `docs/01-dsh-plugin-contract.md` | outward description, this round, three new rules, §7.7 |

`preset-rdev` is **not** mirrored into the profile patch: the profile layer has no entry for
it, so the bundle's insert is the single source of truth for that row. Only `preset-dev` is a
mirrored pair, which is what `verify-preset-patch.mjs` continues to compare.

## R4.3 The difference is computed, not transcribed

`preset-rdev` was **generated** from the `preset-dev` block by a script that asserts the shape
of every line it touches, rather than typed out. That is a generation-time guarantee only;
what keeps the two from drifting afterwards is the gate.

`verify-newmark-core.mjs` now maps each preset's plugin rows (`id → declaration`), with
comments and blank lines stripped, and requires:

- the rows only in Dev are exactly `['tool-cordis']`;
- rDev adds no row of its own;
- the rows whose declaration differs are exactly `['skill-filesystem', 'tool-plugin-manager']`;
- rDev's `skill-filesystem` is the plain two-line row (whole-row equality);
- rDev's `tool-plugin-manager` is the three lines ending in a literal `disabled: true`.

## R4.4 Two constraints that were wrong, and were found by this change

Both would have failed on a correct change, which is the useful kind of wrong.

1. **"no package is the target of more than one row"** (`verify-newmark-core.mjs`) cited the
   fatal `resolves from multiple active Loader sources` boot error — which belongs to the
   **client-module** registry. The counterexample is shipped: `@deepseek-ai/dsh-web-app`
   declares four rows (`preset-standard`, `preset-ptc`, `preset-minimal`, `preset-cordis`),
   all naming `@deepseek-ai/dsh-agent-preset`, and the app boots — that package carries no
   `dsh` field at all, so it contributes no client bundle. The assertion is now the two
   constraints that are real: the bundle's own client-carrying row is addressed exactly once,
   and any other package addressed more than once must be one with no client half.
2. **`verify-newmark-core-reinstall.mjs`'s `REQUIRED_ROWS` was dead and stale**: read by
   nothing, and still naming `newmark-memorylab` and `newmark-computeruse` — two Loader rows
   that have not existed since the components became nested packages composed by the core row.
   The list is corrected and now says in place that it is unenforced. Wiring it into
   `assertOutcome` is a separate change: the full uninstall→reinstall cycle is destructive and
   is not this round's to run.

## R4.5 What was measured

**Measured**

- Release gate **192/192**, 0 failed, 0 skipped.
- `measure-dev-rdev-mutations.mjs` **3/3** — including the case that proves the check is
  falsifiable (a plugin added to Dev only → `not ok 124`, `not ok 146`).
- Version discipline 12/12 on 0.2.16.- Composed configuration over the live profile layers: `preset-dev` **21** rows with
  `tool-cordis` + `customSkillDirs` + the gated manager, `preset-rdev` **20** rows with none
  of the three. Captured in
  `evidence/dev-creator-mode/2026-10-05-rdev/composed-both-presets.yml`.
- Live: `set_bundle` re-composed the tree (`changed: false`, `application: applied`,
  `warnings: []`), and `plugin_manager list_plugins` reports `include:preset-rdev`
  `enabled: true`, `fiberPhase: active`. `preset-rdev` is a required id of that reload, so a
  non-throwing `applied` is positive evidence it activated.

**Defect found by the new gate, immediately**

The first version of the rDev assertions checked `skill-filesystem` with a **presence
regex**. The mutation gate handed rDev a `customSkillDirs` of its own and the release gate
stayed **green** — `- id: skill-filesystem` followed by its `name:` line is still present
when a `config: customSkillDirs:` block is appended below it. rDev could have quietly
regained a third of the capability. The check is now whole-row equality, and the case stays
in the gate as the reason it exists.

## R4.6 Open

- **The live row list of a preset is still not observable by an agent.** No inspect provider
  projects a preset's composition (`Config.listConfigs` lists the root tree only), so both
  presets' row lists rest on the composition dump plus the reload's failure gate. A user-side
  new task on each preset is the observation that would close it.
- **No panel switch for rDev.** The plugin card's "Dev preset" row writes
  `agent-preset-registry.config.selectedDefault`, which is `dev`. `rDev` is selectable where
  every preset is — the task-creation picker — and adding a second card row would change the
  panel and its assertions; not asked for, so not done.
- **The `id` is `rdev`, the name is `rDev`.** Every preset id in this install is lowercase,
  and this workspace has already paid for mixed case in this exact area: the panel sent
  `presetDev` while the route compared `preset-dev`, and every click was a silent no-op
  (recorded in `verify-preset-patch.mjs`). The build's own schema accepts any non-empty
  string, so this is a convention, stated rather than assumed.

---

# Round 5 (2026-10-05) — the config page stops controlling the default preset

**This section supersedes R4.6's "No panel switch for rDev" note: there is no panel switch
for ANY preset now, and R3/R4 stand otherwise unchanged.**

## R5.1 The instruction, and what it removed

> 去除插件配置中的预设dev preset插件开关行，不用插件配置页调控默认预设

Removing the row alone was not the instruction. The row was the *entrance* to a chain:

```
panel row → POST /newmark-core/components (the presetDev branch)
          → lib/preset-row.js (planPresetWrite / setPresetSelected)
          → <profile>/cordis.patch.yml, agent-preset-registry.config.selectedDefault
```

Everything after the first arrow is still reachable by anything that can POST, and that chain
had already failed **silently three different ways** (`taste.md` §13, kept and marked
superseded): a `disabled` written inside a row's *config* where no Config has such a field; an
id-targeted `disabled: true` on the declaring row; and a panel sending `presetDev` to a route
comparing `preset-dev`. So the whole path went, not just the row.

## R5.2 What changed

| File | Change |
|---|---|
| `packages/newmark-core/client.js` | the `presetDev` row removed; the preset's state plumbing out of `readState`; comments rewritten to "both switches" |
| `packages/newmark-core/index.js` | the preset POST branch, the GET `presetDev` key and `presetState()` removed; `profileContext` dropped from `inject`; the header table and route comments rewritten |
| `packages/newmark-core/lib/preset-row.js` | **deleted** (734 lines). Its parser moved to `scripts/lib/preset-patch.mjs`, outside the package; its writer, its line-level editing machinery and the corruption tests built on them are gone |
| `scripts/verify-preset-patch.mjs` | rewritten: 121 → **23** assertions, now about the two declarations agreeing and the write path being absent |
| `scripts/measure-preset-write-path-mutations.mjs` | **new gate**: four reintroductions plus one piece of prose that must stay green |
| `scripts/verify-config-panel.mjs`, `scripts/verify-newmark-core-client.mjs`, `scripts/probe-compose.mjs`, `scripts/verify-failure-log.mjs` | each lost its preset-switch scenario, keeping the property it held |
| `scripts/verify-newmark-core.mjs` | the switch assertions replaced by four absence assertions; the sub-gate description updated |
| `scripts/verify-market-install.mjs`, `scripts/verify-out-of-the-box.mjs` | `lib/preset-row.js` out of the shipped-file lists |
| `packages/newmark-core/package.json`, `components/*/package.json` | version **not advanced**: rounds 3–5 are one release, 0.2.16 (see R5.6); the description now says the default preset is a patch-layer declaration |
| `VERSION.md`, `README.md`, `OVERVIEW.md`, `taste.md` | the switches section; this round; §13 marked superseded + §17–18; the 0.2.16 row covers R3–R5 (see R5.6) |

## R5.3 Why the parser moved out of the package

`lib/preset-row.js` was 734 lines of parse + plan + write. With the switch gone its only
remaining reader is the gate that compares the two copies of each declaration — and a `lib/`
file with no runtime caller reads as part of the shipped plugin, which it no longer is. The
parser half moved to `scripts/lib/preset-patch.mjs`; the writer half was deleted rather than
kept, because a writer nobody calls is a writer that can still be called.

What survived of the parser is `parsePatch` (with the `!!js` tag declared exactly as the Loader
declares it), `patchRows` and `parsedRow`. `entryBounds`, `configBlock`, `readSelectedLine` and
`patchPathOf` existed for the writer's line-level editing and went with it.

## R5.4 Verification

| Gate | Result |
|---|---|
| `verify-newmark-core.mjs` | **195/195**, 0 failed, 0 skipped |
| `verify-preset-patch.mjs` | **23/23** |
| `verify-config-panel.mjs` | **29/29** |
| `measure-preset-write-path-mutations.mjs` | **5/5** |
| `measure-dev-rdev-mutations.mjs` | **3/3** |
| `verify-version-discipline.mjs` | **12/12** on 0.2.16 |

Live: `set_bundle` re-composed the tree (`changed: false`, `application: applied`,
`warnings: []`) and the bundle reports 0.2.16 with all three rows.

## R5.5 Open, stated rather than implied

- **A Host-module change still needs a DSH restart.** 0.2.16 changes `index.js` and
  `client.js`; the reload applies the patch layer, but the harness caches a Host module
  generation, so the running process keeps the old `index.js` until the app restarts. The
  client half is served from disk with a revision derived from its mtime, so a page refresh
  after that restart shows the panel with four rows. Neither is something a bundle can force.
- **The live route was not probed.** The plugin's route sits behind the shell's admission
  policy and no agent-facing tool can POST to it, so "the branch is gone" is asserted against
  the real `apply()` and the real route in `probe-compose.mjs` (which mounts both), not
  against the running process.

## R5.6 Version discipline — R3, R4 and R5 are ONE release, 0.2.16

Recorded after the fact, because it was got wrong first.

Rounds 3, 4 and 5 were three steps of **one** update to the preset sub-plugin, and they were
recorded as three releases: `0.2.16`, `0.2.17`, `0.2.18`. The rule in `taste.md` says what the
ledger records is a **release**, and the `patch` field counts changes — so one update is one
step: `0.2.15` → **`0.2.16`**.

`0.2.17` and `0.2.18` were never released — no `npm pack`, no tag, never installed as their own
version — so they were withdrawn before publication and their content folded into the single
0.2.16 row. The withdrawal is recorded in `VERSION.md` under the table rather than by editing
it out of existence, because the arithmetic that produced it is the thing worth not repeating.

What the merged row says, in the ledger's kind vocabulary: **`sub-component change`** — a
change inside an existing sub-component, `patch` + 1. Nothing was added, so `minor` stays 2 and
`patch` moves one step. The gate that enforces this is `verify-version-discipline.mjs`
(12/12), and it was green both before and after the consolidation: three legal steps and one
legal step are both legal *arithmetic*, which is exactly why the rule needs a human judgement
about what counts as a release — the ledger's own header says the kind is recorded by hand
because "whether a release actually ADDED a sub-component is a fact about the work, not about
the tree".

---

# Round 6 (2026-10-05) — 0.2.16 released, pushed, pulled back, and one incident

## R6.1 The release

`0.2.16` is published and pushed, and the profile has been reinstalled from the registry:

| Fact | Value |
|---|---|
| Release repository | `https://github.com/positer/newmark2dsh` `main` @ `16f850c0` |
| npm | `newmark2dsh@0.2.16`, `latest`, 43 files, integrity `sha512-wwNO+NMV/owmW…`, `gitHead` `16f850c0…` |
| Profile | `newmark2dsh: 0.2.16` as a **materialised directory**, patch sha256 `1993b77b…` |
| Components | both `link:` dependencies intact and resolving (reinstall check 13/13) |
| Loader rows | `newmark-core`, `preset-dev`, `preset-rdev` — all active |
| Remaining step | **a DSH restart** — the patch layer is live, the Host module is not |

The release exposed a gap in the tool, which is now closed: `sync-release-repo.mjs` copied files
into the release repository and never removed them, so the deleted `lib/preset-row.js` would have
been published inside 0.2.16. It now sweeps the stage for files the manifest's `files` patterns
cover and the package no longer has — restricted to those patterns, so the repository's own
README/`.github`/`.gitignore` are never the package's to delete. It printed `removed 1`.

## R6.2 The incident

**Installing the published package deleted the whole package source tree** — 54 tracked files,
including both components. The profile depended on the package as a `link:` (a Windows junction
into this workspace); replacing that junction with a materialised package was done as a recursive
delete that followed the reparse point.

Recovered in full from the release-stage clone, and `verify-newmark-core.mjs` passes **195/195**
on the recovered tree. `git checkout` was not the recovery: the index held the 0.2.15-era tree,
and the plausible-but-wrong result was caught because the restored `cordis.patch.yml` hashed to
`067fd12a…` instead of the `1993b77b…` recorded in the evidence beforehand.

Full record: `evidence/0.2.16-release/2026-10-05/incident.md`, and
`archive/20261005-182229-0.2.16-release/REPORT.md`.

**The hazard is not repaired, deliberately.** The two component links still point from the
profile into this workspace, and the same pnpm operation on them would delete
`components/memorylab` and `components/computeruse`. Repairing it means materialising the
components (losing live-edit reach) or moving the working tree outside the link targets — a
topology decision for the user. Two mitigations are in place instead: the recovered tree is now
**staged in the workspace index** (so the next loss is one `git checkout` away, and the index
holds 0.2.16 rather than 0.2.15), and the release-stage clone is kept while the temp directory
lives.

---

# Round 7 (2026-10-05) — the post-restart self-test

**This section supersedes nothing; it is the first verification of the running 0.2.16.**

After the user restarted DSH Desktop, every component and every tool was exercised against the
running Host. Full receipts: `evidence/0.2.16-postrestart/2026-10-05/selftest.md`; the record is
`archive/20261005-200443-postrestart-selftest/REPORT.md`.

| | Result |
|---|---|
| Restart | four components booted from the **materialised 0.2.16** with no error line; three Loader rows active; **six** agent-preset rows live (the four shipped + `preset-dev` + `preset-rdev`) |
| Tool inventory | `agent_api_state.catalog.count = 15` — the README's "fifteen tools", measured |
| MemoryLab | **9/9**, including the full create → append → stale-refusal → tag-judge (dry and real) → delete → reindex cycle |
| Agent API | **4/4**, including one real judged run |
| ComputerUse | **2/2**, including a hidden-desktop end-to-end and both capture scopes |
| Live store after | **net zero**: 98 tags, 18 components, `relationshipVersion b3375a71…`, +4 policy lines |
| Regression net | 195/195, 12/12, 5/5 |

Three findings worth keeping:

- **The instrument beat the eye.** A capture *looked* like CJK had not been typed; a page that
  mirrors its textarea into `document.title` proved ASCII + CJK + an astral emoji all arrive,
  and that only the LF does not. `app_type` text with a bare LF does not break the line —
  `app_key enter` does.
- **The hidden-desktop agent refuses chords** (`hidden_agent_single_key_only`), with a code and
  a sentence rather than a silently dropped modifier.
- **`agent_api_tool` reaches its own scope** — the bundle's 15 tools — so a session-scoped tool
  like `read` answers `unknown tool`. The same boundary `catalog.count: 15` shows from the
  other side.

Not observed, and stated rather than implied: the plugin card **as rendered** (the renderer is
executed by the client harness, 101/101, but no tool projects the page), a **session's tool list
on `Dev` and on `rDev`** (no inspect provider projects a preset's composition), and the
**real-mouse paths**, which were deliberately confined to a hidden desktop.

---

# Round 8 (2026-10-05) — the exposure rule, and a release that took 57 minutes to exist

## R8.1 What changed, and the constraint that shaped it

The user's rule: **通过对话调用的 Agent API 要对齐对话工具暴露，其他途径只暴露 ptc + 包内 + 其他插件额外.**
`callScope()` is now the single place that decides it — a call arriving with `exec.agent` is
answered for that conversation (`schemas(agent)`: its preset's tools, this package's, and whatever
else that conversation registers); a call arriving any other way is answered for the process
(`schemas()`: the PTC transport, this package's tools, and other plugins' global registrations).
`agent_api_state.catalog`, `agent_api_catalog`, a run's `tool_names`, and the scope a dispatch
resolves for all read it, because "the catalog says one thing and the dispatch does another" was
the defect: from inside a conversation the catalog reported 15 while the session had dozens, and
`agent_api_tool { tool: "read" }` answered `unknown tool`.

**The constraint that shaped the implementation:** the first version passed the agent into
`execute` whenever there was one. The registry's `resolveExecution()` **collapses** a
model-direct call under a `ptc` presentation — it answers `undefined` for every name but
`run_code` — and `preset-dev` / `preset-rdev` both declare `tool-presentation: mode: ptc`. That
version would have made `agent_api_tool` stop working on exactly the two presets this work added.
`dispatchScope()` therefore carries the agent only for a `native` presentation and keeps a `ptc`
conversation on the process layer, and the answers say which happened (`scope` / `presentation`,
and a run's `tool_scope` / `tool_reach`) instead of pretending.

`RUN_ISOLATION` and the `agent_api_send` description were **corrected rather than kept**: a
conversational reach does carry that conversation's guards and sandbox policy, a process reach
carries none of them, and the old sentence promised neither applied.

Gates: agent-api **230 → 243** assertions (the new ones ask *which scope was requested*, and the
harness's `schemas()` had to start recording its argument — an assertion that counts tools passes
for both answers and proves nothing), release gate 195/195, version discipline 12/12, client
101/101, panel 29/29, package 44/44, mutation gates 5/5 and 3/3.

## R8.2 The release, and the fact worth keeping

`0.2.17` (one `patch` step; no sub-component was added) is pushed at
`positer/newmark2dsh` `main` = `9f4f374`, published with `gitHead 9f4f374…`, pulled back into the
profile as a materialised `0.2.17` whose patch sha256 equals this workspace's, and reloaded
(`application: applied`).

**`npm publish` returning success is not publication.** The registry served nothing for **57
minutes** (`534` seconds of 404s on both the packument and the tarball, `dist-tags.latest` still
`0.2.16`, `time.modified` frozen at the previous release), while a retry answered
`E409 Cannot publish over previously staged version` — proof the version number was taken and the
upload accepted. It promoted itself at `14:16:08Z`. The 0.2.16 release of three hours earlier took
about one minute for the same step. **A release flow must gate on `npm view <name>@<version>`, not
on the publish exit code**, or the pull-back step fails with `ERR_PNPM_NO_MATCHING_VERSION` and
looks like a mirror problem.

Ruled out along the way, each by measurement: a client cache (cache-busted packument fetch), the
wrong registry, a token without write rights (`npm whoami` plus an idempotent `dist-tag add`), and
an interactive staging queue awaiting approval (`npm stage approve` requires a stage-id and
`npm stage list` was empty).

The junction hazard from Round 6 did **not** recur: the workspace tree hashed identical before and
after the install (53 files, `8facb390…`), because `newmark2dsh` is now a materialised directory
rather than a `link:` junction into the workspace.

## R8.3 Still unverified, and where

The `ptc` half of `dispatchScope()` has only been exercised through a stub's `modeFor`; this
session's presentation is `native`. After the restart the three checks are in
`archive/20261005-2119-0.2.17-release/REPORT.md` §5 — the important one being that
`agent_api_tool` still works from a `Dev` conversation, since a regression there would mean the
`ptc` branch is inverted.

---

# Round 10 (2026-10-05) — the ptc half measured live, and a defect it exposed

**This section supersedes R8.3 (still unverified) and the "one remaining step" sentence of the
0.2.17 status entry. It changes no file-tree entry.**

## R10.1 What was left, and what it took

R8.3 recorded the one thing `0.2.17` could not prove: the `ptc` branch of `dispatchScope()` had
only ever been driven by a stub's `modeFor`. Proving it needed a real conversation whose preset
declares `tool-presentation: mode: ptc` — and no DSH tool lets a session mount a preset on itself,
so the check had to wait for a user-side session.

It ran on **2026-10-05 22:28–22:34** from a conversation whose `agentPreset` is **`rdev`**, read
out of `~/.dsh/sessions/…/session-b307542d-…/session.v4.jsonl.zstd` rather than asserted. `rdev`
rather than `dev` is immaterial here, and that is measured rather than argued: both declarations
carry `mode: ptc`, and the layer that governs each was checked — `preset-dev` from the profile
layer (`~/.dsh/profiles/desktop/cordis.patch.yml` L77 / L343), `preset-rdev` from the installed
bundle (`<profile>/node_modules/newmark2dsh/cordis.patch.yml` L266 / L433), because the profile
layer has no `rdev` row.

Full record: `evidence/0.2.17-agent-api-exposure/PTC-LIVE.md`.

## R10.2 All three checks pass

| Check | Result |
|---|---|
| `agent_api_catalog` | `scope: "conversation"`, **`presentation: "ptc"`**, `total: 47` — the first live `ptc` answer |
| `agent_api_tool { memory_lab_query }` | **exit 0**. The regression this branch exists to prevent is absent; all 11 in-package tools resolve |
| one run | `tool_scope: "conversation"` **and** `tool_reach: "process"` — the pairing only the stub had asserted |

Two things make the result more than a receipt check:

- **The catalog is aligned item by item, not by count.** `Object.keys(tools)` — the set the PTC
  transport actually bound to this conversation — is **46**; the catalog is **47**; the difference
  is exactly `run_code`, which belongs to the conversation's exposure (it is the transport it is
  presented with) and is subtracted from the transport's own tool set. So
  *catalog = the conversation's exposure ∪ {run_code}*, by design.
- **`tool_reach: "process"` is a true sentence, not a label.** `read` is in the conversation's
  catalog and is **not** a process-layer tool: offered to a run, it was called and it **failed**.
  The same probe run over the 31 non-package names shows **31/31 `unknown_tool`** against
  **0/11** for the in-package set. This is also what proves the ptc branch returns `undefined`
  rather than happening to resolve.

## R10.3 The defect the measurement exposed, unfixed

Under `ptc`, `agent_api_send { tools: { allow: ["*"] } }` reports **42** offered tools, of which
**31 cannot execute** (`42 = 47 − 4 agent-api tools − run_code`; only the 11 in-package ones are in
the layer the run reaches).

This is the *exact* failure `component.js:805-809` says the `scope`/`reach` pairing exists to
prevent — "a tool the list showed but the resolved layer does not carry would answer
`UNKNOWN_TOOL` at call time" — so it is measured against the code's own stated intent, not
against a preference. It is not a crash: the model is handed the failure as a tool result and
answers honestly (`readWorked: false`, `readAvailable: false`). The cost is a wasted turn and a
tool list that is wrong 31 times for a model that trusts its schemas.

**Root cause, read out of the registry** (`@deepseek-ai/dsh-tools/lib/index.js`):
`collapses(name, scope, nested) = !nested && modeFor(scope) === "ptc" && name !== "run_code"`
(L3100), `nested` is `exec.parent !== void 0` (L3058), and `parent` is set only by the registry's
own `run_code` binding (L1306) from a `Symbol` minted at L3613. The component dispatches without
a `parent`, so under `ptc` carrying the agent *must* collapse — `SCOPE-RULE.md` §2's judgement is
therefore correct and necessary. **The component has no honest way to give a ptc conversation's run
a conversational reach**; the list is what must change, not the reach.

Three candidate fixes (make the list follow the reach; obtain a sanctioned nested-dispatch
capability from DSH; or keep the list and report `tools_unreachable`) are written up in
`PTC-LIVE.md` §4.3. **None was applied** — they change what `allow: ["*"]` means in a published
npm package, which is the user's decision, not a test's.

A separate, source-read-only observation is recorded and deliberately not exercised: `parent` is
an unvalidated `Symbol`, so the collapse is not a security boundary against an in-process caller
that can construct an exec object. That concerns DSH, not this plugin.

## R10.4 Store effect: net zero in content

The reachability probe ran `memory_lab_reindex` (a no-parameter tool, so `{dryRun:true}` was
ignored and a real rebuild happened). Compared before and after in the same process, and
structurally against the store's own `.bak`: **exactly one difference — `updatedAt`
(`11:55:42.664Z` → `14:32:48.219Z`)**. `relationshipVersion` `b3375a71…`, 98 tags, 18 components
and 5 roots are unchanged; `policy.jsonl` stayed at 16 lines and `archive/` gained nothing (both
still ending at the 0.2.16 self-test, 19:55:36). The three mutating tools were called with empty
arguments and rejected at validation (`exit 4`, `tool_error`).

## R10.5 File tree delta

```
Newmark2DSH/
├── evidence/0.2.17-agent-api-exposure/
│   ├── PTC-LIVE.md                             [D] NEW: the ptc half, measured live, + the defect
│   └── POST-RESTART.md                         [D] §5 marked measured (appended, nothing rewritten)
└── archive/20261005-223436-agent-api-ptc-exposure/   [D] this round's operation record
```

## R10.6 Still open, stated plainly

- **The defect of R10.3 is not fixed**, and no version was cut for it.
- **The route half is still offline-only.** `GET /newmark-agent-api/state` and `/catalog` both
  answer **403** (admission), so `scope: "process"` / `presentation: "global"` for routes rests on
  `verify-agent-api.mjs`, exactly as R8.3 said. It was not verified this round either.
- **Not a `dev` session.** The equivalence argument for `rdev` is measured (both declare `ptc`,
  both governing layers checked), but a `dev` conversation itself was not opened.
- **The Dev-vs-rDev three-tool difference was not verified.** The rDev session also carries Agent
  Teams tools, so the two sessions are not a clean pair and no conclusion was drawn from the counts.

---

# Round 11 (2026-10-05) — the focus-mode menu, and what a whole-file style audit found

**What the user asked for:** 将 MemoryLab 的双向/父链/子树的 list 菜单样式同步 dsh 的样式表现，注意兼容
别的插件进行的样式覆盖.

## R11.1 Why the fix could not be a style rule

The control was a native `<select>`. Its CLOSED box can be coloured; its OPEN list is drawn by the
platform, so it opened a light Win32 popup inside a dark themed panel — the one surface in the panel
that did not follow the theme, and the one no CSS could reach. So the control was replaced with an
ordinary button plus a listbox card, and the card was built to DSH's own menu spec, read out of
`@deepseek-ai/dsh-client-ui-primitives` rather than guessed: `MenuSurface.module.css`
(`--dsw-radius-lg`, `--dsw-menu-surface-fill`, `--dsw-menu-backdrop-filter`) and `Menu.module.css`'s
compact variant (4px-padded card, `--dsw-elevation-prominent`, rows at `min-height: 24px`,
`padding: 2px 6px`, `--dsw-radius-sm`, 11px/17px, hover and keyboard focus sharing
`--dsw-alias-interactive-bg-hover`, selection marked by a trailing check rather than a second fill).

Two facts decided the shape, both measured: **the dynamic client half has no react-dom** (the runner
calls `closure(react, …)`, so `React.createPortal` does not exist), and therefore the card had to
render where it cannot be clipped — inside the header, which is far enough from the stage's
`contain: strict` edge. The `shell.overlay` seat exists and was deliberately not used.

## R11.2 The compatibility requirement, made checkable

Three rules, each now asserted: every value is a theme token with a FALLBACK for the ones this build
may not define; every selector is namespaced under a prefix this package owns (`ml-` / `nmc-`) with
no bare element type; and no `!important` anywhere, so an override still wins by cascade order.

Running that audit over the **whole client half** (rather than only the new rules) found exactly one
violation: `[data-plugin-rows]`, an attribute selector with no namespace, which another plugin
setting the same attribute would be styled by. It is deliberate — the shell renders a bundle's own
row section outside any slot this panel can address, and hiding it is what avoids duplicate,
contradictory row controls — so the behaviour was **not** changed unilaterally. Instead it is now a
DECLARED exception asserted as exactly one: a second unscoped selector fails rather than joining it.
The exception lives in `verify-config-panel.mjs` (the gate that renders that card); the panel tree's
gate allows none.

Gates: client **101 → 115**, config panel **29 → 34**, release gate 195/195, agent-api 243/243,
version discipline 12/12, package 44/44, preset patch 23/23, reinstall `--check` 13/13, both
mutation gates PASS.

## R11.3 Two prose-versus-code landmines, hit and fixed

Both were latent, and this change stepped on both:

1. The release gate's two takeover assertions read `client.includes(...)` over the raw file, so a
   COMMENT naming the seat the panel deliberately avoids failed a check whose subject is what the
   page RENDERS. Comments are now stripped first; the assertions keep their subject, so a real
   reference in code is still caught.
2. The client gate's new "no `!important`" assertion matched the stylesheet's own comment saying
   "no !important". Same cure, same reason — this repository's standing rule for every
   prose-versus-code match, earned again.

## R11.4 The preset gate was pinning a coincidence

`verify-preset-patch.mjs` required the profile's `selectedDefault` to equal the preset the bundle
declares, and it passed while they happened to agree. It went red because the profile now states
**`rdev`** — the user chose it in the preset picker, which is exactly what the layer order is for
(the profile's patch applies after every bundle layer; the bundle's `selectedDefault: dev` is a
default, not a lock, as its own comment says). A gate that pins the coincidence forbids the
behaviour the bundle documents. What is asserted now is the part that is ours: a stated selection
must name a preset that **exists**. A typo, a stale id or an empty string still fails.

## R11.5 Delivered to the running install, and how to see it

The client bundle is resolved from the package the Loader entry names
(`<profile>/node_modules/newmark2dsh/client.js`) and the client-modules graph is keyed on
mtime/ctime/size, so the workspace `client.js` was copied into that one path and **a page refresh is
enough — no restart**. This is a dev-time delivery: the installed copy therefore differs from the
published 0.2.17 artifact until the next release replaces it, and the workspace stays the source of
record. Full record: `evidence/memorylab-menu-style/MENU-STYLE.md`.

## R11.6 The menu, corrected twice by the user

Two instructions after the first delivery, both applied and both re-checked:

1. **Rows carry the mode name and nothing else.** The first revision put a one-line explanation in each
   row ("父链与子树同时高亮"); the instruction was 只保留原本标题不要额外加描述. That also matches the
   menus this card copies — DSH's own rows are a label plus an optional icon or shortcut — and the gate
   assertion was **inverted** rather than deleted: it had required a `title` of more than four
   characters per row, i.e. it asserted the presence of the very thing being removed.
2. **The card is as wide as its text.** DSH's compact list reserves 156px because its rows carry
   labels, icons AND shortcuts; four two-character CJK labels left most of that empty. The card is now
   `width: max-content` with no minimum floor, asserted as those two declarations so a future edit
   cannot quietly bring the empty card back.

## R11.7 The ptc list defect: fixed, and the invariant now holds by construction

`PTC-LIVE.md` §4 measured it on 0.2.17: a `ptc` run offered 42 tools of which 31 answered
`UNKNOWN_TOOL`, contradicting this component's own comment ("a tool the list showed but the resolved
layer does not carry would answer UNKNOWN_TOOL at call time"). §4.2's conclusion stands — the reach
cannot change honestly — so the fix is on the LIST, and it is more than §4.3's option (a):

- **The invariant holds by construction.** `buildRunTools` now draws the offer from `schemas(reach)` —
  the layer its calls resolve in — instead of the caller's exposure, so list ⊆ reach in both
  presentations rather than by inspection.
- **The subtraction is reported.** `tools_withheld = { count, names, why }` in the receipt, empty with
  an empty `why` whenever the two layers coincide. A silent narrowing would also satisfy the invariant
  and hide the difference; saying it is the half that makes it honest.
- **The catalog's alignment is kept and made actionable.** `agent_api_catalog` and `agent_api_state`
  still answer with the conversation's own exposure (the user's rule) and now add `dispatch` — the
  layer a dispatch resolves in — plus `not_dispatchable`, the entries `agent_api_tool` cannot reach.

**The gate had to change shape to be able to see this at all.** Its stub `schemas()` ignored its
argument, so "the offer is a subset of the reachable layer" was true in the stub as well as in the
component and every assertion about it would have passed with the defect restored. Two fixtures now
exist only in a conversation's view, so the defect is reproduced in miniature and asserted: a native
conversation reaches the conversation-only tool with nothing withheld, and a `ptc` conversation does
not offer it and reports it as withheld. Two assertions whose NAMES stated the old contract were
rewritten — `allow: ["*"]` "widens to every tool the registry exposes" is exactly the behaviour that
was wrong — and two more were corrected for the new fixture count without weakening either.

`verify-agent-api.mjs` **243 → 251**. Every gate green: release 195/195, client 116/116, config panel
34/34, version discipline 12/12, package 44/44, preset 23/23. Record:
`evidence/0.2.17-agent-api-exposure/FIX-WITHHELD.md`.

**Not released, and the reason matters for delivery:** the menu change is client-only and was hot
delivered to the installed package (a refresh shows it), but this fix is a HOST module change — it
needs a release, a reinstall and a **restart** before it is live. The post-restart re-test of
`PTC-LIVE.md` §3 was listed in `FIX-WITHHELD.md` §6 — **Round 12 closed it on 2026-10-06.**
---

# Round 12 (2026-10-06) — 0.2.18 的 ptc 复测：三条判据全过，缺的那条不变量由外部证据闭合

## R12.1 欠的是什么，以及它只能在一个 ptc 会话里还

`FIX-WITHHELD.md` §6 与 `PTC-LIVE.md` §3 记的待办是同一件事：0.2.18 的 ptc 清单修复当时**只有门禁证据**
（stub 按 scope 返回不同集合），没有在真实 ptc 会话里跑过；`archive/20261006-0912-0.2.18-release/REPORT.md`
§5.4 也把它列为"仍未验的一半"。判据是**呈现为 ptc 的会话**，不是"一个 Dev 任务"（`taste.md` §19）——
本轮由用户指定的三条判据表驱动，跑在一个真实 ptc 会话里，欠账就此关闭。

## R12.2 会话与环境（从字节读出，不是自述）

| 项 | 读数 |
|---|---|
| 会话 | `session-e2149cbe-2566-4b12-a793-5491c324dcfe`，`agentPreset: "rdev"`（`preset-rdev` 声明 `mode: ptc`），`createdAt` = 2026-10-06 11:02:04 |
| 身份核对 | 该会话日志里能解出本轮独有的探针串 `set(withheld) == set(not_dispatchable`，同工作区的 `dev` 会话里没有（后者只含文档原文） |
| 安装 | `newmark2dsh@0.2.18`（实体目录）；`cordis.patch.yml` `1993b77b…`、`components/agent-api/component.js` `0513449a…`、`index.js` `ebc863cb…` 三者与工作区**逐字节相同** |
| 运行中的代码 | `dispatch` / `not_dispatchable` 在 0.2.17 上不存在 —— 字段出现本身即"运行的是 0.2.18"的判据（0.2.18 REPORT §5.1 用同一判据识破过一次假重启） |

## R12.3 三条判据

| 调用 | 期望 | 实测 |
|---|---|---|
| `agent_api_catalog` | `dispatch: "process"`、`not_dispatchable` 非空、仍列该会话暴露 | `exit 0`；`scope conversation` / `presentation ptc` / `total 47`（= 会话暴露）/ `dispatch process` / `not_dispatchable` **32** |
| `agent_api_send { tools: { allow: ["*"] } }` | `tool_names` 只含进程层可达项；`withheld.count` = 会话暴露 − 进程层 − 4 − `run_code`（0.2.17 实测 **31**） | `exit 0`、`stop_reason "stop"`、`output "OK"`；`tool_scope conversation` / `tool_reach process`；`tool_names` **11**（9 个 `memory_lab_*` + `computer_use` + `screen_capture`）；`tools_withheld.count` **31**、`names` 31 条、`why` 非空 |
| `agent_api_tool { tool: "memory_lab_query" }` | 仍 `exit 0` | `exit 0`、`dispatched "memory_lab_query"`、真实值（`scanned 22278`、1 条命中） |

**31 在 0.2.17 上也是 31** —— 修复没有改变被减掉的数量，只改变了被列出的那一边（42 → 11）。这正是
"改清单、不改 reach" 应有的形状。

## R12.4 修复的证明不是回执自证：三条外部闭合

`tools_withheld.count` 由**被检验的那段代码**写出，单独看它就是自证。本轮用三件不读它自己的事把它钉住：

1. **算术恒等式**：`47（catalog.total） − 4 − 1（run_code） − 11（tool_names） = 31`，左边每个数由另一次调用独立报出。
2. **集合恒等式**：`tools_withheld.names` 与 `agent_api_catalog.not_dispatchable \ {run_code}` **逐项相等**（各 31 条，两个入口分别生成），且 `tool_names ∩ not_dispatchable = ∅`。
3. **两侧各一次真实派发**：被列出的 `computer_use`（`mode_report`）→ `exit 0`；被减掉的 `read` → `exit 2 / unknown_tool`，而 `read` 通过**会话自己的传输确实可达**（同一轮读到了 `VERSION.md`，66 行）。

第 3 条是 `tools_withheld.why` 那句话的实测对照 —— *"visible to the calling conversation but not in the layer
this run executes in"*：可见与可达是两件事，这一轮把它们分开了。

## R12.5 File tree delta

```
Newmark2DSH/
├── README.md, OVERVIEW.md, taste.md                        [D] status closed; this round; §23
└── archive/20261006-112036-0.2.18-ptc-retest/
    ├── record.md                                           [D] NEW: what was done, the three verdicts, the conflict
    ├── evidence/receipts.md                                [D] NEW: the envelopes verbatim + the closure arithmetic
    ├── before/                                             [D] NEW: README / OVERVIEW / taste (+ a snapshot of the concurrently-edited FIX-WITHHELD.md)
    └── after/                                              [D] NEW: the same files after this round
```

## R12.6 版本：没有步进，也不该有

本轮**没有改一行代码**，只做了在线复核，所以 `VERSION.md` 不动 —— 台账记的是**发布**，不是编辑次数
（版本号约束一节与 R5.6）。0.2.18 当时仍是安装并运行的版本。

## R12.7 与并发的另一次写入的冲突（如实记录）

测量窗口内**另一个会话**正在同一棵树上准备下一次发布：11:26:54 `scripts/verify-agent-api.mjs`、
11:30:33 `components/agent-api/component.js`、11:33:25 一份新的 `tool-output-boundary` 回执、
11:34:33 `FIX-WITHHELD.md`（91 → 133 行，新增 §0 与 §7）、11:39:34 四个 `package.json`、11:40:03 `VERSION.md`
（新增 `0.2.19` 行）。那个会话**正在监控本会话**：`FIX-WITHHELD.md` §0 与 `VERSION.md` 的 0.2.19 行
描述的四次派发就是本轮的探针，它由此发现并修了一处真实缺陷（`agent_api_tool` 的答案没有报出
`scope`/`presentation`/`dispatch`，而描述自 0.2.17 起承诺了 `presentation`）。

处置与边界，写在明处：

- **本轮没有写 `FIX-WITHHELD.md`** —— 它当时正被另一个写入者改，写它就是一次 write-write 冲突；它的 §0
  已经把复测结论记全。本轮只补上它没有的两件：**原始回执**与**两侧各一次真实派发的对照**（在 archive 里）。
- **回执描述的是"正在运行的那一代"**（0.2.18）。工作区此后已改到 0.2.19，这不改变已测事实，但**新版本
  装好并重启后必须重测** —— 判据是"呈现为 ptc 的会话"，不是某一次会话。
- 交付给下一个写入者的一句话：**在同一个文件上并发写入时，"谁写哪一节"要在记录里点名**，否则两次
  编辑都合法、合起来却读不出谁负责哪一段。

## R12.8 Still open, stated plainly

- **路由那一半仍无线上证据**：`/newmark-agent-api/state` 与 `/catalog` 仍 403（与 R10.6 相同）。
- **`dev` 会话本身仍未开过**：两个预设都声明 `ptc` 的等价性是实测的，但本轮用的是 `rdev`。
- **一次复测不是不变量**：这三条判据绑在 0.2.18 的那次安装上；0.2.19 起需要在新的 ptc 会话里重跑。
- **`parent` 是未校验 `Symbol` 这一条仍未利用**（`PTC-LIVE.md` §4.4）—— 记录，不利用。


## 2026-10-06 transport 诊断修复与证据树

- `Newmark2DSH/packages/newmark-core/components/agent-api/lib/llm-seam.js`：三条异常路径使用原始错误的 failureText，保留嵌套原因；不能恢复宿主已丢弃的原因。
- `Newmark2DSH/scripts/verify-agent-api.mjs`：新增即时拒绝、流异常、工具调用后流异常三条行为回归；最后一条同时验证单次派发。
- `Newmark2DSH/archive/20261006-232444-transport-audit/`：`REPORT.md` 结论和边界；`scan.mjs` 只读多帧解码器；`transport-events.json` 失败元数据；`session-summary.json` 真实智能体预设映射与事件计数；`scan-output.txt` 扫描输出；`probe-shipped-error.mjs` 使用实际安装版 LlmError 的无网络探针；`shipped-error-probe.json` 序列化前后对照；`gate-before.txt`/`gate-after.txt` 回归前后；`core-gate.txt` 总门禁；`preset-gate.txt` 预设门禁；`before/`/`after/` 本轮触及文件快照；`scoped-diff.patch` 相对于本轮开始快照的代码差异；`after-manifest.json` 快照 SHA-256。
- 验证：Agent API 268/268，总门禁 195/195，预设 23/23。339 次 TRANSPORT 失败尝试跨 rDev/Dev/cordis，322 条重试，17 次失败收尾；一个压缩帧解码失败。历史 cause 已丢失，网络或服务端根因未确定。本轮源码修复未安装、未发布，既有 0.2.20 候选改动保留。

## 2026-10-06 电脑控制 transport 复测

通过原生电脑控制在 DSH Desktop 2.0.17 / newmark2dsh 0.2.19 实测：开始时插件实际关闭；空白会话短文本测试 19 秒成功。临时启用插件后，正确加载的 rDev 空白会话同一提示 18 秒成功，两轮均无可见重试或工具调用。测试后恢复插件关闭状态。未复现当前断流，不能据两次成功排除间歇故障；关闭插件时保留的 rdev 标识不等于加载了该预设。

页面另观察到 Agent API 显示“已启用 / not loaded”，尚未确认是否真实挂载故障，也未证明与 TRANSPORT 有关。操作及边界见 `Newmark2DSH/archive/20261006-235200-computer-use-transport/REPORT.md`；该目录的 before/after 保存六份文档快照。两条测试会话保留供复核；没有重启、安装或部署源码。

## 2026-10-07 Newmark2DSH 安装修复状态与证据树

Newmark2DSH当前源码/安装均0.2.22，DSH Desktop2.0.17运行，四组件全启用；核心195/195、客户端119/119和实际模型/工具验收通过。原自动监控newmark2dsh-transport-debug已按用户要求删除；外部TLS间歇断开以一次性长任务验收记录为准。详细边界以安装debug报告为准。

新增 `Newmark2DSH/archive/20261007-101037-installed-debug/`：REPORT.md说明目标、最终状态、归因边界和回退；before/after保存六份项目文档及源码快照；installed-before/保存原安装包/本机profile/DSH adapter，仅供本机回退；candidate/保存tgz和干净安装；scratch/是Agent API显式测试工作区；runtime-evidence.json含实际PTC工具回执和TLS重试，extract-runtime.mjs提取它；hash-installed.mjs及installed-hashes.json逐项证明42安装文件与源码一致；monitor-transport.mjs为增量只读故障检查，monitor-state.json为游标，monitor-latest.json为最近结果；ui-*.jpg/txt保存真实电脑控制截图和访问树；其余gate/install/probe文本保留失败及通过过程。candidate中的0.2.22 tgz目前被实际profile依赖引用，不可作为可删冷文件处理。本机profile快照不上传。


## 2026-10-07 一次性全工具与长上下文 heavy 验收

按用户要求删除持续监控，一次性验收已结束。安装0.2.22全部15插件工具连续1416调用零失败；42测试文件与实际安装哈希一致。旧长会话第30轮62工具调用正常completed，跨上下文压缩继续完成5项真实模型任务，独立计算全正确、计数及租约归零。1070条安装版重试/取消函数用例通过。5次连接故障由宿主自动恢复，没有人工停止或重发。历史native会话没有run_code，JS验收由独立CLI补齐，不冒称会话内执行。详情见 Newmark2DSH/archive/20261007-oneshot-heavy/REPORT.md。

新增 Newmark2DSH/archive/20261007-oneshot-heavy/：REPORT.md为最终验收和边界；installed-all-tools.mjs与mount-installed-fixture.mjs执行隔离完整套件，installed-all-tools*.json/txt留存夹具拒绝与最终通过；installed-fixture/为安装包副本，isolated-newmark*/和isolated-work/为测试库；fixture-hashes/verification和verify-evidence记录42文件哈希及状态；extract-heavy及heavy-runtime-evidence/summary记录真实62调用和完成；verify-heavy-models与heavy-model-verification核对5真实结果；verify-installed-contracts与installed-contract-verification记录1070实际函数用例；heavy-run/包含真实会话产物，ui-completed.jpg/txt为完成界面；before/after/为文档快照。全文件作用和运行边界详见该目录REPORT.md。


## 2026-10-07 新发重试耗尽与限定连接修复

新发TLS连接失败耗尽5次重试已复现。为本机DSH Desktop 2.0.17的官方Messages精确origin https://api.deepseek.com安装可回退直连覆盖，使用同版本Undici fetch/dispatcher，保留TLS校验、取消、其他路由和全部插件能力；插件源码/安装仍0.2.22，未发布。初版dispatcher跨运行时兼容错误已由实机发现并修正。原失败长会话第10轮11工具调用正常completed、重试0，五项真实模型结果独立计算全正确，计数归零。限定origin20无凭据请求、非目标origin和取消用例通过。代理随后也曾恢复，不能称为永久代理故障或证明rDev因果。详见 Newmark2DSH/archive/20261007-1410-transport-exhausted/REPORT.md；持续监控保持删除。

归档包含REPORT.md最终边界、before/after/文档及宿主补丁快照、extract.mjs及heavy-runtime-evidence/summary/events-summary原生失败与完成事件、probe-routes与route-probes路由对照、install-route-fix/installed-route-fix安装和哈希、test-route-fix/route-fix-tests范围及取消行为验证、rollback-route-fix带哈希保护的回退、model-runs/RUNTIME/workspace真实任务回执、model-verification独立计算、ui-before/after实机界面；manifest记录最终快照哈希。宿主lib/newmark-transport-route.js与json为本机限定路径覆盖，不包含在插件包内。


## 2026-10-07 连接补丁后功能无损伤复核

连接补丁后的功能无损伤复核通过：安装0.2.22全部42文件与连接修复前逐项哈希一致且匹配源码；核心195/195、客户端119/119、Agent API268/268、Dev/rDev23/23和实际安装market兼容通过。全15插件工具连续1416调用零失败、零漏测，100模型夹具运行后activeRuns/retainedMessages为0，CU租约free。宿主adapter只改import与Messages fetch函数，鉴权/图像工具序列化/SSE/取消/重试代码逐字未改，其他origin参数与response原样传递。详情 Newmark2DSH/archive/20261007-function-integrity/REPORT.md；实际模型结果以此前1410归档为证。本轮未动生产记忆/源码、未重启或发布、不持续监控。

新归档含verify-integrity/plugin-integrity安装哈希，core/client/api/presets/market门禁，installed-all-tools和mount-installed-fixture全工具套件及回执，installed-fixture安装副本、isolated-newmark-accepted/isolated-work隔离库，verify-evidence与fixture-hashes/verification副本计数，verify-transport-invariance/transport-invariance宿主不变性，before/after与after-manifest文档快照。每项作用和测试范围见REPORT.md。

## 2026-10-08 NewMate 动画与同步候选

本轮改动范围为 Newmark2DSH，源码已实现并完成 297 项验证，未部署至生产 DSH。项目目标保持真实/虚拟输入隔离、原进程状态保留及空黑虚拟桌面。

- `packages/newmark-core/components/computeruse/lib/desktop-pet.cs`：DXGI 输出同步时钟、单待处理帧、解除捕获和取帧固定延时、同步诊断。
- 同目录 `desktop-transfer.cs`：Windows 映射采集/绘制使用显示器节拍。
- 同目录 `linux-desktop.py`：OpenGL 绘制与交换调度、独立 X11 采集线程、最新帧槽、纹理复用、按刷新率更新映射。
- 同目录 `linux-desktop.js`：WSLg D3D12 桥接库路径与驱动选择，保留用户显式覆盖。
- `scripts/measure-windows-animation.mjs` 与 `scripts/lib/desktop-animation-meter.cs`：隔离真实 NewMate 原生绘制回调和 CPU 测量。
- `scripts/measure-linux-animation.py`：相同 Qt 事件循环的源码/基线分阶段测量。
- `scripts/lib/desktop-pet-gpu-probe.cs`：等待弹簧完成后断言精确全屏，避免把 99.9% 中间态当完成态。
- `scripts/verify-linux-newmate.py`：独立输出目录，新增真实窗口更新、纹理清理、采集线程退出检查。
- `docs/06-linux-desktop.md`：Linux 显示同步与 WSLg 的验证边界。
- `archive/20261008-animation-vsync/`：REPORT.md 汇总、before/after 源码文档快照、manifest 哈希、Windows 原生与 Linux GUI/后端测试回执、计时 JSON、截图。子目录和测量失败过程逐项见 REPORT.md。

以上相对路径以 Newmark2DSH 为根；Windows 本机回调约 150 FPS，165 Hz 输出同步；WSLg 约 60 Hz。不能把 Qt swap 完成、浏览器 rAF 或原生绘制回调直接当作物理显示帧。

### 0.2.31 新增实现与验收文件

- components/computeruse/lib/desktop-transfer.cs：独立线程池控制心跳与显示同步绘制，分别保障退出/保活和动画。
- scripts/verify-desktop-transfer-pacing.mjs、scripts/lib/desktop-transfer-pacing-probe.cs：主动停显式绘制时钟，验证原生状态心跳、返回命令与原窗口存活。
- scripts/verify-failure-log.mjs：复制安装包链接时显式 dereference，破坏性故障注入只修改临时副本。
- scripts/verify-linux-newmate.py、measure-linux-animation.py、measure-windows-animation.mjs：支持直接定位实际安装包。
- archive/20261008-release-030/：中间0.2.30发布、失败原始日志、安装QA树、初始回归修复与心跳注入实验；prepare/prepare-qa/native-gates脚本保留复现过程。
- archive/20261008-release-031/：最终远端checkout、tarball、发布回执、双平台哈希、DSH进程替换、全部安装态门禁、性能与最终状态；REPORT.md逐项解释子目录，docs-before/和after/保存文档与源码快照。

相对路径以Newmark2DSH为根；公共发布仓库独立提交，未提交或重置父工作区。

## 2026-10-08 官方宿主适配核查（进行中）
此前社区版验收不能作为官方宿主兼容性结论。官方版 0.2.0-rc.2 / pnpm 11.7.0 已核实；发现 latest=0.2.32 而实际安装0.2.26，默认24小时发布年龄筛选及多源/缓存解析正在隔离核查。MemoryLab host 失载尚未修复。目录与证据见 archive/20261008-official-compat/REPORT.md。后续必须以官方宿主、实际注册表安装和运行态回执验收。

### 纯净官方客户端约束（取代端侧安装方案）
用户要求纯净官方 DSH 输入包名即安装 latest，旧版本只按显式版本请求安装。端侧安装脚本已撤销；本轮新增包级年龄例外已撤回。远端 latest 正确，但官方 pnpm 默认24小时过滤不能由插件包配置覆盖。0.2.33仅为未发布候选；发布端标签校验不能视作P0修复。MemoryLab首次打开读取宿主快照专项11/11通过。完整边界见 archive/20261008-official-compat/REPORT.md。

## 2026-10-08 Newmark Core 更新区（0.2.37 已推送）

配置栏末尾提供统一更新入口，三个组件依托Core更新。最新修订移除新增更新区外框、底色与状态分割线，保留留白及响应式对齐。按钮检查官方dist-tags、精确版本与安装结果，并处理空响应、HTML、401/403、404/405及标签缓存落后时的防降级。更新与位置68/68、配置样式34/34、客户端119/119、首次打开11/11、版本12/12通过；完整更新套件曾195/195，0.2.36新媒体查询触发的旧CSS扫描器误报已在专项目录修正并验证。

源码和标签v0.2.37已推送，提交e02b5a5；npm发布状态与安装回执以archive/20261008-core-update/REPORT.md为准，不将tag推送视作所有镜像已同步。本机官方管理器安装0.2.33成功；随后0.2.36安装因网络与宿主旧锁文件发布年龄策略失败，未宣称已安装新版。纯净宿主首次包名安装P0仍受宿主策略影响。

文件结构：packages/newmark-core/lib/core-update.js为官方标签与版本信息读取；index.js新增只读更新发现路由；client.js提供可选管理子插件、统一更新入口与配置末尾无框布局。scripts/verify-core-update.mjs覆盖异常响应、版本身份、并发、安装结果与布局位置；verify-memorylab-first-open.mjs覆盖热安装后首次读取。配置CSS门禁识别媒体查询并检查内部选择器。归档目录保存before源码、首次失败和修复门禁日志、官方安装回执、发布记录及隔离布局图片。


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

archive/20261009-startup-real-retest/：实际完整进程重启验收归档；REPORT.md 说明结果和文件职责，measure-startup.ps1 记录三次退出/启动，actual/ 存放原始日志与 timings.json，probe.cjs 检查宿主和安装标签一致性，live.json 保存脱敏结果。最终 PID 40324，运行 0.2.39。

### 2026-10-11 用户补充后的最终设计范围

newMate以授权本地文件事件、元数据和必要差分作稀疏测量，默认消极主动响应：无变化不后台思考，无关变化不读正文，有意义才调用Agent API，有必要才唤起DSH本体对话。定制陪伴以MemoryLab确认为权威来源；自主链硬禁止删除文件及间接删除。CU读屏只作可选任务辅助。宿主真实会话创建/消息投递/导航契约待核实，不以API临时run或桌宠气泡冒充。设计、工具与文件结构均未实现。

## 2026-10-13 macOS 隔离与 Neo 最低档评估

用户暂停 Space 实现并要求评估，最低部署基线为 MacBook Neo A18 Pro／8GB。Space 不提供独立输入，另用户虚拟显示会话具有原生操作分离的官方依据，但本项目同机接入未验收；VM 系统边界更强，资源开销以测前预算记录。此次仅写评估，不改CU源码、版本、安装或发布。详见[比较与容量预算](docs/12-macos-spaces-vm-assessment.md)。

新增 docs/12-macos-spaces-vm-assessment.md：区分Space、独立GUI会话、Linux/macOS VM，保存Neo官方规格、原生操作隔离依据、资源估算假设及验收指标；archive/20261013-macos-isolation-assessment保存本次文档前后快照。


## 2026-10-14 GitHub 产品首页整理

README.md 按定位、场景、五组件详解、Dev/rDev、快速开始、平台、数据协作、结构、版本、许可重构。taste.md 新增持续适用的 README 格式契约。旧首页中的组件数量、外置依赖安装和历史候选叙述不再作为当前使用说明；原文完整保存在本地 before 快照中。本次仅修改文档与 GitHub About，不改变 0.3.14 运行版本。

新增 archive/20261014-101338-readme-product/：before/ 保存子项目、父项目与公开仓库的文档基线；after/ 保存最终文档；public-repo/ 为本轮隔离公开仓库 checkout；README.new.md 与 README-style.md 分别为首页与格式契约草稿；update-docs.mjs 为同步入口；verify-docs.mjs 为静态复核；verification.json、publication.json、REPORT.md 记录检查、提交及边界。README 的公开目录树与本地 packages/newmark-core 布局明确区分。

交付已核对：公开 main 提交 d6f4522；README/OVERVIEW/taste 三份远端正文与提交逐字节一致，About 已同步五组件与 Dev/rDev。archive/20261014-101338-readme-product/verify-publication.mjs 负责远端 ref、正文、About 和干净 checkout 核对，publication.json 为提交/散列回执；REPORT.md 汇总本轮结论和边界。


## 2026-10-14 README 润色与远端读校验

README 保留五组件首页结构，简化术语、完善工具全名，增加阅读导航；taste 补充导航、术语与推送后读校验要求。仅修改文档，运行版本保持 0.3.14。

archive/20261014-102246-readme-polish/：before/ 与 after/ 保存三组治理文档；polish.mjs 保存逐项文案修改；readback.mjs 负责结构和远端正文/渲染核对；readback.json 保存提交、散列与检查结果；github-readme.html 是取回的 GitHub 渲染正文；REPORT.md 记录润色、推送和读校验结论。复用上一轮干净的公开 checkout。

本轮已推送 main 5ccf3cb，并按该提交取回 README/OVERVIEW/taste 全文核对一致；GitHub 渲染 HTML 的 9 个二级标题、5 个组件标题、4 张表格、3 个代码块及 7 个导航锚点检查通过。remote-README.md 为最终远端原文，具体散列及边界见 readback.json/REPORT.md。


## 2026-10-14 历史 CHANGELOG 归档

公开根目录 18 份 CHANGELOG 已移入其被忽略的 archive/20261014-104450-changelogs/，并另保存在本项目 archive/20261014-104450-changelog-archive/changelogs/。README 改用 Releases；taste 固化归档与忽略约束。操作目录的 before/、after/ 保存治理文档，archive-changelogs.mjs 为操作入口，inventory.json 为逐文件散列，verify.mjs 与 readback.json 为公开树/忽略/远端正文验证，REPORT.md 为结论。版本、标签与旧 Git 历史不变。


## 2026-10-17 Dev／rDev 预设提示词变量断点修复（0.3.15）

**故障。** 官方 Electron 安装于 2026-10-17 12:49:18 更新到 `@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.1（`app.asar` 182,720,179 B）之后，用户以 rDev 预设新建的会话每一轮都在提示词组装阶段结束，模型一次未被调用。两条会话的尾部事件逐字相同：`turn/end reason={"kind":"error","error":{"message":"unknown prompt variable \"{{cwd}}\" in section \"deployment:persona-suffix\"; registered variables: provider, model","code":"UNKNOWN"}}`。用 `scripts/probe-session-log.mjs` 逐帧读取（单帧解压只会得到第一帧）：`session-9a5ad69d` 968 B / 4 帧 / 解压 1,450 B / 10 行 / `agentPreset: "rdev"` / 第 1 轮即死；`session-ffcf33d6` 7,796,984 B / 5 帧 / 解压 57,938,924 B / 17,870 行 / 第 104 轮死。两者 cwd 均为 `C:\Users\12252\Desktop\Files\Code\Minecraft Forge Workspace`。

**为什么挂载审计没抓到。** 预设一直是挂载成功的：`evidence/20261017-preset-break/repro.md` 在真实组合的副本上读到 `dev` 31 行 / 25 启用、`rdev` 30 / 23，`broken: null`、无泄漏服务、`retain()` 成功，且同一夹具对故意注入的坏行仍能报出 `never started` —— 阴性结论是测量，不是盲区。`parity.md` 逐行/逐 schema 审计同样没有挂载级断点，并纠正了共享探针的 asar 数据起点（正确值为 `8 + headerBufLen`，旧值 `16 + jsonLen` 使每次抽取头部错 2 字节、尾部截 2 字节）。

**原因与修复。** 0.2.1-rc.1 只注册 `provider`、`model` 两个提示词变量（`dsh-agent-loop/lib/index.js:1591-1592`）；`persona` 的 `suffix` 进入 `deployment:persona-suffix` 并解析变量（`dsh-persona/README.md:41,99`），未注册的名字在 `dsh-system-prompt/lib/index.js:174` 抛出，整轮终止。这正是与官方的差距：本包按 0.2.0-rc.2 编写，其 `presets/cordis.patch.yml:16` 有 `suffix: Your working directory is {{cwd}}.`；0.2.1-rc.1 的四份预设已删掉该行。修复只删不写：`preset-dev` 与 `preset-rdev` 的 `suffix` 行从 `packages/newmark-core/cordis.patch.yml`、已安装副本 `~/.dsh/profiles/desktop/node_modules/newmark2dsh/cordis.patch.yml`、以及 profile 中覆盖用的 `preset-dev`（`~/.dsh/profiles/desktop/cordis.patch.yml`）三处移除，均以注释记录原因；工作目录仍由运行时上下文提供。本轮无组件代码改动。

**版本与门禁。** 0.3.15 为 `patch+1`（`minor` 不变，未新增子组件），登记 kind `core`；六个清单（顶层 + `components/` 目录发现的五个）版本一致，`verify-version-discipline.mjs` 12/0 通过；`verify-preset-patch.mjs` 23/0 通过。`measure-dev-rdev-mutations.mjs` **未跑完**：Lead 于 15:43:54 启动，16:00 因首个植入变异（`tool-drift`）之后持续 16 分钟、且受跟踪的 patch 一直处于改写状态而终止，没有捕获到任何断言行，因此不宣称通过；它守护的性质（Dev/rDev 只差三条创造模式行）不受本次修复影响——修复对称地删掉两个 persona 行上的同一个 config 键，声明形状另有 `verify-preset-patch.mjs` 与 parity 审计覆盖。被该门禁改写的源 patch 已由已安装副本恢复，双方 sha256 一致（`ED9F6FFF…E228EB6`）。**未宣称的边界**：Dev/rDev 一轮真实对话产出模型步骤属重启后验收，本记录只证明声明不再插值宿主未注册的变量；npm latest 仍为 0.3.14，本轮不宣称已发布。

**本轮文件。** 新增 `scripts/probe-asar.mjs`（只读 asar list/cat/grep，数据起点 `8 + headerBufLen`）与 `scripts/probe-session-log.mjs`（逐帧扫描并解压会话日志，输出帧数、压缩/解压字节、行数与 `tornStart`）；证据目录 `evidence/20261017-preset-break/`（repro.md、parity.md 与 8 份 raw 捕获）。归档 `archive/20261017-155232-preset-cwd-fix/`：`RESULT.md` 为结论与回执；`before/` 存修复前声明（插件副本 `plugin-cordis.patch.yml`、profile 的 `preset-dev` 片段 `profile-preset-dev.patch.yml`，前者是调查期副本，差异在 RESULT.md 列明）；`after/` 存三处修复后字节（插件源、已安装副本、profile 片段）；`logs/` 存两条失败会话的 header 行、尾部 6 行与帧统计。
