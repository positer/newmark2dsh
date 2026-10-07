# 0.2.28 — 2026-10-08

Close a NewMate presentation when its original window exits during capture. A temporary PrintWindow failure after the first valid frame is retried; a frame older than five seconds is replaced with a waiting message. This fixes the empty presentation left behind by a source-close race found during installed 0.2.27 acceptance.

Validation: 17 native transfer checks, including independent presentation-process exit, and 6 host/broker crash-recovery checks. Original application identity is preserved throughout transfers.

# 简体中文

原窗口在采集过程中退出时，NewMate 呈现窗口随之关闭。已有有效首帧后的短暂 PrintWindow 失败会重试，超过五秒的旧画面替换为等待提示。修复安装验收 0.2.27 时发现的源窗口关闭竞态残留。

验证：17 项原生迁移检查（含独立确认呈现进程退出），6 项宿主/呈现崩溃恢复检查。迁移过程中保留原应用身份。
