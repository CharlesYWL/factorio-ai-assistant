# Factorio AI Assistant

Factorio 2.0 原版的只读游戏内顾问。当前 M3 在 localhost UDP 桥接和确定性生产比例
引擎之上提供无需模型的实时规则顾问：持续检测研究、电力、炼油、科技推进、关键材料
缺口和产线衰减，并用证据、建议、去重、恢复与冷却控制安静提醒。系统不发送地图或
聊天，也不会修改工厂。

## 架构

```mermaid
flowchart LR
    M["Factorio 2.0<br/>Lua Mod + sidebar UI"]
    C["Node.js Companion<br/>rules + state + calculator<br/>127.0.0.1:34197"]
    P["Versioned JSON protocol<br/>packages/protocol"]

    M -- "hello + static/delta/dynamic<br/>UDP localhost" --> C
    C -- "ack/resync + advisor_update<br/>UDP localhost" --> M
    M -. "Lua schema mirror" .-> P
    C --> P
```

浏览器可视化版本见 [`docs/architecture.html`](docs/architecture.html)。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `factorio-mod/` | Factorio 2.0 Mod、事件缓存、状态采样和连接面板 |
| `companion/` | 只绑定 `127.0.0.1` 的 Node.js UDP Companion、revision 状态缓存与本地规则顾问 |
| `packages/protocol/` | 严格的版本化消息编解码与校验 |
| `packages/calculator/` | 精确有理数生产流求解器、Factorio 2.0 fixture 与 JSON CLI |
| `docs/` | Windows 安装、协议、规则阈值、排错和实机验证清单 |

## 本地验证

需要 Node.js 22 或更高版本。

```bash
npm install
npm run build
npm test
npm run lint
```

启动 Companion：

```bash
npm start
```

独立运行比例计算器（不需要游戏或 AI Key）：

```bash
npm run calculate -- \
  --catalog packages/calculator/fixtures/vanilla-2.0.72-base.json \
  --request packages/calculator/fixtures/chemical-science-120-per-minute.json \
  --pretty
```

catalog 使用状态协议中的 `recipes`、`machines`、`modules` 和当前 force 的
`recipe_productivity_bonuses`。request 的核心字段如下：

| 字段 | 说明 |
| --- | --- |
| `targets[]` | `kind`、`id`、`rate` 和可选 `unit`（`second` / `minute`） |
| `available_recipe_ids` / `recipe_choices` | 当前可用配方与替代配方显式选择；选择键为 `item:<id>` / `fluid:<id>` |
| `allowed_machine_ids` / `machine_choices` | 允许机器集合与按 recipe ID 的显式机器选择 |
| `module_loadouts` | 按 recipe ID 指定插件 ID 数组；校验槽位、类别和效果限制 |
| `technology_productivity_bonuses` | 按 recipe ID 覆盖当前科技产能加成 |
| `source_resources` | 视为外部供给、不继续展开的原料键 |
| `byproduct_handlers` / `byproduct_policy` | 指定副产物消费配方；`balanced` 要求无剩余，`surplus` 显示剩余 |
| `belt_speeds` | 可选物品带宽档位；默认原版黄 / 红 / 蓝带 `15 / 30 / 45 item/s` |

输出包含每条配方的 craft 速率、精确与向上取整机器数、机器 / 插件 / 科技假设、各层
物品和流体速率、外部原料、副产物及各级传送带需求。循环、不可达目标、替代配方歧义、
不兼容机器 / 插件和无法平衡的多产物流都会返回结构化错误，不会递归死循环。

完整的 Mod 安装、Steam 启动参数和 UI 预期见
[`docs/setup-windows.md`](docs/setup-windows.md)。线协议见
[`docs/protocol.md`](docs/protocol.md)。规则证据、默认阈值、静音和全部玩家可配置项见
[`docs/advisor.md`](docs/advisor.md)。

## 安全边界

- Companion 固定绑定 IPv4 loopback `127.0.0.1`，没有公网监听配置。
- Factorio UDP 必须通过显式启动参数开启。
- 状态只含游戏 / Mod / force / prototype ID 和聚合数值；无坐标、地图、聊天或存档。
- 动态采样每 5 秒读取游戏统计和事件维护的 pole 缓存；没有 `on_tick` 全实体遍历。
- 实时规则顾问不调用模型；无 RCON、远程遥测或自动操作。
- 仓库不读取或存储 API key、令牌等密钥。
