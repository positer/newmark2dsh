# 0.2.33

## English

MemoryLab now reads its current host snapshot when the panel first opens. Installing or enabling the plugin after the shell HTML was served no longer leaves the panel dependent on missing initial page globals. This read does not rebuild or modify the memory store; failures remain visible.

Publication explicitly targets the official npm registry and latest tag. Serialized publication rejects older/equal versions before publishing and verifies latest afterwards without mirror fallback. Older published versions remain available by explicit version.

This does not override the official DSH installer's pnpm minimum release age. A pristine client may still resolve an older version when given only the package name; that P0 requires an official installer change. No client-side installer or release-age override is shipped.

Validation: first-open regression 11/11, client renderer 119/119, official-runtime preset compatibility 23/23, and version discipline 12/12. First-open testing covers absent page globals, host recovery, no rebuild, and visible host failure.

## 简体中文

MemoryLab 首次打开时直接读取当前宿主快照。页面已打开后再安装或启用插件，不再依赖缺失的初始页面全局变量。该读取不会重建或修改记忆库；宿主失败仍明确显示。

发布明确使用 npm 官方源和 latest 标签；串行发布在发布前拒绝旧版本或同版本倒灌，发布后验证 latest，不回退镜像。既有旧版本仍可按明确版本号获取。

这不会覆盖官方 DSH 安装器的 pnpm 最低发布年龄策略。纯净客户端仅输入包名时仍可能解析到旧版，该 P0 需要官方安装器修复。本版不包含端侧安装器或发布年龄策略覆盖。

验证：首次打开回归11/11、客户端渲染119/119、官方运行时预设兼容23/23、版本规范12/12。首次打开测试覆盖页面全局变量缺失、宿主恢复、不触发重建和失败可见性。
