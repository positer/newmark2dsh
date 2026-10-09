# 0.2.39

## English

- Share schema resolution across Core components instead of repeating host-library lookup.
- Reuse normalized MemoryLab indexes only when the disk text is identical; continue reading files, detect same-size/timestamp edits, and clone cached results to isolate mutations.
- Initialize NewMate menu synchronization at browser idle time and reuse its injected connection, saving one startup request. Process stylesheets cooperatively and cache transformed text without dropping CSSOM changes, adopted sheets, or plugin overrides.
- Alternating local snapshot benchmark: repeated-read median 10.84 → 5.51 ms (about 49% less). First reads were essentially unchanged.
- Three full launches per build showed no reliable host-ready improvement (baseline median 6.81 s, candidate 7.02 s). Isolated browser first-paint medians were 228 → 220 ms, too small to claim substantial desktop startup acceleration. These are local warm-cache observations, not a cold-boot guarantee.
- Memory store 46/46, client 119/119, first-open 11/11, cache 7/7, and menu CSS compatibility 9/9 passed. Six isolated browser runs produced no page errors. Existing update/restart checks also passed.

## 简体中文

- Core各组件共享一次schema库解析，减少重复宿主依赖查找。
- 仅在磁盘文本完全一致时复用MemoryLab索引规范化结果；仍读取文件，能检测同大小/同时间戳的外部改动，返回独立副本避免修改缓存。
- NewMate菜单同步延至浏览器空闲时初始化，复用页面已注入连接，减少一次启动请求；样式表分批处理并复用转换结果，保留CSSOM、adoptedStyleSheets及插件覆盖兼容。
- 本机交替对照：重复快照读取中位数10.84→5.51毫秒，约减少49%；首次读取基本不变。
- 每版三次完整启动未显示可靠的宿主就绪提速（中位数6.81→7.02秒）；隔离浏览器首屏中位数228→220毫秒，差异不足以宣称DSH本体启动显著加快。均为本机缓存条件下的观测，不是冷启动保证。
- 存储46/46、客户端119/119、首次加载11/11、缓存7/7、菜单CSS兼容9/9通过；六次隔离浏览器运行无页面异常，更新/重启专项也通过。
