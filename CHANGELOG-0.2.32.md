# 0.2.32

## English

This release fixes NewMate's right-click size slider receiving clicks through its WebView2 surface and a teardown exception when its menu closes. It retains the DSH menu CSS and plugin overrides.

The read-only desktop preview now waits for an anchored first frame at NewMate and grows along the same path as its scale. Reopening after moving the mascot uses its new position.

Imported Windows application windows keep their compositor active without showing or accepting real desktop pointer input. This addresses Chromium accepting a virtual click while PrintWindow keeps returning the previous page. Original process/window identity and window styles are retained and restored. An opened preview no longer occludes the invisible rendering source. Delayed broker heartbeats do not erase a live mapping, and immediate transfers wait for NewMate's startup position.

Real Chromium tests exercise import, expanded preview, restoration, hidden launch and export, checking DOM click/text delivery and changed capture pixels through the CU tools. Public HTTPS checks have also failed before any transfer on the test machine; those failures are retained and are not reported as a fully passing internet-connectivity gate. Window mapping still requires an application compatible with PrintWindow and posted input; additional windows/dialogs and unsupported hidden key chords remain separate limitations. Linux behavior is unchanged by this Windows repair.

## 简体中文

修复 NewMate 右键大小滑块的点击穿透，以及菜单退出时的空引用异常，继续采用 DSH 菜单 CSS 和插件样式覆盖。

只读桌面预览会先等待 NewMate 位置上的首帧，再沿与缩放一致的路径展开。移动桌宠后重新展开使用新位置。

拉入的 Windows 应用保持合成绘制，同时在真实桌面隐藏并穿透真实鼠标输入，解决 Chromium 已接受虚拟点击、PrintWindow 却仍返回旧页面的问题。保留原进程和窗口身份，返回时恢复窗口样式；展开预览不会再次遮挡并节流隐藏源窗口。心跳暂时延迟不会丢失仍存活的映射，CU 启动后的立即拉入／推出会等待 NewMate 的位置就绪。

真实 Chromium 测试覆盖拉入、预览展开、还原、虚拟启动和推出，通过 CU 工具检查 DOM 点击／文本输入和截图像素变化。本机公网 HTTPS 检查在迁移前也发生失败，失败记录保留，不将其列为互联网连通性全通过。映射仍要求应用兼容 PrintWindow 和消息输入；额外窗口／对话框及隐藏模式不支持的组合键仍有限制。本次 Windows 修复不改变 Linux 行为。
