# 0.2.35

## English

Includes the unified Newmark Core update button introduced in0.2.34. Update discovery now reads the official registry's dedicated dist-tags endpoint, then the exact selected version manifest. A real publication check observed the full package document still advertising0.2.33 while dist-tags already advertised0.2.34. The updater refuses missing or mismatched metadata instead of choosing an older release. Publication verification uses the same dedicated tag endpoint.

Components update together through Core and the official DSH manager. Installation is verified and a full restart is requested. No client-side bootstrap installer is shipped. The pristine host's initial bare-name installation age policy is still outside plugin control.

Validation: updater27/27 after the metadata change, version12/12, and preceding complete update-control regression195/195. Real dedicated-tag discovery returned0.2.34 with its correct official tarball.

## 简体中文

包含0.2.34新增的Newmark Core统一更新按钮。更新发现改为先读官方注册表独立dist-tags接口，再读选中版本的精确manifest。实测发布期间完整包文档仍报告0.2.33，而dist-tags已报告0.2.34；按钮遇到缺失或不一致的信息会报错，不选择旧版。发布校验同步使用独立标签接口。

组件随Core通过官方DSH管理器统一更新，安装后核验版本并提示完全重启。不附带端侧引导安装脚本。纯净宿主首次输入包名时的发布年龄策略仍不在插件控制范围。

验证：元数据改动后更新专项27/27、版本12/12；此前完整更新控件回归195/195。独立标签接口实测返回0.2.34及其正确官方tarball。
