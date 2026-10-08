# 0.2.38

## English

- Check for updates before presenting official DSH Modal/Button confirmation with Update and restart / Cancel.
- Bundle the Windows local restart helper in Newmark Core. Verify the installed version, acknowledge the request, stop only the validated current DSH process tree, and relaunch its original executable.
- Validate PID, executable path and creation time; reject expired/replayed tickets and mismatched versions. Preserve requests across plugin re-application. Aborted responses do not restart.
- Save startup/readiness/failure diagnostics under ~/.Newmark/core/restart. Complete restart stops running DSH tasks, as stated in the confirmation.
- Keep the bottom configuration section borderless. No global pnpm policy changes. Official release-age selection remains a host limitation.
- Validation: live helper restart changed main PID 43072 to 92384 and reached host-ready; 135 update and 18 restart tests, 119 client tests, 11 first-open tests. Full core run: 193/195; boundary test overlapped restart diagnostics and was rerun; Windows foreground-dependent assertions were unavailable in this session. This is not a physical GUI click acceptance claim.

## 简体中文

- 检查到更新后才使用官方 DSH Modal/Button 确认，提供“更新并重启”和“取消”。
- Windows 本机重启辅助程序归属 Newmark Core；核验安装版本并返回响应后，仅结束已验证的当前 DSH 进程树，再启动原可执行文件。
- 校验 PID、可执行路径和创建时间；拒绝过期、重复凭据及版本不匹配，插件重载保留确认请求，响应中断不重启。
- 启动、就绪及失败诊断保存于 ~/.Newmark/core/restart；确认文案明确完整重启会结束当前 DSH 任务。
- 配置栏末尾更新区保持无边框，不修改全局 pnpm 策略；官方发布年龄筛选仍为宿主限制。
- 验证：真实辅助程序将主PID43072切换为92384并确认宿主就绪；更新135项、重启18项、客户端119项、首次加载11项通过。完整核心193/195，边界测试与重启诊断写入重叠后重测；Windows前台窗口相关断言在本会话不可用。未声称物理GUI点击验收。
