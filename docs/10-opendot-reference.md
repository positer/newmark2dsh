# OpenDot 源码参考边界

本轮选择 defog-ai/opendot（单数 OpenDot），不与 Composio open-dot 或 CopilotKit OpenDots 混淆。核对提交：687c15b5ca18c0b90853a8b02e33158e3fae5e6b，2026-10-11 读取公开源码，仅作结构参考，无运行依赖、无源码移植。

来源：
- [架构说明](https://github.com/defog-ai/opendot/blob/687c15b5ca18c0b90853a8b02e33158e3fae5e6b/docs/how-it-works.md)
- [schedules.py](https://github.com/defog-ai/opendot/blob/687c15b5ca18c0b90853a8b02e33158e3fae5e6b/src/opendot/schedules.py)
- [store.py](https://github.com/defog-ai/opendot/blob/687c15b5ca18c0b90853a8b02e33158e3fae5e6b/src/opendot/store.py)
- [MCP 官方 HTTP 规范](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)

参考点与实现选择：

| 源码机制 | NewMate / heartBeat 的采用范围 |
| --- | --- |
| run_due_schedules 将新任务与调度进度在 store.transaction 内更新 | 宿主持有持久任务，先落盘再启动推理；heartBeat 成功交接后原子消费 |
| 上次任务未终结时跳过新运行，漏过的周期不补跑 | NewMate 串行工作者，中断/失败不自动重试，避免重复花费 |
| should_notify 对结果散列比较，changed 模式仅在变化时发布 | 本地文件 metadata 去重、粗粒度预算、默认安静；未实现 OpenDot 的周期 cron 或其结果哈希通知策略 |
| ScheduleCreateHandler 把目的地绑定原任务请求者 | DSH 对话工具从宿主取得当前对话身份，模型不能自选目标 |
| SQLite 事务及更新字段白名单 | 本轮使用现有用户根目录与同步原子 JSON 文件；跨进程锁与数据库迁移未实现 |

参考不等于照搬能力。OpenDot 的通用 CLI/container 模型执行、外部渠道与发布、可删除的 store 记录不进入 NewMate 工具面。NewMate 使用已有 DSH Agent API，默认只读 MemoryLab，外部 MCP 只开放陪伴接口。heartBeat 一次性重启任务不是 OpenDot 的重复日程。

研究阅读副本只位于本次 archive 冷数据；不会打入 npm 运行包。
