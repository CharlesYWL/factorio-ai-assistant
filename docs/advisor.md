# 本地实时规则顾问

规则顾问完全运行在本机 Companion 中，只读取 Mod 已发送的聚合状态，不调用 LLM，
也不需要 API Key。每 5 秒动态快照到达时进行一次确定性判断；当前告警始终显示在
游戏内侧栏，主动聊天提醒另受全局冷却控制。

有活动告警时，屏幕左上角还会显示常驻提醒卡片，作为主要的可回看入口。玩家可以逐条
忽略：忽略是每玩家的 UI 偏好，只在该告警的当前生命周期内隐藏，告警关闭后再次触发
会重新出现，并且不会影响其它玩家。规则静音（`muted-rules`）是独立开关，静音的规则
不会出现在常驻卡片中。

## 默认规则

所有速率均为 Factorio 统计提供的每分钟滚动速率。`1m` / `10m` 表示一分钟和十分钟
窗口，不是窗口内总量。

| 规则 ID | 默认触发条件 | 持续时间 | 证据 |
| --- | --- | ---: | --- |
| `research-idle` | 没有当前研究 | 10 分钟 | 当前研究为空 |
| `power-low` | 有用电且满足率 `< 0.90`；`<= 0.50` 为严重 | 60 秒 | 满足率、发电 W、用电 W |
| `lubricant-zero` | 已研究 `advanced-oil-processing`，润滑油 1m / 10m 产出均为 0 | 10 分钟 | 科技状态和两个窗口的润滑油产速 |
| `oil-imbalance` | 重油或轻油 10m 净积压 `>= 60/min`，同时石油气 10m 净缺口 `>= 30/min` | 5 分钟 | 积压油品、净积压和石油气净缺口 |
| `robotics-stalled` | 蓝瓶 1m / 10m 均 `>= 15/min`，建设机器人未完成且机器人相关科技不在研究中 | 10 分钟 | 两个窗口的蓝瓶产速和科技进度 |
| `material-deficit` | 关键材料 10m 消费 `>= 30/min` 且超过生产的 `1.10x` | 5 分钟 | 每种短缺材料的 10m 生产 / 消费 |
| `production-decline` | 原油 10m 基线 `>= 60/min` 且 1m 低于 10m 的 `50%`；或关键材料 10m 基线 `>= 30/min` 后 1m 产出归零 | 原油 5 分钟；停线 3 分钟 | 当前 / 基线原油产速或停线材料产速 |

关键材料为铁板、铜板、钢材、电子电路（绿板）和高级电路（红板）。

动态快照被裁剪且规则依赖的 series 缺失时，该样本按“未知”处理：不会用缺失值触发
新告警，也不会错误关闭已有告警。依赖科技集合的规则对被裁剪的静态状态采用相同
策略。

## 告警生命周期和安静策略

- 告警 ID 为 `<rule-id>:<force-id>`；同一 force 的同一问题只保留一条活动告警。
- `first_seen` / `last_seen` 使用 Factorio tick，分别记录本次问题首次连续出现和最近
  一次确认仍存在的时刻。
- 条件中断会清除尚未达到持续门槛的候选，避免抖动触发。
- 活动告警需要连续恢复 30 秒才关闭；短暂恢复不会造成开关抖动。
- 关闭后再次持续发生会重新打开。相同告警的主动提醒仍受自身冷却限制。
- 默认全局最多每 300 秒主动提醒一次。严重电力问题可绕过当前全局槽一次，但仍受
  同一告警的 300 秒冷却约束。
- 全局安静模式只关闭主动聊天提醒，规则仍计算且侧栏仍列出活动告警。
- `Muted advisor rule IDs` 接受逗号分隔的规则 ID；静音规则停止计算并关闭其活动告警。

## 可配置项

以下均为 Factorio 的 `runtime-global` Mod 设置，修改后下一次 `hello` 立即同步到
Companion。

| 设置名（省略 `factorio-ai-assistant-advisor-` 前缀） | 默认值 | 作用 |
| --- | ---: | --- |
| `quiet-mode` | `false` | 全局安静模式 |
| `muted-rules` | 空 | 逗号分隔的规则 ID |
| `notification-cooldown-seconds` | `300` | 全局主动提醒及同一告警重复提醒冷却 |
| `critical-power-bypass` | `true` | 严重电力告警是否可绕过全局冷却 |
| `recovery-seconds` | `30` | 告警关闭前的连续恢复时间 |
| `research-idle-minutes` | `10` | 研究空闲持续门槛 |
| `power-satisfaction-threshold` | `0.90` | 低电力触发阈值 |
| `critical-power-threshold` | `0.50` | 严重电力阈值；运行时不高于普通阈值 |
| `power-low-seconds` | `60` | 低电力持续门槛 |
| `lubricant-zero-minutes` | `10` | 润滑油零产出持续门槛 |
| `oil-imbalance-minutes` | `5` | 炼油失衡持续门槛 |
| `oil-surplus-min-per-minute` | `60` | 重油 / 轻油 10m 最低净积压 |
| `petroleum-deficit-min-per-minute` | `30` | 石油气 10m 最低净缺口 |
| `science-stable-minutes` | `10` | 蓝瓶稳定持续门槛 |
| `blue-science-min-per-minute` | `15` | 蓝瓶 1m / 10m 最低产速 |
| `material-deficit-ratio` | `1.10` | 关键材料最低消费 / 生产倍率 |
| `material-deficit-min-per-minute` | `30` | 关键材料最低 10m 消费 |
| `material-deficit-minutes` | `5` | 关键材料缺口持续门槛 |
| `crude-decline-ratio` | `0.50` | 原油 1m / 10m 最低比例 |
| `crude-baseline-min-per-minute` | `60` | 原油最低 10m 基线 |
| `crude-decline-minutes` | `5` | 原油衰减持续门槛 |
| `key-material-baseline-min-per-minute` | `30` | 停线判断所需的最低 10m 产速 |
| `production-stop-minutes` | `3` | 关键产线 1m 归零持续门槛 |

`muted-rules` 中无法识别的值会被 Mod 忽略，不会阻断 Companion 连接。

## 与内置流程指南的关系

实时规则顾问只回答“现在哪里不对”，不回答“下一步做什么”。后者由内置的 Factorio 2.0
原版流程指南提供，见 [`docs/guide.md`](guide.md)。两者在同一条回答里协作：活动告警派生的
步骤排在通用流程步骤之前，先修当前产线再推进阶段目标；两者对裁剪快照采用同一套
“未知不等于 0”的策略。
