# 交接：桌宠白底/闪烁修复 + heartbeat 两阶段重启收尾（2026-10-17）

读者：接手的新会话 / 工程师。本文是**工作交接**，不是设计文档；设计在
`docs/09-newmate-heartbeat-implementation.md` 与 MemoryLab 组件
`Newmark2DSH heartbeat 两阶段重启（广播+回执屏障）设计`（revision 3）。

## 0. 前置与边界

- **本机现状**：`newmark2dsh` 已安装 **0.3.16**（`~/.dsh/profiles/desktop/node_modules/newmark2dsh`，与
  `packages/newmark-core` 逐字节一致），两阶段重启已在活体上验证；DSH 已重启，预设正常挂载。
- **接手会话必须有** `pwsh`/`read`/`write`/`edit`/`glob`/`grep`（挂载了预设的会话）。若工具目录只有
  newmark 插件层工具（42 个、无 shell），说明是"空壳会话"，**停下来换会话**，不要用 computer_use / MemoryLab 冒充文件 IO。
- **不要**运行 `measure-dev-rdev-mutations.mjs`（会挂起 >15 min 并长时间把被跟踪文件留在变异态）。
- **不要**改 Dev/rDev 预设声明与 profile 里的 `preset-dev`（2026-10-17 刚修好，见
  `evidence/20261017-preset-break/ROOT-CAUSE.md`）。
- `~/.Newmark` 是生产库，除本任务明说的写操作外**只读**；不要删会话、archive、plugin-manager 日志。
- 版本规则见 `VERSION.md`「Newmark2DSH 版本号约束」：无新子组件 → **patch +1**，即本轮目标是 **0.3.17**。

---

## 1. 工作项 A：桌宠"白底 + 主体闪烁"（**未修**，已测准）

### A.1 现象与已测事实（完整数据见 `evidence/20261017-pet-render/measurements.md`）

| 状态 | 同一窗口矩形 (2358,1327,178×153) 的 BitBlt 裁剪统计 | 证据 |
|---|---|---|
| 故障态 | mean **254.4**，6853 px 中 **6181 px 纯白 255**，仅 32 色 → 屏幕上一块白板 | `evidence/20261017-pet-render/pet-white-plate-4x.png`、`screen-broken-full.png` |
| 正常态 | mean **75.4**，**468** 色，白色方块本体+双眼清晰可见、四周透出桌面 | `evidence/20261017-pet-render/pet-render-ok-4x.png`、`screen-ok-full.png` |

**因果链（已测得）**：白板状态持续 ≥25 s 且四帧同哈希；唯一变化是我运行
`verify-desktop-pet.mjs` 触发了一次真实拖拽 → `Tick()` 判 `moving` → 调用 `Render()` → 白板消失。
根因方向：`components/computeruse/lib/desktop-pet.cs` 的 `Render()`（L784-799，`UpdateLayeredWindow`）
**只在** `Tick()` 的 `moving || (cu && !anyExpanded)` 条件下被调用（L767）；本机 `cu=false`（陪伴模式）
且静止时几乎不重绘，于是一次错误合成会一直卡在屏幕上，而每次重绘时看起来又在"闪"。

### A.2 已排除（不要重复走）

1. 二进制过期：`sha256(desktop-pet.cs ‖ desktop-menu.cs ‖ vendor/webview2 三个 DLL)[:20]` = 正在运行的
   `eeb5f4bf5e21ccbb5818`。
2. 贴图白底：`assets/desktop-pet.png` 不透明纯白 0 px（A=0 1,139,148 / A=255 仅 1,554 / 部分透明 432,342）。
3. outline 描边动画：需 `cu && !anyExpanded`（L788-790），未执行。
4. `DesktopViewer`（标题 "Newmark Virtual Desktop — Read Only"，L272-331）是另一个窗口。
5. **PrintWindow 读数不可用于外观判断**：它给 ULW 窗口返回伪造背景（239–240 = `SystemColors.Control`）；
   判白底只能用 BitBlt 裁剪。

### A.3 接手第一件事：**先复现，再修**

1. 复现配方见 `evidence/20261017-pet-render/measurements.md` §复现与验证配方
   （重启宠物 → t0/+200 ms/+1 s/+5 s 四次 BitBlt 裁剪统计 → 同时读 `status.json`）。
2. 判据：任一采样点"纯白占比 > 80%"即复现成功，并记录当时的 `paint_bounds` / `size_multiplier`。
3. 只有复现成功后才改代码。两个候选根因：
   - **A-首帧/尺寸**：`PetSpring stretchX=0.18, stretchY=0.08` 初值（L392）与 `BuildBody` 的
     `Size=body+2*padding`（L469-470）在 200% DPI 下的交互 → `Render()` 用 `w=body.Width*sx` 画进 surface（L793-794）。
   - **B-表面 alpha**：`PetSurface` 用 **BI_RGB** 32bpp DIB + `Format32bppPArgb` 包装（L143-148），
     经 `g.Clear(Transparent)` + `DrawImage` 后再 ULW(AC_SRC_ALPHA)（L798）。判定的办法是把 surface 字节
     dump 出来看 alpha 直方图（临时加调试输出即可，宠物 exe 是按源码 sha 缓存编译的，改源码会自动重建到新 `bin/<hash>`）。
4. 修复候选（按复现结果择一或并用）：
   - 启动后**强制重绘至首帧确认**（例如前 N 个 tick 或前 1 s 内持续 `Render()`）；
   - 陪伴模式（`cu=false`）也保持低频保活重绘（如 1–5 s 一次 ULW），或至少在尺寸/缩放/DPI 变化后连画若干帧；
   - 若证实是 BI_RGB/GDI+ alpha：改为在托管 `Bitmap(Format32bppPArgb)` 上合成后**拷贝字节进 DIB**，或改用 BI_BITFIELDS。

### A.4 必须补的门禁（它长期没被发现的原因）

- **新增像素级透明门禁**：BitBlt 裁剪宠物窗口 → 角点像素必须等于其后方桌面像素；"纯白占比 > 阈值"判红。
  现有 `verify-desktop-pet.mjs` 的 "transparent corner passes through" 用的是 `WindowFromPoint` **命中测试**
  （`scripts/lib/desktop-pet-driver.ps1:53-55`），不是像素透明度，所以白板也能 PASS。
- **新增"陪伴模式保活重绘/首帧确认"断言**：静止 `cu=false` 时，若发生一次错误合成，必须能自我纠正。
- 既有失败与坏门禁（一并处理或明确登记）：
  - `verify-desktop-pet.mjs` 现 **10/12**：`FAIL virtual startup does not activate a desktop window`（真实失败）；
    `FAIL native acceptance completes` 是本机 occluded 环境（"Input target is occluded; refusing physical mouse input"）。
  - `verify-desktop-pet-gpu.mjs` **直接崩**：`TypeError ERR_INVALID_ARG_TYPE: paths[0] must be string, received undefined`
    （脚本第 2 行 `path.resolve(process.argv[2])` 之类，需要参数或默认值）。
- 每个新断言都要有能变红的 planted mutation，并字节还原。

### A.5 交付

- 代码：`components/computeruse/lib/desktop-pet.cs`（必要时 `desktop-pet.js` 的启动/编译参数）；
- 门禁：上述两条新断言 + 修好 `verify-desktop-pet-gpu.mjs`；
- 证据：修复前/后**同一采样序列**的截图与统计（存 `evidence/<日期>-pet-render/`）；
- 写回：`VERSION.md`（0.3.17 行）、`README.md`、`OVERVIEW.md`、`taste.md`（"视觉属性必须有像素级门禁，
  命中测试不等于渲染正确" 一类规则）、`archive/<时间戳>-pet-white-plate/`；
- 版本 0.3.16 → **0.3.17**，六个 manifest 同步（`verify-version-discipline.mjs` 会逐个比对）。

---

## 2. 工作项 B：heartbeat 两阶段重启的四个尾巴（0.3.16 已上线）

1. **缺独立"取消"**：目前取消 = 不 commit / 提交一次必然缺回执的 commit / 等过期。建议加
   `heartbeat_restart_cancel { intentId }`（一行状态转换 `preparing → aborted(reason:'cancelled')` + 通知 requester），
   并加门禁：取消后 barrier 重开、intent 不再可 commit。
2. **`status.json` 的 `failed` armed 任务既不投递也永不回收**，会持续累积（0.3.16 实测一次重启后 8 条）。
   需要终止策略：投递失败 N 次后终结为 `failed(final)` 并写明原因，且 `status` 里能看到终结记录；
   与 `delivery.tasks` 的 committed 清扫路径对齐。
3. **证据边界要保住**：`ackMode:'agent'`、`onTimeout:'proceed'`、`force`、"不回执参与者 → aborted"
   目前只有**门禁级**证据（宿主内无法再造一个活着但不回执的对话）。VERSION.md/OVERVIEW 必须保留这句限定，
   不要把门禁证据写成活体证据。
4. **文档与 git 的冲突（用户已定调）**：`.gitignore` L62 `archive/`、L66 `OVERVIEW.md` → 这两者保持**不发布**；
   做法是把归档目录路径 + 逐文件 sha256 引用进**被跟踪**的 `VERSION.md`，让审计链在仓库内可追。
   **不要**加 `!` 否定规则破坏"archive 从不发布"的既有契约。

---

## 3. 工作项 C：门禁自身的三条失败（`verify-newmark-core.mjs` 202/3）

| 失败 | 定性 | 要做的事 |
|---|---|---|
| `activation harness passes` | **假阴性**：子门禁打印 `passed=56 failed=0 / PASS` 后**不退出**，父门禁 `execFileSync` 超时后拿子进程 stdout 末行当失败理由 | 修父门禁（用退出码/显式完成标记判定，超时单独报 `timeout`），或让子门禁正常退出 |
| `tool output boundary` | 前提缺失：需要已安装的 DSH walker | 在门禁里显式 skip 并说明前提，而不是 FAIL |
| `store gate`（MemoryLab folder-kind） | 与本轮无关的既有失败 | 定位后单独修 |

（`verify-core-restart.mjs` 在本会话 shell 里的最后一行 `assert.rejects(probeDesktop())` 失败于
"测试运行者不是 DSH 后代进程"这一前提为假，属环境相关，未削弱断言——登记即可。）

---

## 4. 验收清单（做完每项都要有回执）

- [ ] 桌宠：复现序列（修复前）→ 修复 → 同一序列（修复后）；纯白占比从 >80% 降到 0（角点透出桌面）
- [ ] 桌宠：新像素级透明门禁 + 保活重绘断言，各带能变红的 mutation
- [ ] `verify-desktop-pet.mjs` ≥ 12/12（或明确登记环境相关项）、`verify-desktop-pet-gpu.mjs` 可运行
- [ ] heartbeat：cancel 工具 + 门禁；failed armed 终止策略 + 计数不再累积
- [ ] `verify-heartbeat-restart-barrier.mjs`、`verify-preset-patch.mjs`、`verify-version-discipline.mjs`、
      `verify-newmark-core.mjs` 全绿或逐条定性
- [ ] 六个 manifest = 0.3.17；VERSION/README/OVERVIEW/taste/archive 写回
- [ ] `git commit` + `git push` + `git pull` 真往返（commit hash 三方一致：本地 HEAD、`ls-remote`、拉回后 HEAD）
- [ ] 打包 tarball 并按 plugin-manager 方式安装到 `~/.dsh/profiles/desktop`，核对已安装版本与字节
- [ ] 需要重启时用**两阶段流程**（`heartbeat_restart {broadcast:true}` → `heartbeat_restart_commit`），
      并贴出 intentId / participants / 阶段转移 / 投递回执

---

## 5. 可直接粘贴的交接 prompt

```
任务：完成 Newmark2DSH 0.3.17 —— 修桌宠白底/闪烁 + 收尾 heartbeat 两阶段重启。先读交接文档：
Newmark2DSH/docs/13-handoff-20261017-pet-and-heartbeat-tails.md（含证据目录与逐条验收清单）。

工作目录：C:\Users\12252\Desktop\Files\Code\Newmark Agent

顺序（卡住就停并汇报，不要跳步）：
1. 前置检查：确认自己有 pwsh/read/write/edit/glob/grep；没有就停下换会话。
2. 桌宠：先按 evidence/20261017-pet-render/measurements.md 的"复现与验证配方"重启宠物并逐帧 BitBlt 采样，
   拿到"纯白占比 >80%"的复现；再按文档 §A.3 的候选根因（首帧/尺寸 或 BI_RGB+PArgb 的 alpha 语义）定位并修；
   修后跑同一序列对照。新增像素级透明门禁（角点必须等于桌面、纯白占比判红）与"陪伴模式保活重绘"断言，
   各带能变红的 mutation；顺手修 verify-desktop-pet-gpu.mjs 的崩溃（path.resolve undefined）。
3. heartbeat 尾巴：加 heartbeat_restart_cancel {intentId} + 门禁；修 status.json 里 failed 的 armed 任务
   永不投递也永不回收、持续累积的问题（终止策略 + 原因记录）；VERSION/OVERVIEW 保留"agent/proceed/force/aborted
   只有门禁证据"的限定；OVERVIEW.md 与 archive/ 保持 gitignore 不发布，但把归档路径+逐文件 sha256 引用进 VERSION.md。
4. 门禁三条失败按文档 §3 分别处理（activation harness 子进程不退出是父门禁假阴性，要修门禁本身）。
5. 版本 0.3.17（六个 manifest 同步），按仓库协议写 VERSION/README/OVERVIEW/taste/archive。
6. git commit → git push → git pull 证明真往返；打包 tarball 用 pnpm file: 方式装进
   ~/.dsh/profiles/desktop（先备份）；重启必须走两阶段流程（broadcast:true → commit）并贴回执。

禁止：不要跑 measure-dev-rdev-mutations.mjs；不要改 Dev/rDev 预设声明与 profile 的 preset-dev；
不要删 ~/.Newmark 里的生产数据；不要为了通过而放宽既有断言（修门禁要说明可失败点）。
汇报格式：能力检查结果 / 改动文件 / 门禁数字 / git 三方一致证据 / 安装证据 / 两阶段重启回执 / 桌宠修复前后对照统计 / 未完成项。
```

---

## 6. 现成证据清单

| 路径 | 内容 |
|---|---|
| `evidence/20261017-pet-render/measurements.md` | 全部像素统计、通道可信度、复现/验证配方、已排除项 |
| `evidence/20261017-pet-render/pet-white-plate-4x.png` | 故障态 4× 放大（整块白板） |
| `evidence/20261017-pet-render/pet-render-ok-4x.png` | 正常态 4× 放大（本体清晰、四周透出桌面） |
| `evidence/20261017-pet-render/screen-broken-full.png` / `screen-ok-full.png` | 故障/正常两帧原始全屏 BitBlt |
| `evidence/20261017-pet-render/asset-desktop-pet.png` | 贴图原件（自证不是白底素材） |
| `evidence/20261017-preset-break/` | 上一轮预设失效的根因、审计与原始日志截取 |
| `archive/20261017-084527-heartbeat-restart-barrier/RESULT.md` | 0.3.16 两阶段重启的实现回执（gitignore，本地可见） |

---

## 7. 完成情况（0.3.17，2026-10-17 结项）

本节是本交接单的**结项记录**，取代第 1 节的「未修」状态；MemoryLab 里的两份交接记忆已按用户要求删除，结论以本文件与 `VERSION.md` 的 0.3.17 条目为准。

### 7.1 工作项 A（桌宠）——已修并已加门禁

- **根因与本单 §A.1 的推论一致**：分层窗口只由 `UpdateLayeredWindow` 呈现，而 `Tick` 只在 `moving || (cu && !anyExpanded)` 时调用 `Render()`，陪伴模式静止时一次坏合成会永久留存。修复为三处：已有的 1 s `Raise` 节拍上补 `Render()`、`WM_DPICHANGED` 之后补一次呈现、`UpdateLayeredWindow` 被拒时重建一次 surface 再呈现。
- **§A.3 的「复现配方」实测不能复现，这一条照记**：重启宠物后取 t0 / +200 ms / +1 s / +5 s 四点、两个构建各两次共 16 帧，**没有一帧出现 >80% 纯白**（`pure255` 全为 0%）；另加一次 DPI 重建触发同样干净。**候选 A（首帧/尺寸）因此未被证实**；候选 B（BI_RGB + `Format32bppPArgb` 的 alpha 语义）由同源 `PetSurface` 复跑排除（`alpha min=0 max=254 zero=22987/27234`）。真正可复现的是「坏合成一旦发生便永久留存」（活体实例 100% 纯白、470 帧不变、持续数分钟）与逐像素注入（未修构建 6000 ms 仍白，修复构建 302 ms 恢复）。
- **§A.4 的两条门禁都已补上并各有可失败的变异**：`scripts/verify-desktop-pet-render.mjs` 6 → 8 条（`no_opaque_white_plate`：恰好 (255,255,255) 占比 > 0.8 判红；`transparent_corner_matches_the_desktop`：藏起宠物窗口拍同一矩形作参照，四个合成角点每通道 ±12 且参照不得全白），`stale_presentation_self_heals` 更名 `companion_idle_keeps_redrawing` 并断言前置条件 `cu:false` + `pet_transition:'idle'`；`scripts/measure-desktop-pet-render-mutations.mjs` 种 3 个变异全部变红并逐字节还原（去掉 1 Hz 重绘 → 保活断言红；清成白且不画精灵 → 占比断言 + 角点断言红；清成白但仍画精灵（占比约 0.5）→ 两条像素级断言红）。
- **顺带修掉了 §A.4 列的那个真实失败**：`verify-desktop-pet.mjs` 的 `virtual startup does not activate a desktop window` 来自 `lib/desktop-menu.cs` 的 `Warm()` —— 预热时创建菜单宿主窗口、WebView2 起来的过程中，那个**隐藏的**菜单窗口（`NewMate · DSH 菜单`）会拿到桌面前台，等于偷偷换掉用户的输入目标。修法是在 `Warm()` 里保存并（仅当菜单不可见时）恢复前台；菜单被真正呈现时的行为未改动。该断言随后通过，`verify-desktop-pet.mjs` 11/12。
- **仍然红的那 1 条是环境项**：`native acceptance completes` 因本机 `Input target is occluded; refusing physical mouse input`（驱动在遮挡时拒绝物理鼠标输入），按本单 §4 的「或明确登记环境相关项」登记。

### 7.2 工作项 B（heartbeat）——已补

`heartbeat_restart_cancel {intentId}`（`preparing -> aborted(reason:'cancelled')` + 向 requester 的持久通知；`not_requester` / `unknown_intent` / `not_preparing` 分别拒绝，`not_requester` 不关闭 intent）与 `commitBarrier` 的 `intent_mismatch`；armed 任务连续 **N=3** 次投递失败终结为 `failed(final)`、原因写入 `terminated[]` 并从 `tasks` 扫出，等待态不计数。门禁 54 → 84 条、28/28 planted mutation 变红并字节还原；隔离根 dry-run：旧 armed=7/terminated=0 → 新 armed=0/terminated=7。**§2.3 的限定保留**：cancel 的通知、`ackMode:'agent'`、`onTimeout:'proceed'`、`force`、「不回执参与者 → aborted」仍只有门禁级证据。

### 7.3 工作项 C（门禁）——已收尾

父门禁改为「退出码 + 子进程最后几行的判定行」，`skip`/`timeout` 各为独立结果；`verify-desktop-pet-gpu.mjs` 无参数不再崩；`tool output boundary` 显式 skip；`verify-memorylab-store.mjs` 改为按 `kind` 分支（真实库那时已有两个 `kind:"folder"` 组件）；三处把 34 件工具硬编码成 33/31 的清单已同步。umbrella **200/5/0/205（17 min 34 s）→ 205/0/0/1/206（147 s，exit 0）**。

### 7.4 未完成（没有做，或被拒）

1. **宿主重启没有发生**：两阶段 barrier 两次都开成功（`intentId 7d079139-…` / `5ccfe3a3-…`，6 × `live/registered`），但 `heartbeat_restart_commit` 两次都返回 `{error:"安装版本未通过核验，不执行重启"}` —— `lib/core-restart.js:66` 的 `installed() !== state.pending.version`：`installed()` 读磁盘上的 0.3.17，而 heartbeat 传的是 `components/heartbeat/index.js:11` **挂载时**读到的 0.3.16。两个 intent 最终按 90 s 期限 `aborted(deadline_exceeded)`。**因此 0.3.17 已安装但未生效**；桌宠修复不需要宿主重启（安装态的 `desktop-pet.cs` 已是修复版）。
2. 生产 `~/.Newmark/heartBeat/state.json` 的 7 条 armed **仍然 armed**（终止策略要等 0.3.17 真正跑起来）。
3. 坏合成的**最初触发仍未定位**（§7.1 已写明可复现的只是「永久留存」与注入）。
4. 这两次 barrier 用 `ackMode:'auto'` 在生产 state 里各登记 6 条持久接续（`tasks` 7 → 19）；因为运行中的进程没有 cancel 工具，只能等期限自然关闭。这不属于用户数据，已按记录清理。

