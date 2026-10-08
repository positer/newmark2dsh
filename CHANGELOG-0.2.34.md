# 0.2.34

## English

The Newmark Core configuration page now has an Update to latest button. It reads the authoritative npm latest metadata through a read-only host route, validates the archive identity, and installs that precise official tarball through DSH's plugin manager. MemoryLab, ComputerUse and Agent API are components of Core and are updated together. No older-version or mirror fallback is selected by the button.

The control prevents concurrent clicks, verifies the installed version, reports failures and unavailable management services, and asks for a full DSH restart after installation. An optional management child keeps a missing manager from blocking MemoryLab activation. The official manager owns installation and its normal policies; the plugin does not rewrite global pnpm settings.

Verified: updater behavior and metadata rejection27/27, client119/119, first-open11/11; the official host manager installed the exact0.2.33 npm archive, returned restart-required, and listBundles plus disk both confirmed0.2.33. This real path check is distinct from physical mouse UI testing.

The0.2.33 CI post-publish check timed out before tag propagation, while publication succeeded and official latest subsequently reported0.2.33. This version checks package metadata and allows up to five minutes on the same registry.

This button does not change the pristine host's initial bare-package-name installation policy. That previously identified P0 remains outside the plugin's pre-install control.

## 简体中文

Newmark Core 配置页新增“更新到最新版本”按钮。宿主只读接口读取 npm 官方 latest，校验安装包身份，并通过官方 DSH 插件管理器安装该精确 tarball。MemoryLab、ComputerUse、Agent API 作为 Core 的组件统一更新。按钮不选择旧版或镜像回退。

更新过程防止重复点击，核实安装后的版本，显示管理服务不可用或安装失败，并在成功后提示完全重启 DSH。管理依赖通过可选子插件接入，不阻塞 MemoryLab 加载；插件不改写全局 pnpm 策略，安装由官方管理器处理。

验证：更新行为与元数据拒绝27/27、客户端119/119、首次加载11/11。官方宿主实测成功安装精确0.2.33 npm包并返回需要重启，listBundles与磁盘均确认0.2.33。该接口实测不等同物理鼠标点击验收。

0.2.33发布成功，但CI发布后一分钟校验超时，之后官方latest已更新。本版改为读取包元数据并在同一官方源最多等待五分钟。

此按钮不会改变纯净宿主首次输入包名时的解析策略；此前P0仍不在插件安装前可控制范围内。
