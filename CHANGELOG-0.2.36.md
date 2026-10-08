# 0.2.36

## English

Moves the unified Core update card to the bottom of Configuration, below model and NewMate settings. Its responsive header groups the description and action; installation feedback uses a separate status footer. All three components update with Core.

Fixes unguarded Response.json parsing in the updater. Missing routes, expired authentication, empty bodies, HTML responses and upstream invalid JSON now produce actionable messages. A missing host update route requests a complete DSH restart. The updater never downgrades an installed version when official registry metadata lags behind.

Official latest discovery and exact archive installation from0.2.35 remain. These changes improve the button but do not alter the pristine host's bare-name pnpm release-age policy. The other device's exact response was unavailable; the parser defect and missing/invalid-response paths were reproduced in regression tests, not asserted as that device's confirmed server failure.

Validation: updater and configuration placement68/68; renderer119/119; first-open11/11; version12/12. The preceding full Core update suite passed195/195.

## 简体中文

统一更新卡片移到配置栏最末尾，位于准用模型与NewMate设置之后。宽屏说明与按钮并排，窄屏按钮换行；底部独立显示更新状态。三个组件随Core统一更新。

修复更新流程直接解析Response.json的缺陷。接口未加载、认证失效、空响应、HTML与上游非法JSON均显示明确提示；缺少宿主更新接口时提示完全重启DSH。官方标签缓存落后于已安装版本时，不执行降级。

保留0.2.35的官方latest发现与精确包安装。这些改动不改变纯净宿主按包名安装时的pnpm发布年龄策略。另一台设备的原始响应尚不可读；已复现解析缺陷和异常响应路径，不把它们冒充该设备服务端原因的确证。

验证：更新及配置位置68/68、客户端119/119、首次加载11/11、版本12/12；此前完整Core更新回归195/195通过。
