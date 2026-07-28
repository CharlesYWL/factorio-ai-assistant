# Windows 实机冒烟测试（15–30 分钟）

用于 `v0.1.0-rc.1` 的早晨快速验收。完整 30 分钟稳定性和 UPS 基线见
[`performance.md`](performance.md)。

> **Steam 成就警告：** 启用任何 Factorio Mod 都会让该存档不能获得 Steam 成就。
> 先备份存档，只在测试副本上执行本清单。

## 测试前（2–4 分钟）

- [ ] Windows 10/11、Node.js 22+、Factorio 2.0.59+。
- [ ] Mod ZIP 与 Companion ZIP 来自同一个 `v0.1.0-rc.1` bundle；SHA-256 与
  `SHA256SUMS` 一致。
- [ ] Steam 启动参数为 `--enable-lua-udp=34198`，修改后已完全退出并重启 Factorio。
- [ ] 解压 Companion；需要自定义时把 `companion.config.example.json` 复制为
  `companion.config.json`。不要在反馈中粘贴 API Key。
- [ ] 记录：Windows 版本、Factorio 版本、Mod 版本、Companion 版本、provider/model、
  测试存档副本名。

## 1. 连接与状态（2–3 分钟）

1. 双击 `start-companion.cmd`，确认窗口出现 `companion_listening`，地址必须是
   `127.0.0.1`。
2. 启动测试存档，按 `Ctrl+Shift+A`；Status 应在约 5 秒内显示 **Connected**。
3. 核对 Mod `0.1.0`、Companion `0.1.0`、协议 `1 / 2`，以及正确的隐私模式。

- [ ] 连接成功；没有公网监听、防火墙公网入站规则或未处理异常。
- [ ] 如显示版本/协议不匹配，停止测试并从同一 bundle 同时重装两个组件。

## 2. 聊天与降级（3–5 分钟）

1. 提问“当前最大的三个瓶颈是什么？”。
2. 回答应区分事实/推断/缺失数据，行动项不超过 3 个并带 `[A#]` 或 `[C#]` 证据。
3. 无模型时来源应为本地规则；有模型时断开 provider 网络再提问，35 秒内应返回本地
   降级答案，UI 不冻结。

- [ ] 没有 Lua、`/c`、RCON 或声称自动修改工厂的输出。
- [ ] Companion 日志没有问题全文、完整状态或密钥。

## 3. 计算器（2–3 分钟）

1. Calculator 输入 `chemical-science-pack`、`45`/min，机器和插件留空。
2. 结果必须包含目标配方、精确台数、向上取整台数、外部输入和假设。
3. Chat 再问“45 蓝瓶每分钟需要多少机器？”，数字应与 Calculator 一致。

- [ ] 两处确定性数字一致；无数据时明确报错，不猜测。

## 4. 提醒与防风暴（3–6 分钟）

1. 没有可控真实条件时，先停止 Companion，在控制台运行
   `/factorio-ai-assistant-mock ready` 检查 Alerts 卡片和 toast 布局，完成后运行
   `/factorio-ai-assistant-mock clear` 并重启 Companion。
2. 有可控存档时临时调低一个规则持续门槛，制造一次缺电或断料；等待告警打开。
3. 保持条件不变至少 60 秒：同一告警不得按每个 5 秒样本重复弹出。测试后恢复设置。

- [ ] 只出现预期打开/冷却后的提醒，没有重复告警风暴。
- [ ] 静音与恢复该规则有效，Alerts 证据与当前聚合数据一致。

## 5. 断网/停服降级与恢复（2–4 分钟）

1. 保持游戏运行，关闭 Companion；约 10 秒后标题应变为 Offline。
2. Chat 不再发送；Calculator 输入仍保留；Alerts 仍可看但标记可能过期。
3. 重新运行 `start-companion.cmd`；约 5 秒内应重连并恢复同步。

- [ ] 断开和重连没有未处理异常、卡死或自动修改工厂。

## 6. 日志与失败反馈（2–4 分钟）

运行 PowerShell：

```powershell
.\collect-diagnostics.ps1
```

打开生成的 `diagnostics.zip`，确认只含 Companion 当前日志、`factorio-current.log`、
版本信息和可选的脱敏配置。分享前仍要人工检查本机路径。

失败反馈请包含：

```text
步骤：
预期：
实际：
首次失败时间：
是否可稳定复现：
Windows / Factorio / Mod / Companion 版本：
provider / model（不要提供 Key）：
Steam 启动参数：
SHA-256 是否通过：
diagnostics.zip：
截图或录屏：
```

- [ ] 通过：把清单、诊断包和版本信息交给 Charles。
- [ ] 失败：停止替换/发布，不要反复覆盖日志；按上述模板反馈。
