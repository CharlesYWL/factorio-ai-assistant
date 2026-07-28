# UDP 状态协议 v2

协议使用 UTF-8 JSON，每个 localhost UDP datagram 恰好包含一个消息。传输协议版本
`protocol_version` 和状态 schema 版本 `schema_version` 独立演进；当前分别为 `1`
和 `2`。
任意消息的硬上限为 16 KiB（16,384 bytes）。

TypeScript 权威编解码器位于 `packages/protocol/`，Factorio Mod 在
`factorio-mod/state_collector.lua` 中镜像同一 schema。代表性的 vanilla 2.0 fixture：

- `packages/protocol/fixtures/vanilla-2.0-static-v2.json`
- `packages/protocol/fixtures/vanilla-2.0-dynamic-v2.json`

## 公共信封

| 字段 | 类型 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- | --- |
| `protocol_version` | integer | 固定 `1` | 每条消息 | 协议元数据 |
| `schema_version` | integer | 状态消息固定 `2`；`hello*` 不使用 | 每条状态消息 | 协议元数据 |
| `message_id` | string | 发送方生成，最多 128 字符 | 每条消息唯一 | 协议元数据 |
| `type` | string | 消息类型 | 每条消息 | 协议元数据 |
| `tick` | non-negative integer | `game.tick`，tick | Mod 发出的消息 | 聚合时序 |
| `timestamp` | non-negative integer | Companion `Date.now()`，Unix ms | Companion 发出的消息 | 聚合时序 |
| `payload` | object | 类型对应负载 | 每条消息 | 见下表 |

状态消息类型为 `static_snapshot`、`static_delta`、`dynamic_snapshot`、
`state_ack`、`resync_request` 和 `advisor_update`。连接心跳继续使用
`hello` / `hello_ack`。

## 连接与静态状态同步

### `hello`

Mod 每 300 tick（约 5 秒）发送：

```json
{
  "protocol_version": 1,
  "message_id": "factorio-hello-600-2",
  "type": "hello",
  "tick": 600,
  "payload": {
    "mod_version": "0.1.0",
    "advisor_config": {
      "quiet_mode": false,
      "muted_rules": [],
      "notification_cooldown_ticks": 18000,
      "critical_power_bypass": true,
      "recovery_ticks": 1800,
      "research_idle_ticks": 36000,
      "power_satisfaction_threshold": 0.9,
      "critical_power_threshold": 0.5,
      "power_low_ticks": 3600,
      "lubricant_zero_ticks": 36000,
      "oil_imbalance_ticks": 18000,
      "oil_surplus_min_per_minute": 60,
      "petroleum_deficit_min_per_minute": 30,
      "science_stable_ticks": 36000,
      "blue_science_min_per_minute": 15,
      "material_deficit_ratio": 1.1,
      "material_deficit_min_per_minute": 30,
      "material_deficit_ticks": 18000,
      "crude_decline_ratio": 0.5,
      "crude_baseline_min_per_minute": 60,
      "crude_decline_ticks": 18000,
      "key_material_baseline_min_per_minute": 30,
      "production_stop_ticks": 10800
    }
  }
}
```

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `payload.mod_version` | `script.active_mods["factorio-ai-assistant"]` | 心跳 | Mod 标识 |
| `payload.advisor_config` | runtime-global Mod 设置；旧 Mod 可省略 | 心跳 / 设置变化 | 本地配置 |
| `payload.advisor_config.muted_rules[]` | 已知规则 ID | 同上 | 本地配置 |
| `payload.advisor_config.*_ticks` | 秒 / 分钟设置换算为 60 tick/s | 同上 | 本地配置 |

`advisor_config` 还携带每条规则的数值阈值。完整字段、默认值和单位见
[`advisor.md`](advisor.md)。Companion 对所有字段做类型、范围和规则 ID 校验；
`critical_power_threshold` 不得高于 `power_satisfaction_threshold`。

### `hello_ack`

Companion 返回 datagram 的源端口，并声明当前已完整组装的静态 revision：

```json
{
  "protocol_version": 1,
  "message_id": "companion-550e8400-e29b-41d4-a716-446655440000",
  "type": "hello_ack",
  "timestamp": 1753680000000,
  "payload": {
    "reply_to": "factorio-hello-600-2",
    "companion_version": "0.1.0",
    "static_revision": 3
  }
}
```

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `payload.reply_to` | 收到的 `hello.message_id` | 每次应答 | 协议元数据 |
| `payload.companion_version` | Companion 常量 | 每次应答 | 应用标识 |
| `payload.static_revision` | Companion 内存状态；`0` 表示尚无完整快照 | 每次应答 | 协议元数据 |

旧 Companion 可以省略 `static_revision`。新 Mod 会接受该响应，但只有携带 revision
的 Companion 才能在重启后主动触发完整重同步。

## `static_snapshot`

静态上下文在新存档首次握手、Mod 配置变化、force 上下文变化或 revision 不一致时
生成。配方和机器较多，因此一个逻辑快照会拆成多个 datagram；Companion 只有在所有
chunk 到齐后才原子替换当前状态。空闲期间没有 dirty revision 时不会重复生成相同
快照。

```json
{
  "protocol_version": 1,
  "schema_version": 2,
  "message_id": "factorio-static-3600-4",
  "type": "static_snapshot",
  "tick": 3600,
  "payload": {
    "snapshot_id": "static-3600-1",
    "revision": 1,
    "chunk_index": 0,
    "chunk_count": 3,
    "truncated": false,
    "omitted_records": 0,
    "game": {
      "version": "2.0.72",
      "mods": [{ "id": "base", "version": "2.0.72" }]
    },
    "forces": [],
    "recipes": [],
    "machines": [],
    "modules": []
  }
}
```

### 快照与游戏字段

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `payload.snapshot_id` | `static-{tick}-{revision}` | 每个完整快照 | 协议元数据 |
| `payload.revision` | Mod 单调递增整数 | 完整快照或 delta | 协议元数据 |
| `payload.chunk_index` | 从 `0` 开始 | 每个 chunk | 协议元数据 |
| `payload.chunk_count` | 当前快照 chunk 总数 | 每个完整快照 | 协议元数据 |
| `payload.truncated` | 是否有单条超预算记录被省略 | 每个完整快照 | 质量标记 |
| `payload.omitted_records` | 被省略的 Mod / force fragment / recipe / machine / module 数 | 每个完整快照 | 聚合计数 |
| `payload.game` | 只在 chunk `0` 中出现 | 每个完整快照 | 见下行 |
| `payload.game.version` | `script.active_mods.base` | 启动 / 配置变化 / 重同步 | 游戏标识 |
| `payload.game.mods[].id` | `script.active_mods` 的 Mod ID | 同上 | Mod 标识 |
| `payload.game.mods[].version` | `script.active_mods` 的版本 | 同上 | Mod 标识 |

### force 字段

同一 force 可跨多个 chunk 重复出现，Companion 按 `id` 合并集合。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `forces[].id` | `LuaForce.name` | 完整快照 | 游戏内 ID |
| `forces[].researched_technologies[]` | `force.technologies[*].researched` 为 true 的 technology ID | 完整快照；之后由 delta 更新 | 游戏内 ID 集合 |
| `forces[].available_recipes[]` | `force.recipes[*].enabled` 且非 hidden 的 recipe ID | 完整快照；之后由 delta 更新 | 游戏内 ID 集合 |
| `forces[].recipe_productivity_bonuses[]` | 非零的 `LuaRecipe.productivity_bonus` | 完整快照；之后由 delta 整体替换 | 原型 ID + 静态数值 |
| `recipe_productivity_bonuses[].recipe_id` | recipe ID | 同上 | 原型 ID |
| `recipe_productivity_bonuses[].bonus` | 科技 / force 对该 recipe 的产能加成倍率 | 同上 | 静态数值 |

只采集至少拥有一个玩家的 force；不发送玩家 ID、显示名或玩家列表。

### 配方字段

配方定义来自非 hidden、非 parameter 的 `prototypes.recipe`，按 ID 排序。所有定义都
可分块发送；每个 force 的 `available_recipes` 决定该 force 实际可用的子集。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `recipes[].id` | `LuaRecipePrototype.name` | 完整快照 | 原型 ID |
| `recipes[].category` | `LuaRecipePrototype.category` | 完整快照 | 原型 ID |
| `recipes[].energy_seconds` | `LuaRecipePrototype.energy`，秒 / craft（速度 1） | 完整快照 | 静态数值 |
| `recipes[].ingredients[]` | `LuaRecipePrototype.ingredients` | 完整快照 | 原型 ID + 静态数值 |
| `recipes[].products[]` | `LuaRecipePrototype.products` | 完整快照 | 原型 ID + 静态数值 |
| `recipes[].allowed_effects[]` | `LuaRecipePrototype.allowed_effects` | 完整快照 | 原型 ID 集合 |
| `recipes[].allowed_module_categories[]` | `LuaRecipePrototype.allowed_module_categories` | 完整快照 | 原型 ID 集合 |
| `recipes[].maximum_productivity` | `LuaRecipePrototype.maximum_productivity`，倍率 | 完整快照 | 静态数值 |
| `ingredients/products[].kind` | `item` 或 `fluid` | 完整快照 | 原型分类 |
| `ingredients/products[].id` | item / fluid prototype ID | 完整快照 | 原型 ID |
| `ingredients/products[].amount` | ingredient 原始数量；随机 product 为 `(min+max)/2 × probability`，并计入 `extra_count_fraction` | 完整快照 | 静态数值 |
| `products[].ignored_by_productivity` | 不受产能加成影响的期望产量；无时省略 | 完整快照 | 静态数值 |
| `ingredients/products[].temperature` | 固定流体温度，摄氏度；无约束时省略 | 完整快照 | 静态数值 |
| `ingredients[].minimum_temperature` | 流体最低温度，摄氏度；无约束时省略 | 完整快照 | 静态数值 |
| `ingredients[].maximum_temperature` | 流体最高温度，摄氏度；无约束时省略 | 完整快照 | 静态数值 |

### 机器字段

机器来自拥有 `crafting_categories`、非 character、非 hidden 的
`prototypes.entity`。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `machines[].id` | `LuaEntityPrototype.name` | 完整快照 | 原型 ID |
| `machines[].kind` | `LuaEntityPrototype.type` | 完整快照 | 原型分类 |
| `machines[].crafting_speed` | `get_crafting_speed()`，倍率 | 完整快照 | 静态数值 |
| `machines[].crafting_categories[]` | `crafting_categories` 的 category ID | 完整快照 | 原型 ID 集合 |
| `machines[].module_slots` | `module_inventory_size`，槽位数 | 完整快照 | 静态数值 |
| `machines[].allowed_effects[]` | `LuaEntityPrototype.allowed_effects` | 完整快照 | 原型 ID 集合 |
| `machines[].allowed_module_categories[]` | `LuaEntityPrototype.allowed_module_categories` | 完整快照 | 原型 ID 集合 |

### 插件字段

插件来自具有 `module_effects` 和 `category`、非 hidden 的 `prototypes.item`。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `modules[].id` | `LuaItemPrototype.name` | 完整快照 | 原型 ID |
| `modules[].category` | `LuaItemPrototype.category` | 完整快照 | 原型 ID |
| `modules[].effects` | `LuaItemPrototype.module_effects` | 完整快照 | 静态数值 |
| `effects.consumption/speed/productivity/pollution/quality` | 对应效果倍率；不存在的效果省略 | 完整快照 | 静态数值 |

## `static_delta`

`on_research_finished` / `on_research_reversed` 后只发送集合差异：

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `payload.base_revision` | 变更前 revision | 研究变化 | 协议元数据 |
| `payload.revision` | 必须等于 `base_revision + 1` | 研究变化 | 协议元数据 |
| `payload.force.id` | 发生变化的 force ID | 研究变化 | 游戏内 ID |
| `researched_technologies_added/removed[]` | 与缓存的已研究集合做差 | 研究变化 | 游戏内 ID 集合 |
| `available_recipes_added/removed[]` | 与缓存的可用配方集合做差 | 研究变化 | 游戏内 ID 集合 |
| `recipe_productivity_bonuses[]` | 变化后该 force 的完整非零 recipe 产能加成列表 | 研究变化 | 原型 ID + 静态数值 |

若 delta 超过 16 KiB、前序 revision 尚未确认或 Companion 的 base revision 不匹配，
Mod / Companion 会改用完整快照，不会猜测合并。

## `dynamic_snapshot`

默认每 300 tick（约 5 秒）读取 Factorio 已维护的统计聚合，不遍历全图实体：

```json
{
  "protocol_version": 1,
  "schema_version": 2,
  "message_id": "factorio-dynamic-3900-8",
  "type": "dynamic_snapshot",
  "tick": 3900,
  "payload": {
    "sample_interval_ticks": 300,
    "sample_sequence": 1,
    "truncated": false,
    "omitted_forces": 0,
    "omitted_series": 0,
    "forces": []
  }
}
```

### 采样和 force 字段

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `sample_interval_ticks` | 固定 `300` tick | 每次采样 | 聚合时序 |
| `sample_sequence` | 存档内单调递增计数 | 每次采样 | 协议元数据 |
| `truncated` | 任一 force / series 被裁剪时为 true | 每次采样 | 质量标记 |
| `omitted_forces` | 超过 16 个 playable force 后省略的数量 | 每次采样 | 聚合计数 |
| `omitted_series` | 超过候选上限或字节预算后省略的 item / fluid series 数 | 每次采样 | 聚合计数 |
| `forces[].id` | `LuaForce.name` | 每次采样 | 游戏内 ID |
| `forces[].research` | 无当前研究时为 `null` | 每次采样 | 聚合状态 |
| `research.technology_id` | `force.current_research.name` | 每次采样 | 原型 ID |
| `research.progress` | `force.research_progress`，`0..1` | 每次采样 | 聚合数值 |

### 物品和流体字段

item 来自 `force.get_item_production_statistics(surface)`，fluid 来自
`get_fluid_production_statistics(surface)`，再跨 surface 求和。Factorio 对非电力
`get_flow_count` 的返回值已归一化为“每分钟”；因此 1m / 10m 字段都是不同滚动窗口
下的每分钟速率，不是窗口总量。数值保留到 `0.001 / min`。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `items/fluids[].id` | statistics 中出现的 prototype ID | 每次采样 | 原型 ID |
| `produced_per_minute_1m` | `category=input`, one-minute precision，单位 / min | 每次采样 | 聚合数值 |
| `consumed_per_minute_1m` | `category=output`, one-minute precision，单位 / min | 每次采样 | 聚合数值 |
| `produced_per_minute_10m` | `category=input`, ten-minutes precision，单位 / min | 每次采样 | 聚合数值 |
| `consumed_per_minute_10m` | `category=output`, ten-minutes precision，单位 / min | 每次采样 | 聚合数值 |

### 发电字段

Mod 在初始化 / 配置变化时只扫描一次 electric pole，并通过 build / mine / death /
clone / script raised 事件维护 pole 缓存。采样时按 `surface.index +
electric_network_id` 去重网络，读取每个网络已有的 `electric_network_statistics`。

| 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `power.network_count` | 缓存 pole 可达且去重后的网络数 | 每次采样 | 聚合计数 |
| `power.generated_watts` | electric statistics `output` 一分钟流量 × 60，W | 每次采样 | 聚合数值 |
| `power.consumed_watts` | electric statistics `input` 一分钟流量 × 60，W | 每次采样 | 聚合数值 |
| `power.satisfaction_ratio` | 无消费时为 `1`，否则 `min(1, generated / consumed)` | 每次采样 | 聚合数值 |

Factorio 2.0 不暴露整个 force 的理论需求上限，因此
`satisfaction_ratio` 表示已交付电量的供需平衡（含统计中的蓄电池流量），不是未供电
机器的理论需求百分比。

## `advisor_update`

Companion 在告警打开、关闭或冷却后提醒时发送。活动告警的变化始终发给 Mod 以更新
侧栏；只有 `proactive: true` 才产生主动聊天提示。消息无需确认，下一个生命周期事件
会覆盖同一告警 ID 的状态。

```json
{
  "protocol_version": 1,
  "schema_version": 2,
  "message_id": "companion-advisor-550e8400-e29b-41d4-a716-446655440000",
  "type": "advisor_update",
  "timestamp": 1753680000000,
  "payload": {
    "event": "opened",
    "proactive": true,
    "alert": {
      "id": "power-low:player",
      "rule_id": "power-low",
      "force_id": "player",
      "severity": "critical",
      "evidence": "Power satisfaction is 40% (40 MW generated, 100 MW consumed).",
      "recommendation": "Add generation or fuel, isolate nonessential loads, and inspect overloaded networks.",
      "first_seen": 3600,
      "last_seen": 7200
    }
  }
}
```

| 字段 | 类型 / 来源 | 说明 |
| --- | --- | --- |
| `payload.event` | `opened` / `reminder` / `closed` | 告警生命周期事件 |
| `payload.proactive` | boolean | 是否主动显示；`closed` 始终为 false |
| `alert.id` | `<rule-id>:<force-id>` | 去重键 |
| `alert.rule_id` | 已知规则 ID | 决定本地化标题和规则静音 |
| `alert.force_id` | force ID | 只向对应 force 的玩家主动提示 |
| `alert.severity` | `info` / `warning` / `critical` | 严重程度 |
| `alert.evidence` | 最多 1,024 字符 | 包含实际触发数值的证据 |
| `alert.recommendation` | 最多 1,024 字符 | 可执行建议 |
| `alert.first_seen` | Factorio tick | 本次问题首次连续出现 |
| `alert.last_seen` | Factorio tick | 最近一次确认问题仍存在 |

## 大小上限和可预测裁剪

- 所有 datagram 在 Mod 和 Companion 两侧都以 UTF-8 byte length 执行 16 KiB 硬上限。
- 静态 chunk 使用 15,872-byte 内部目标，保留 512 bytes 给最终 chunk 计数和截断
  元数据；记录按 force、recipe ID、machine ID 的固定顺序贪心分块。
- 动态候选先按
  `1m produced + 1m consumed + 10m produced + 10m consumed` 降序，再按
  force ID、kind、prototype ID 排序。每个 force / kind 最多保留 128 条，最多
  16 个 force；随后按上述固定顺序装入 byte budget。
- 超限时只从低活动候选开始省略，并设置 `truncated`、`omitted_forces` 和
  `omitted_series`。同一输入状态得到相同裁剪结果。
- 首次样本、截断计数变化时、以及每 12 个样本（约 1 分钟），Mod 在
  `factorio-current.log` 记录采样间隔、`LuaProfiler` 耗时、消息 byte 数和省略计数。

## 确认、重试和重同步

- Companion 对每个有效 `static_snapshot` chunk 和 `static_delta` 返回 `state_ack`，
  `payload.reply_to` 是被确认的 `message_id`，`payload.revision` 是对应 revision。
- Mod 只重试未确认的静态 packet，间隔 300 tick；全部确认后空闲，不周期重发静态
  内容。
- Companion 原子组装完整 chunk 集合；重复 packet 幂等处理，冲突 chunk 或 delta
  revision gap 返回 `resync_request.expected_revision`。
- Mod 收到 `resync_request` 后清除旧 pending packet，并从不小于 Companion
  revision 的下一 revision 发送完整快照。
- `dynamic_snapshot` 是滚动摘要，不确认、不重试；下一个样本自然替代丢失样本。

| 消息 / 字段 | 来源 / 单位 | 刷新条件 | 隐私分类 |
| --- | --- | --- | --- |
| `state_ack.payload.reply_to` | 已接受静态 packet 的 `message_id` | 每个有效 chunk / delta | 协议元数据 |
| `state_ack.payload.revision` | 已接受静态 packet 的 revision | 每个有效 chunk / delta | 协议元数据 |
| `resync_request.payload.expected_revision` | Companion 当前完整静态 revision；无状态时为 `0` | revision gap 或 chunk 冲突 | 协议元数据 |

## 校验、兼容与隐私边界

- 非 UTF-8、非 JSON、超过 16 KiB、缺少已知必填字段、已知字段类型 / 范围错误都会
  被拒绝，不写入 Companion 状态。
- 同一 schema 下的未知字段被忽略，从而允许发送方增加字段；未知
  `protocol_version`、`schema_version` 或 `type` 明确拒绝，不按 v1 猜测。
- 只发送 prototype / force / Mod ID、版本、滚动聚合数值和协议元数据。
- 不发送地图 tile / entity 布局、坐标、玩家名称、玩家聊天、存档内容或密钥。
- `helpers.send_udp` 只能发送到 localhost；Companion 固定绑定 `127.0.0.1`，没有
  可配置 host，也不应通过代理转发到局域网或公网。
