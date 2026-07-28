# 性能与 30 分钟稳定性基线

自动化和实机分开记录。Node.js 基线验证协议解析、状态写入、规则评估和提醒冷却；只有
Windows Factorio 实机能验证 Lua 采样、UI 和 UPS。

## 自动化基线

```bash
npm run benchmark
```

输出 `artifacts/performance-baseline.json`，打包时复制进 release。三种场景均执行完整
`JSON → protocol validation → state store → advisor` 路径：

| 场景 | 数据 | 平均耗时门禁 |
| --- | --- | --- |
| `idle` | 1 个 force，无物品/流体 series | ≤ 2 ms |
| `normal-production` | 20 个物品 + 8 个流体 series | ≤ 5 ms |
| `large-factory-summary` | 自动填充到约 15 KiB、接近协议上限 | ≤ 20 ms |

脚本另模拟 30 分钟、每 5 秒一个低电力样本。默认 5 分钟提醒冷却下，主动通知最多 7 次，
任意两次间隔不得小于 `notification_cooldown_ticks`。这验证不会按每个样本重复告警。

门禁有意高于通常测量值，避免共享 CI 主机的短暂抖动；报告同时保留平均、p95 和最大值。

## Windows Factorio 实机矩阵

三个场景各运行至少 10 分钟，总计至少 30 分钟。使用同一台机器、相同图形设置和
Factorio 版本；每个存档先做 2 分钟无 Mod 对照，再启用 Mod + Companion。

| 场景 | 建议存档 | 记录 |
| --- | --- | --- |
| 空闲 | 新游戏或小基地，生产基本停止 | 对照/启用后的 FPS/UPS、采样耗时、进程内存 |
| 正常生产 | 稳定蓝瓶/机器人生产 | FPS/UPS、每分钟提醒数、聊天和计算响应 |
| 大基地摘要 | series 较多、接近实际大存档 | FPS/UPS、动态包 byte/裁剪计数、采样耗时 |

验收条件：

- [ ] 30 分钟内无 Companion 未处理异常、Lua 错误或反复断连。
- [ ] 稳定工况下无可归因于本 Mod 的持续 UPS 下跌；如本来低于 60 UPS，记录对照差值。
- [ ] `factorio-current.log` 的动态采样 profiler 没有持续上升；记录典型和最大耗时。
- [ ] 没有每 5 秒重复 toast；同一规则遵守配置冷却。
- [ ] 大摘要超预算时明确 `truncated` / `omitted_series`，而不是发送超 16 KiB datagram。
- [ ] 关闭 Companion 后游戏继续运行，重新启动后能恢复。

结果附到 [`windows-smoke-test.md`](windows-smoke-test.md) 的反馈模板。任何失败都保留
原日志并阻止 RC 签收。
