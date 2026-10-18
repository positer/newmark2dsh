# 0.2.12 验收记录

本文件记录 **0.2.12 在真实运行环境中的逐功能验收**，以及验收过程中对索引产生的净影响。

- 验收对象：`newmark2dsh@0.2.12`（profile `spec` / `installed` 均为 0.2.12，DSH 于 13:19 重启加载）
- 验收方式：通过真实工具调用与真实 UI 操作，不使用桩
- 验收人：用户要求，Lead 执行；重建索引按钮由用户自行点击
- 结论：**通过。期间未发现需要修复的缺陷。**

---

## 一、agent-api（4/4 工具）

| 功能 | 结果 | 关键证据 |
|---|---|---|
| `agent_api_state` | 通过 | `catalog.count: 13`、`runTools: 7`、8 项能力；`http.run` 为 `refused`（`http_run_refused`） |
| `agent_api_catalog` | 通过 | `total: 13`、`returned: 13`、`truncated: false` |
| `agent_api_tool`（成功） | 通过 | 派发 `memory_lab_query` 并返回完整值 |
| `agent_api_tool`（失败） | 通过 | `NOT_FOUND: Memory component not found: …{"selector":"…"}` |
| `agent_api_send`（对话） | 通过 | 17×23 → `391`；1 轮；`released: true` |
| `agent_api_send`（工具调用） | 通过 | 2 轮、`tool_calls: 1`；模型自报 `count=2`，**经独立调用核实确为 2** |
| `agent_api_send`（失败收敛） | 通过 | 修复前 `max_steps`/6 轮 → **修复后 `exit 0`/2 轮**，答案引用错误码 |
| 事件载荷 | 通过 | `tool` / `call_id` / `arguments`（字符串）/ `is_error` / `code` / `error` 均在 |
| 运行计数 | 通过 | `tool_calls: 1` 是本次运行自己的计数，不再是组件生命周期计数器 |

**0.2.12 修掉的那一处**：`lib/contract.js` 曾用 `String(value.error)` 分类 `{ok:false,error:{…}}`，得到文本 `[object Object]`。实测对比：

```
修复前：exit 4 · error "[object Object]"
修复后：exit 4 · code tool_reported_failure
        error "NOT_FOUND: Memory component not found: ZZZ-…-0.2.12 {"selector":"…"}"
```

---

## 二、memoryLab（7/7 工具）

| 功能 | 结果 | 关键证据 |
|---|---|---|
| `memory_lab_read` | 通过 | 完整索引（98 tag / 18 组件 / `relationshipVersion`）+ 所请求组件正文 |
| `memory_lab_query` | 通过 | 自适应早停生效：`stoppedEarly: true`、`stopReason: "floor"`、`droppedByFloor: ["ai-agent-评估"]` |
| `memory_lab_update`（创建） | 通过 | `action: ADD`、`revision: 1`、`receipt{rebuilt,verified}`、`policyEventId` |
| `memory_lab_update`（修改） | 通过 | `action: UPDATE`、`revision: 2`、**旧版本已归档**、`310 B → 434 B` |
| **陈旧写入守卫** | 通过（负面） | 传过期的 `expectedUpdatedAt` → **被拒绝**：`Memory component changed since it was read` |
| `memory_lab_delete` | 通过 | `action: DELETE`、终版已归档、`receipt{rebuilt,verified}` |
| `memory_lab_reindex` | 通过 | **幂等**：`relationshipVersion` 不变、`receipt{rebuilt,verified}` |
| `memory_lab_tag_review` | 通过 | **21 项发现**：false-root 3 / synonym 6 / single-tag-path 8 / rule-not-reproducible 2 / **cycle-candidate 2**；四类问题齐全（含 `cycle-break` 解环判定）；`prompt.text` 就绪 |
| `memory_lab_tag_apply`（应用） | 通过 | `merge #RLHF→#RL`；98→97；归档改动前索引；返回可用 `undo`（`set-tags` + `unfold`） |
| `memory_lab_tag_apply`（撤销） | 通过 | **版本精确回到 `b3375a71…`**；并诚实报告两条无法完全还原的警告 |

**可逆性**：撤销后 `relationshipVersion` 与测试前**逐字符相同**。

---

## 三、computerUse（工具 + 动作面）

| 功能 | 结果 | 关键证据 |
|---|---|---|
| `screen_capture` 桌面级 | 通过 | `action: capture_screen`、`target_scope: "screen"`、`capture_scope: "virtual-screen"`、`capture_method: "BitBlt(screen-dc,virtual-screen)"`、`screen{0,0,2560×1600}`、`controls: []`；**读图确认非黑帧，含任务栏** |
| `mode_report` | 通过 | 模式清单、租约、overlay 状态完整 |
| `app_list` / `app_observe` | 通过 | 真实桌面与隐藏桌面均可用 |
| 真实桌面动作 | 通过 | `ctrl+esc` → `type` → `enter` 启动 Edge；`ctrl+l` → `type` → `enter` 搜索；`scroll`；`app_observe` 捕获 |
| **隐藏桌面全链路** | 通过 | 武装 → 启动 Edge（`held:true, ownership:"inherited"`）→ `app_list`（**不传 owner_id 仍路由**）→ 点击/输入/回车 → 捕获 → **搜出同一结果** → 拆解干净 |
| 拆解回执 | 通过 | **14 条逐 pid 记录**，各带 `sources` 与 `running`；`nothing_holds_the_desktop: true`、`unaccounted_holder: false` |

**0.2.12 修掉的两处**：

1. **路由查找键**。修复前 `app_list` 按调用方声明的 owner id 查路由，而真实模型不传 `owner_id`，于是落回交互分支 —— `count: 99`、`scope: "virtual-includes-occluded"`、**隐藏桌面的 Edge 不在其中**。修复后 `owner_id_declared: "dsh"` → `owner_id_routed: "dsh-hidden-0212"` → `owner_resolved_from_lease: true`，`scope: "hidden-desktop"`、`count: 18`。
2. **拆解逐 pid**。修复前 `pids_checked: [37304, 37304]`（只查 agent），`all_processes_gone: true` 是个不可能为假的断言。修复后 14 条记录带来源。

---

## 四、newmark-core

| 功能 | 结果 | 关键证据 |
|---|---|---|
| 两个 Loader 行 | 通过 | profile `cordis.patch.yml` 内 `newmark-core` 与 `preset-dev` 各 1 处 |
| 客户端面板 | 通过 | `client.js` 125 KB；含 `MemoryLab`×17、`重建索引`×8、`newmark-core/components`×5、`__ModuleLoader__`×1 |
| 控制路由 | **未由探针验证** | `127.0.0.1:43120` 对任何非浏览器请求返回 **403（连 `/` 也是）**，属 DSH 自身的 web 防护；面板在浏览器中可用 |
| **重建索引按钮（完整链路）** | **通过（用户自行点击）** | 日志：`snapshot served after a rebuild (rebuild ok) (judgement judged, 3 turns)` |

**用户的按钮运行结果**：`rebuild ok` + `judgement judged, 3 turns`；`policy.jsonl` **无新增 TAG-EDIT**，`index.json` sha 与版本号均未变 → **Agent 判定后没有应用任何决定**。

这是**预期且正确**的结果：审查中那两对互为候选父节点的环（`#作者↔#研究`、`#数学↔#研究`）没有任何方向证据，假根也没有层级依据，因此不具备可应用的修复。**判定没有为了完成任务而乱改图。**

---

## 五、本轮验收对索引的净影响：零

```
测试前  relationshipVersion = b3375a71cd8d8e4c8dce3d09b6ccc6e2adb9916f63699af5c99cbacd945d8104
测试后  同一值
tag 98 · 组件 18 · 临时夹具组件已删除（终版已归档）
两次 tag_apply 各自归档了改动前的索引，第二次把版本还原为原值
index.json sha = 7534D66CFEE8CFEF
```

所有痕迹按设计落在 `archive/` 与 `policy.jsonl`：

- `archive/_tag-graph/2026-10-02T05-34-40-144Z-pre-tag-edit.json`（应用 merge 前）
- `archive/_tag-graph/2026-10-02T05-34-47-636Z-pre-tag-edit.json`（撤销前）
- `archive/zzz-功能测试-可删除/…-2.md`（夹具终版）
- `policy.jsonl`：ADD / UPDATE / DELETE / TAG-EDIT ×2，各带 `source: "功能测试"`

---

## 六、验收中发现的能力缺口（非缺陷，未修）

1. **`launch` 需要绝对路径，而错误消息没有说明这一点。**
   `launch: "msedge.exe …"` → `hidden_desktop_launch_failed` / `CreateProcessW refused the launch`；
   `launch: "C:\Program Files (x86)\…\msedge.exe"` → 成功。
   `notepad.exe` 能成功只是因为它位于 System32（PATH 可达）。
   **失败时不会自动回收已创建的 agent 与桌面**（`takeover: false`，没有租约可回收），需要按 pid 手工清理。

2. **`app_key` 拒绝和弦**，因此隐藏桌面上没有 `ctrl+l`；本次以「点击地址栏坐标」代替。
   这是刻意的设计（投递的 `WM_KEYDOWN` 打不开某些组合），但对浏览器自动化是不便，值得写入操作指引。

3. **`127.0.0.1:43120` 对非浏览器请求一律 403**，使控制路由无法用命令行探针验收。
   面板路径不受影响。

---

## 七、结论

**`newmark2dsh@0.2.12` 通过逐功能验收。** 三个组件、13 个工具、隐藏桌面与真实桌面两条驱动路径、以及重建索引的完整链路均按设计工作；对用户索引的净影响为零。

验收过程中未发现需要修复的功能性缺陷，因此**不产生新的版本**；0.2.12 即为当前发布版本。
