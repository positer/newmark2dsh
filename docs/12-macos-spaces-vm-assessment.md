# macOS CU：Space、独立用户会话与 VM 评估

2026-10-13。用户暂停 Space 实现，要求全面比较，并明确最低部署机型为 MacBook Neo / A18 Pro。本轮只进行评估，不继续改 CU 源码、安装或发布。

## 已核实的基线

Apple 的 [Neo 技术规格](https://www.apple.com/macbook-neo/specs/) 为 A18 Pro、6 核 CPU（2 性能＋4 能效）、5 核 GPU、8GB 统一内存、60GB/s 内存带宽。最低适配需要围绕8GB总内存，而不能默认M系列16GB起步。

[Parallels 官方兼容说明](https://kb.parallels.com/en/131100)确认A18 Pro支持虚拟化及Neo运行虚拟机。这不等于本项目使用Apple Virtualization.framework的自研helper已经通过Neo验收；仍需检查VZVirtualMachine.isSupported、配置validate、启动、guest传输及稳定性。其跨机器单核比较不是同一Neo上native/VM对照，不能用来推导本项目损失百分比。

## 隔离边界

| 路线 | 用户与Agent输入 | 应用和文件 | 系统边界 | 目前项目状态 |
|---|---|---|---|---|
| 同一用户Space＋AX | 共享鼠标、焦点、快捷键；部分AX动作可不移动鼠标 | 同一应用/账户，可能共用文档、浏览器状态与剪贴板 | 同一系统和GUI会话 | AX源码候选；Space调用未接入 |
| 另一用户的原生GUI会话 | 合适的远程会话输入路径可分开；不能混用宿主全局CGEvents | 独立账户与应用状态，权限限制文件访问 | 共享内核与硬件 | 候选研究路径，尚未接入/实测 |
| Linux VM | guest内投递可独立；预览窗口应避免自动接收用户输入 | 独立guest文件系统，交换通道显式开放 | 独立guest OS/内核，宿主硬件共享 | 仅启动/显示源码原型，guest CU未接通 |
| macOS VM | guest内投递可独立 | 可运行macOS应用，另配置账户/权限 | 独立guest OS/内核，宿主硬件共享 | 尚未实现macOS guest |

[Apple Mission Control](https://support.apple.com/en-gb/guide/mac-help/mh35798/mac)是窗口/Space组织。[Apple Remote Desktop](https://support.apple.com/en-al/guide/remote-desktop/apd4f46319e/mac)明确允许以不同账户连接该账户的虚拟显示，当前登录用户可继续操作。这是独立账户会话，不是Space。官方远程连接能力不自动证明同机回环自动连接、Agent后端注入和所有版本均可用，需要单独技术验收。

“完全隔离”应区分：窗口可见性、输入、应用状态、文件权限、内核和资源竞争。Space只解决前者；独立用户会话改善操作与账户边界；VM提供更强系统边界。任何同机方案都仍竞争CPU、内存、GPU和磁盘，VM也不是绝对安全或资源互不影响的保证。

[VZVirtualMachineView](https://developer.apple.com/documentation/virtualization/vzvirtualmachineview)默认能转发键盘和鼠标到guest。因此要实现实际操作隔离，Agent应通过guest内服务投递，宿主预览默认只读，用户主动接管时暂停Agent；不能靠在宿主点击VM窗口代替隔离输入。

## Neo资源规划估算

以下为容量预算/敏感性分析，**没有Neo实测，也不是Apple公布的基准**。假设云端模型、单一CU任务、轻量网页/文档，无本地模型推理和持续视频/3D。

| 路线 | 建议新增内存预算 | 新增存储预算 | Neo判断 |
|---|---|---|---|
| Space＋AX控制层 | 50–200MB控制与观察预算；Agent应用额外另计 | 日志/缓存，通常无需系统镜像 | 最轻；不保证同时操作不干扰 |
| 独立账户会话＋轻量应用 | 约1–3GB，取决于应用与额外会话服务 | 应用用户数据/缓存 | 比VM轻，但要限制并行应用 |
| ARM Linux VM＋轻量GUI | guest配置2–4GB，宿主控制/显示另预算0.2–0.8GB | 建议预留10–30GB，实际磁盘镜像占用另测 | 2GB档可作为可选轻任务；4GB档对8GB主机压力高 |
| macOS VM | 必须满足restore image的最低要求；规划8GB起且应用可能还需更多 | 建议预留40–100GB | 不适合作为Neo最低档默认常驻能力 |

内存配置不是实时RSS。guest、宿主、应用的内存都要测，不能只看虚拟机设置。示例预算：宿主系统＋DSH＋用户应用3.5–5.5GB，Linux guest与控制显示2.2–4.8GB，合计5.7–10.3GB；超过8GB后压缩和swap可能使延迟非线性上升。此例仅说明风险，不是Neo实际用量报告。

CPU不要给固定“VM损失X%”承诺。同架构、同任务、内存足够时，可先为纯CPU路径预留5–15%的额外时间作为测前预算；I/O/图形/内存不足可能大幅超出。2vCPU不等于固定占用两个物理核，更不等于固定占用六核CPU的三分之一。Neo只有两性能核，持续负载必须测前台响应与能耗。

CU全流程主要受模型等待、页面加载和失败重试影响。假设一次步骤模型等待4秒、原生本地操作0.5秒，VM使本地操作增加0.05秒，则总时间从4.5到4.55秒，增加约1.1%。如果每步因输入冲突增加重试，Space可能比有额外开销的VM更慢。上述时间同样是计算示例。

GPU兼容不能当作CPU损失百分比。Linux guest的Virtio图形和宿主macOS原生图形不是等效能力；本项目没有证明GPU加速、Metal应用或本地AI在guest可用。不能把其他虚拟机厂商的GPU表现当成自研VZ helper的结果。

## 面向NewMate的选择与验收

NewMate/MemoryLab保留在宿主；陪伴空闲时不启动第二桌面。Neo默认采用原生AX/API、独立浏览器状态和单任务；Space仅作视觉整理，共享输入操作需要短暂互斥。希望用户持续使用原生Mac应用而Agent同时操作时，优先验证另一账户的原生GUI会话。需要更强系统/文件边界的网页或跨平台任务，再按需启用2vCPU/2GB ARM Linux VM；不把macOS VM作为最低机型必备。

稀疏观察减少PNG发布和模型视觉调用，不自动消除完整截图、guest系统和渲染开销。宜按事件唤醒、低频结构测量、必要时像素观察。不能只下采样网格就宣称整机开销降低。

真实验收至少包括：宿主/guest内存及swap、guest空闲与工作CPU、CU步骤P50/P95耗时、前台输入延迟、并发输入是否串入、剪贴板/文件交换边界、屏幕会话身份、切Space/失焦/断连后停止，另测功耗。可设工程目标：控制层空闲新增RSS≤150MB，整机归一化新增CPU平均≤1%且无高频像素捕获；这些是待验收目标，不是已达到的结果。
