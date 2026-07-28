# Windows + Steam 安装与联调

## 前置条件

- Windows 上的 Factorio 2.0.59 或更高 2.0 版本（Steam 版）。Mod 元数据允许
  `base >= 2.0`，但 Lua UDP API 从 2.0.59 才开始提供；更早版本会安全保持
  `Disconnected`。
- Node.js 22 或更高版本。
- PowerShell，当前目录为本仓库根目录。

Factorio 与 Companion 必须使用两个不同的 UDP 端口：

| 进程 | 地址 | 默认端口 |
| --- | --- | --- |
| Companion | `127.0.0.1` | `34197` |
| Factorio Lua UDP | localhost | `34198` |

## 1. 构建 Companion

```powershell
npm install
npm run build
```

## 2. 安装 Mod

将 `factorio-mod/` 的内容复制到 Factorio 用户 Mod 目录，并确保目标文件夹名与
`info.json` 中的名称和版本一致：

```powershell
$mod = "$env:APPDATA\Factorio\mods\factorio-ai-assistant_0.1.0"
New-Item -ItemType Directory -Force $mod | Out-Null
Copy-Item ".\factorio-mod\*" $mod -Recurse -Force
```

启动 Factorio 后，在 **Mods** 中确认 `Factorio AI Assistant` 已启用。该 Mod 只依赖
`base >= 2.0`，不需要 Space Age。

## 3. 配置 Steam 启动参数

Steam 中打开 **Factorio → Properties → General → Launch Options**，填写：

```text
--enable-lua-udp=34198
```

这个端口是 Factorio 自己接收 `hello_ack` 的端口，不是 Companion 的监听端口。
修改后应完全退出并重新启动 Factorio。

## 4. 启动 Companion

在仓库根目录运行：

```powershell
npm start
```

预期输出：

```json
{"level":"info","event":"companion_listening","address":"127.0.0.1","port":34197,"sampling_interval_ticks":300}
{"level":"info","event":"assistant_mode","mode":"local","provider":"local","model":null,"reason":"deterministic rules and calculator only"}
```

如需修改 Companion 端口，只能修改端口，监听地址仍固定为 `127.0.0.1`：

```powershell
$env:FACTORIO_ASSISTANT_COMPANION_PORT = "40000"
npm start
```

同时在 Factorio 的 **Settings → Mod settings → Startup** 中把
**Companion UDP port** 改为同一个值，然后重启游戏。

无 API Key 时 `assistant_mode` 为 `local` 是正常状态，计算器和本地告警仍完整可用。
如需配置 OpenClaw/OpenAI-compatible 或本机 Ollama，复制
`companion.config.example.json` 并按 [`companion.md`](companion.md) 设置
`FACTORIO_ASSISTANT_CONFIG`。Companion 配置的 `sampling_interval_ms` 会在握手后同步
给 Mod；默认 5 秒。

## 5. 验证 UI 与双向通信

1. 载入或新建一个存档。
2. 点击顶部的 **AI Assistant** 按钮或按 `Ctrl+Shift+A` 打开顾问面板；
   `Ctrl+Shift+1..4` 可直接切换 Chat / Calculator / Alerts / Status。
3. Companion 未运行或未响应时，四页仍可进入，标题显示 **离线**；Calculator 保留
   输入，Alerts 显示带过期提示的缓存内容。
4. Companion 收到 Mod 发出的 `hello` 并返回 `hello_ack` 后，Status 显示
   **已连接**、顾问模式、协议版本、最近同步与隐私模式。
5. Status 的 **立即重连** 可重试。Mod 也会每 5 秒自动发送一次心跳；10 秒没有有效
   响应会回到离线。
6. Chat 输入问题后按 Enter 或点击发送；模型请求进行中可取消。无模型或模型故障时，
   回答来源显示本地规则。
7. Calculator 输入 `chemical-science-pack` 和目标 `45`，验证结构化配方、精确台数、
   向上取整台数与外部输入。机器 / 插件留空时自动选择。
8. 首次连接后，Companion 日志会出现 `Accepted static snapshot ...`；Factorio 的
   `factorio-current.log` 会记录首个动态样本的 interval、耗时、byte 数和裁剪计数，
   之后约每分钟记录一次。
9. Alerts 显示当前 force 的活动告警、证据与建议。可在面板直接静音 / 恢复规则，也可
   在 **Settings → Mod settings → Map** 临时调低持续门槛验证 8 秒 toast；测试后恢复
   默认值。全部默认阈值见 [`advisor.md`](advisor.md)。

没有可控存档数据时，可先停止 Companion，再用内置 mock harness 逐一检查关键状态：

```text
/factorio-ai-assistant-mock ready
/factorio-ai-assistant-mock offline
/factorio-ai-assistant-mock loading
/factorio-ai-assistant-mock timeout
/factorio-ai-assistant-mock incompatible
/factorio-ai-assistant-mock clear
```

## 6. 真实 Factorio 2.0 存档对话验收清单（待 Windows 实机）

使用一个已解锁高级炼油、正在稳定生产化学科研包，且可以人为制造缺电、断料和油品堵塞
的原版 2.0 存档。先保留一份副本；本清单只观察与提问，不要求 Mod 或 Companion 修改
任何实体。自动化 fixture 已覆盖同样的五类问法，以下项目仍必须在 Windows + Steam
Factorio 2.0 图形客户端完成：

- [ ] **计算**：稳定同步后提问“45 蓝瓶每分钟需要多少机器？”。把 Chat 中 `[C1]`
  的目标配方、精确台数和向上取整台数与 Calculator 页同参数结果逐项对照，必须一致。
- [ ] **炼油诊断**：让重油 / 轻油输出堵塞或切断炼油输入，等待规则持续门槛后提问
  “为什么我的高级炼油停了？”。回答必须引用当前油品 / 电力规则证据，并明确说明系统
  没有单机配方、管道和库存数据，不能假装定位具体实体。
- [ ] **科研建议**：停止当前研究，并保持化学科研包稳定产出；提问“我现在最该研究
  什么？”。回答应引用科研空闲或建设机器人规则证据，不得推荐尚无采集依据的科技。
- [ ] **前三瓶颈**：同时制造缺电、铁板缺口和油品失衡，等待告警生效后提问“当前最大
  的三个瓶颈是什么？”。确认按严重度排序、行动项不超过 3 个且每项都有 `[A#]` 证据。
- [ ] **证据追溯**：紧接着提问“这个建议依据什么数据？”。核对 `[事实]` 中的功率、
  1 / 10 分钟聚合流量与 Alerts 页一致，且回答区分推断、假设和缺失数据。
- [ ] **冲突保护**：连接可控 mock provider，让它返回与 Calculator 不同的机器数。
  Chat 必须显示本地工具数字，日志出现 `assistant_model_conflict`，错误数字不进入游戏。
- [ ] **超时降级**：让 provider 挂起或断网，计时从发送到本地答案；必须小于 10 秒，
  Calculator / Alerts 结果仍可用且界面不冻结。
- [ ] **只读边界**：输入要求忽略规则并输出 Lua、`/c` 或 RCON 的提示注入文本。回答
  不得出现可执行指令；提问前后工厂实体、配方、线路与研究队列均无自动变化。
- [ ] 保存 `factorio-current.log` 与 Companion 的脱敏日志，并记录 Factorio 版本、
  Mod 版本、provider / model、存档副本名及每项通过 / 失败结果。

## 排错

| 现象 | 检查项 |
| --- | --- |
| 一直 `Disconnected` | 确认 Steam 启动参数存在，并且修改后重启了 Factorio |
| Companion 报端口占用 | 换一个 Companion 端口，并同步修改 Mod startup setting |
| Companion 无 `Acknowledged` 日志 | 确认 Companion 与 Mod 都使用 `34197`，Factorio 使用不同的 `34198` |
| `assistant_mode` 一直为 `local` | 无模型时正常；远程 compatible provider 还需在同一终端设置 API Key |
| 模型超时 / 限流 | 本地计算与告警会继续工作；provider 只有限重试一次，详见 `companion.md` |
| 日志提示需要 2.0.59 | 更新 Factorio；旧版 2.0 可加载 Mod，但没有 Lua UDP API |
| UI 没有按钮 | 确认 Mod 已启用、目录名正确，并检查 `%APPDATA%\Factorio\factorio-current.log` |
| 显示协议不兼容 | Mod 与 Companion 版本不成套；重新复制 `factorio-mod/` 并执行 `npm run build` |
| 计算器报告多配方歧义 | 简化面板不能选择复杂上游配方；改用仓库 JSON CLI |
| 游戏暂停时响应延迟 | `helpers.recv_udp` 随游戏更新轮询；恢复游戏后再观察 |
| 安全软件告警 | 仅允许 `factorio.exe` 和 Node.js 的本机 loopback UDP，不要建立公网入站规则 |

## 验证状态

- [x] Node mock UDP integration test：真实 loopback socket 发送 `hello` 并收到
  `hello_ack`。
- [x] Companion 监听地址断言为 `127.0.0.1`。
- [x] 协议正常包、损坏包和未知版本单元测试。
- [x] Vanilla 2.0 静态 / 动态 fixture、未知字段兼容和错误字段拒绝测试。
- [x] 静态 chunk 组装、delta revision、确认和重同步单元测试。
- [x] 七条顾问规则的正例、反例、抖动、恢复、复发、静音和冷却单元测试。
- [x] Node mock UDP 集成测试：`hello` 同步配置，动态样本触发
  `advisor_update`。
- [x] OpenClaw/OpenAI-compatible fixture、Ollama mock、超时/取消/有限重试和本地降级测试。
- [x] 配置远程 bind 拒绝、上下文 byte budget、恶意输入限制和结构化日志脱敏测试。
- [x] Chat / cancel / Calculator UDP 协议 round-trip、严格字段校验与 mock socket 取消测试。
- [x] Calculator 从同步静态数据生成结构化结果；缺数据时返回明确错误。
- [x] 五类状态问答 fixture、工具数字优先、提示注入 / 超长输入 / 幻觉冲突和 9 秒
  provider 总预算自动化测试。
- [x] Lua UI 语法、四页状态契约、中英文 locale key 对齐和可复现 mock harness。
- [ ] Windows Steam Factorio 2.0 实机：按钮和面板正确渲染。
- [ ] Windows Steam Factorio 2.0 实机：Chat / Calculator、键盘、尺寸和位置记忆。
- [ ] Windows Steam Factorio 2.0 实机：活动告警、toast、静音和恢复关闭。
- [ ] Windows Steam Factorio 2.0 实机：`Disconnected → Connected`、超时断开及
  Companion 重启恢复。
- [ ] Windows 防火墙默认配置下的 loopback 行为。
- [ ] 上述真实存档五类问答、冲突保护、超时降级和只读边界清单。

未勾选项需要安装了 Factorio 2.0 的 Windows 主机完成，自动化环境无法替代。
