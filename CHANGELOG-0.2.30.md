# 0.2.30

NewMate on Windows follows its display's vertical blank instead of a fixed 60 FPS timer. Virtual-preview capture and mapped-window presentation no longer wait on fixed 400/250/33 ms delays. A single pending update prevents a backlog. On the tested 165 Hz display, native mascot render callbacks increased from about 57 to 150 per second; these are not optical scanout measurements.

Linux X11 and WSLg now support a private authenticated black desktop, process-preserving window mappings, and per-user real/virtual takeover leases. NewMate and its read-only preview use Qt OpenGL, independent X11 capture and cached textures. WSLg can use the D3D12 bridge instead of software rendering; stable preview measured about 60 callbacks/s on its reported 60 Hz output. Native Wayland, DSH-themed Linux menus and the full Windows transfer-flight visual protocol remain unsupported. Window mappings preserve the original process; they do not migrate native client connections between X servers.

Source validation: 297 checks across core, Windows native preview/mapping/layering, and Linux native/Qt integration. Package installation and restart evidence are maintained separately. Empty virtual startup launches no fixture applications. Persisted NewMate size is retained.

# 简体中文

Windows NewMate 以所在显示器垂直消隐驱动，解除固定 60 FPS 上限。虚拟预览采集、取帧及窗口映射不再等待固定 400/250/33 ms；仅保留一个待处理更新，避免积压。本机 165 Hz 显示器上的桌宠原生绘制回调约从 57 提升至 150 次/秒，这不等于光学测得的物理显示帧率。

Linux X11/WSLg 新增私有认证纯黑桌面、保留原进程的窗口双向映射，以及用户级真实/虚拟双槽互斥。桌宠和只读预览使用 Qt OpenGL、独立 X11 采集和纹理复用；WSLg 可通过 D3D12 桥接避免软件渲染，稳定预览在报告约 60 Hz 的输出上达到约 60 回调/秒。原生 Wayland、Linux DSH 样式菜单及完整 Windows 窗口飞行动画仍未支持。映射保留原进程，不宣称将原生客户端连接迁移到另一 X server。

源码验证共 297 项：核心、Windows 原生预览/映射/层级、Linux 原生与 Qt 集成。安装与完全重启另行留证。虚拟启动默认不运行测试程序，保留已保存的 NewMate 大小。
