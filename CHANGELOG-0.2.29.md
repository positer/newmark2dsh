# 0.2.29

Process push/pull animations now respect real-window and expanded virtual-preview stacking. Covered real windows remain below their covering windows; flights originating in the virtual preview remain above that preview and below NewMate. Animations do not activate their window or collapse the preview. An empty virtual desktop renders pure black without routine engineering captions; capture errors remain visible.

Validated: core 195/195, native stacking 8/8, GPU preview 15/15 and native round-trip transfers 17/17. These are production-backend/native integration tests, not a claim of physical NewMate menu input.

# 简体中文

进程推出/拉入动画遵守真实窗口及展开预览的层级。被遮挡的真实窗口不越过遮挡层；从虚拟预览发出的动画位于预览上方、NewMate 下方。动画不抢焦点，不强制收起预览。空虚拟桌面显示纯黑，移除常规工程提示，保留捕获错误提示。

验证：核心 195/195、原生层级 8/8、GPU 预览 15/15、原生窗口往返 17/17。以上为生产后端及原生集成测试，不代表已完成桌宠菜单的真实鼠标验收。
