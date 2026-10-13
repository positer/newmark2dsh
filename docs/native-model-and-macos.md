# 0.3.10：DSH 原生模型边界与 macOS CU 原型

2026-10-13。Windows 已安装验收；macOS 部分为待原生编译及硬件验证的源码原型。

## 模型兼容边界

Agent API 复用 DSH 公共 `llm.resolveModelInfo(provider, model)`、`llm.prepareCall(config, signal)` 与 `BlockAssembler`，对应对话层的模型选择、请求准备和标准流回复解析。prepareCall 返回的流句柄是单次使用的，每次重试重新准备。供应商插件负责鉴权、协议转换、SDK 和模型元数据；Newmark 不按供应商名称分支，也不单独实现外部 API 协议。

模型目录用于展示和旧宿主回退；存在公共模型解析接口时，以解析结果为准，允许插件动态提供目录外的模型。provider/model 必须与请求精确对应。图片能力同样读原生解析结果。供应商私有 replayState 仅在同一 provider/model 中重放，同名模型切换供应商时剥离，禁止跨供应商复用。

12 项集成检查使用本机安装的真实 DSH LLM Runtime、Cordis 和 BlockAssembler，并只注册内存中的适配器。覆盖请求准备、单次句柄、重试、默认参数和文本/工具/usage/finish/replayState。未安装 OpenCode/OpenAI 接入插件，未使用其凭据，未进行真实外部供应商调用。因此证据是公共边界兼容，不是所有第三方插件端到端承诺。参考 [OpenCode provider 文档](https://opencode.ai/docs/providers/) 和 [OpenAI 工具调用规范](https://developers.openai.com/api/docs/guides/function-calling)，协议变化由 DSH 供应商适配层处理。

## 文件导航

0.3.11 起，NewMate 对 assistant 回复中的文件引用进行路径及现存普通文件校验，再读取有界、读前后未变化的原文件字节。客户端实时查询 DSH documentPreviews 和 sidebar.right.tab.document 注册项，将实际原生组件及其 store/locale 在 NewMate 自己的侧栏挂载，不切换本体对话。不自行实现文档渲染器；原生组件缺失、绑定不支持或读取失败，则通过 sessionController.openWorkspacePath 的 reveal 动作定位文件。没有静态后缀白名单，后续注册预览实现自动参与。导航草稿只留在当前窗口内存，历史仍不可编辑或重新激活。

## macOS 当前实现及证据

0.3.13 选择 Mission Control Space + AX 控制层。视觉/AX 可分别调用，允许但不强制交叉核验；用户输入进行时暂缓 Agent 输入，空闲 100ms 后执行。操作后恢复光标和原前台窗口，用户再次输入优先。共享桌宠、主题消息气泡及正常 CU 边框已在 Apple Silicon 云端原生夹具编译、渲染和操作验证。Space 仍共享物理输入，不提供完全隔离。历史 VM 源码不作为默认实现。

[Native and browser matrix](https://github.com/positer/newmark2dsh/actions/runs/38360580407) · [Mission Control two-Space matrix](https://github.com/positer/newmark2dsh/actions/runs/38360583039)

Cloud validation uses owned native fixtures and the actual NewMate client with explicit host/model fixtures. It does not prove official macOS DSH installation, physical keyboard/mouse timing, multi-display/fullscreen combinations or minimum Neo hardware performance. Spaces share user input; they are not complete isolation.
