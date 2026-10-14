# Release engineering conventions

- Keep runtime bytes synchronized with the accepted development package. Change product code in the development workspace, with appropriate verification, before publishing.
- Keep the bundle self-contained and component versions aligned. The core loads components through local paths; no separate component dependency is required.
- NewMate previews are read-only. Contour state reflects visible preview windows, animations are reversible, and size preferences load before the first displayed frame.
- Preserve user-root configuration and atomically store preferences. Isolate test stores and release a test lease when acceptance is complete.
- Distinguish source, packed, published and installed evidence. A successful publish command is insufficient without registry retrieval and byte comparison.
- Publish only the package and public documentation. Local profile backups, session records, private paths and development archives do not belong in Git or npm.
- Read README/OVERVIEW/taste before work, update current documentation afterward, and retain timestamped operation records in the local archive.

## 0.2.26 rendering
Separate animation presentation from source capture and report measured frame intervals by phase. Reuse DIB/DC/Graphics, batch alpha-contour updates and coalesce UI frames; never grow an unbounded render queue. Keep native viewer bounds fixed and animate GPU transforms, preserving input isolation and explicit process cleanup. Retain DSH tokens and plugin CSS overrides in both settings surfaces.

## Process-preserving presentation transfers
Never claim HWND-thread migration: receipts expose original identity and presentation identity separately. Reserve both desktop modes during crossing. Bind ownership to the trusted DSH session. Preserve exported application jobs, clean only unexported job members using retained process handles, restore imports, and test abrupt host/broker death independently from normal stop. GPU callback cadence is distinct from source capture cadence.

## Process transfer presentation

Process push/pull flights follow source-window z-order and the live expanded-preview layer without forcing a collapse or unconditional topmost activation. Native animation receipts expose layer, preview_expanded and topmost. Empty virtual desktops use pure black; no fixture application is launched by default.

## 0.2.30 display pacing and Linux

`components/computeruse/lib/linux-desktop.js` launches the isolated X11 host; `linux-desktop.py` owns leases, authenticated Xvfb, mappings, GPU presentation and independent capture. `linux-process-guard.py` guards virtual process lifetime. Windows `desktop-pet.cs` and `desktop-transfer.cs` use output vblank pacing with bounded pending frames. Preserve input isolation and original process identity; distinguish render callbacks from physical scanout.

Display-dependent rendering must not gate lifecycle commands or liveness heartbeats. Validate control progress with the display clock stopped.

## 0.3.10 native boundaries
Use DSH public model resolution, single-use prepared streams and BlockAssembler, without provider-name branches. Keep private replay state inside the exact provider/model route. Query live document preview registrations and wait for native session/sidebar mounting after switching global panels. Let native preview components own read authorization. Prewarm pet menus and reuse their loaded document. Treat Mac source, native compilation, hardware acceptance and guest routing as distinct evidence; never fall back from a virtual request to the physical desktop.

## 0.3.11 inline and native documents
Render generated HTML in each reply with isolated scripts, no same-origin permission or external network. Preserve iframe state across expansion/source toggles. Mount the registered DSH document component and its native state in NewMate’s own sidebar; never hand off the global conversation or implement a replacement file renderer. Memory write checks use isolated stores and verify completed tasks.

## 0.3.13 durable reminders and Space acceptance
Validate zoned calendar timestamps before persistence. Persist a fixed reminder message ID before notification and reconcile in-flight state after restart without re-notification. Reuse attention and interruption policy, with no extra model call. Test new tools through the actual host registry rather than treating increased roster counts as failures. Keep visual and AX channels independent, cross-check optional; pause agent input for user activity and restore exact foreground/cursor without fighting renewed user input. Report cloud fixture evidence separately from official installed containers and physical hardware.

- Scheduled NewMate activation must protect current attention, use native memory context, persist a one-time receipt and never automatically repeat failed/crashed runs.
- Align cross-platform contour geometry and marquee timing while preserving native DPI, menu and window semantics; report fixture vs physical/container evidence explicitly.


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
