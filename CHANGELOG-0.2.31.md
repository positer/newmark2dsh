# 0.2.31

Window-mapping status and lifecycle commands now use a separate control heartbeat. Pausing display-driven rendering no longer pauses the bridge's status updates or return command. Rendering itself remains display paced with one pending frame. A native regression probe stops the actual display clock: the previous implementation fails its heartbeat assertion and the revised implementation completes the return while preserving the original window.

Includes the Windows display-pacing improvements and Linux X11/WSLg support introduced in [0.2.30](CHANGELOG-0.2.30.md), with the same platform boundaries. This is a follow-up release; the published 0.2.30 artifact has not been replaced.

# 简体中文

窗口映射的状态与生命周期命令改用独立控制心跳。显示驱动的绘制暂停时，状态更新与返回命令仍可继续；渲染本身仍按显示器节拍运行，仅保留一个待处理帧。新增原生回归主动停止实际显示时钟：旧实现无法更新心跳，新实现可完成返回并保留原窗口。

包含 [0.2.30](CHANGELOG-0.2.30.md) 的 Windows 显示同步优化和 Linux X11/WSLg 支持，平台限制保持不变。本次为后续修正版本，不覆盖已发布的 0.2.30 制品。
