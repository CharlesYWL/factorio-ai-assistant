# 内置原版流程指南

Companion 内置一套版本化、可审计的 Factorio 2.0 **原版（未安装 Space Age）** 流程指南。
它让顾问在“下一步做什么 / 该扩建什么 / 该研究什么”这类问题上给出**有顺序、有证据**的
计划，而不是复述当前状态。

指南是**仓库内的静态数据**：运行时不联网、不抓攻略、不把网页内容交给模型。
所有结论在开发阶段查证后写入 `packages/guide/src/data.ts`。

- 指南版本：`1.0.0`（修订 1）
- 校对目标：Factorio `2.0.72` 原版 base mod
- 数据入口：`packages/guide/src/data.ts`，引擎：`packages/guide/src/index.ts`
- 阶段 fixture：`packages/guide/fixtures/progression-stages.json`

## 资料来源

下表是本版指南全部结论的出处。访问日期 2026-07-28；适用范围均为 Factorio 2.0 原版
（base mod 2.0.72，未安装 Space Age）。仓库内 `sources[].url` 与本表一一对应，
`npm run check:release` 会校验两者不脱节。

| 来源 ID | 用途 | URL |
| --- | --- | --- |
| `base-technology-2.0.72` | 全部科技 ID、前置、触发条件与瓶数 | https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/technology.lua |
| `base-recipe-2.0.72` | 科研包、火箭部件、炼油与化工配方 | https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/recipe.lua |
| `base-entity-2.0.72` | `rocket_parts_required = 100` | https://github.com/wube/factorio-data/blob/2.0.72/base/prototypes/entity/entities.lua |
| `wiki-technologies` | 科技树总览 | https://wiki.factorio.com/Technologies |
| `wiki-science-pack` | 科研包总览与配比 | https://wiki.factorio.com/Science_pack |
| `wiki-electronics-research` | 2.0 触发科技改动 | https://wiki.factorio.com/Electronics_(research) |
| `wiki-oil-processing-research` | 2.0 石油科技三层拆分 | https://wiki.factorio.com/Oil_processing_(research) |
| `wiki-advanced-oil-processing` | 高级炼油与裂解 | https://wiki.factorio.com/Advanced_oil_processing |
| `wiki-rocket-silo` | 火箭发射井与卫星 | https://wiki.factorio.com/Rocket_silo |

`wube/factorio-data` 是官方发布的 base mod prototype 源码镜像，`2.0.72` tag 与
`packages/calculator/fixtures/vanilla-2.0.72-base.json` 使用同一版本，因此指南、计算器与
协议 fixture 描述的是同一套游戏数据。

### 本版特别核对过的 2.0 变更

- `electronics`、`steam-power`、`automation-science-pack`、`oil-processing`、
  `space-science-pack` 在 2.0 是**触发科技**，不消耗科研瓶。
- 旧的单一 `oil-processing` 研究被拆成 `fluid-handling` → `oil-gathering` → `oil-processing`
  （抽到第一桶原油自动触发）→ `advanced-oil-processing`。
- 原版一枚火箭需要 **100** 个火箭部件；50 个是 Space Age 的数值。
- `bulk-inserter` 为 2.0 重命名（原 `stack-inserter`）。
- `foundry`、`electromagnetic-plant`、`biochamber`、quality、elevated rails 等均为
  Space Age 内容，不出现在本指南中。

## 阶段划分

阶段用**已研究科技**判定：`entry_technologies` 全部已研究的**最高阶段**即当前阶段
（不要求中间阶段连续满足；跳过某个门槛不会把玩家钉在低阶段）。
任一门槛科技因静态状态被裁剪而无法判定时，该阶段不计入匹配，结果标记为
`uncertain`：回答会说“至少处于第 N 阶段”，并在 `[缺失数据]` 中说明实际进度可能更靠后。

| 阶段 | ID | 进入门槛（全部已研究） | 目标 |
| ---: | --- | --- | --- |
| 1 | `bootstrap` | （无） | 手搓过渡到蒸汽电力与第一台实验室 |
| 2 | `automation-red-green` | `automation` | 红瓶、绿瓶自动化并解锁钢材 |
| 3 | `smelting-logistics-military` | `logistic-science-pack`、`steel-processing` | 主线物流、黑瓶与石油前置 |
| 4 | `oil-chemical-blue` | `oil-processing` | 塑料 / 硫磺 / 红电路 / 蓝瓶 / 高级炼油 |
| 5 | `robotics-modules-scale` | `chemical-science-pack` | 建设机器人、插件、蓝电路与规模化 |
| 6 | `production-science` | `robotics`、`productivity-module` | 电炉、铁路与紫瓶 |
| 7 | `utility-science` | `production-science-pack` | 低密度结构、黄瓶与 3 级插件 |
| 8 | `rocket-launch` | `utility-science-pack` | 火箭发射井、100 个火箭部件与卫星 |

## 规则结构

每条规则都可审计，字段固定：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定规则 ID，例如 `guide-4-4-advanced-oil-processing`；答案中直接引用 |
| `order` | 阶段内的执行顺序 |
| `preconditions` | 规则何时适用（科技 / 研究状态 / 流量条件） |
| `objective` | 具体要做的事（中英双语） |
| `rationale` | 为什么现在做（中英双语） |
| `verification` | 怎么确认做完了（中英双语） |
| `verification_signals` | 验证用的结构化信号，可直接对着状态复核 |
| `next_rule_ids` | 建议的后续规则 |
| `source_ids` | 该条结论的资料来源 |

条件类型：`technology_researched`、`technology_missing`、`research_idle`、`research_active`、
`flow_produced_at_least`、`flow_produced_below`、`flow_net_below`。

## 三态判定与数据缺口

条件求值是**三态**的：`met` / `unmet` / `unknown`。

- 未同步的静态状态 → 科技条件为 `unknown`，不会当作“未研究”。
- 静态状态被裁剪且科技不在列表里 → `unknown`（裁剪可能把它删掉了）。
- 未同步的动态快照 → 流量条件为 `unknown`。
- 动态快照**完整**且某产物不在列表里 → 按 0 处理；**被裁剪**时按 `unknown` 处理。

任一前置为 `unknown` 的规则不会变成行动项，而是进入 `data_gaps`，最终显示在
回答的 `[缺失数据]` 段落。这与 [`docs/advisor.md`](advisor.md) 里实时规则顾问的
裁剪策略一致。

## 推理与输出

顾问按下面的顺序组织回答：

1. **当前阶段**（`[流程指南] [G1]`）：阶段序号、名称、判定依据（哪些门槛科技已研究）、下一目标。
2. **先补哪条产线**：有活动告警时，告警派生的步骤**排在通用流程步骤之前**，并引用告警
   证据 `[A1]`／`[A2]`。这保证“有状态时不会忽略当前瓶颈”。
3. **通用流程步骤**：匹配到的指南规则按 `order` 排列，每条引用自己的 `[G2]`、`[G3]`… 证据。
4. **哪些数据不足**：`[缺失数据]` 列出未同步 / 被裁剪 / 无法判定的项。
5. **假设**：明确写出流程建议来自内置指南，不了解本存档的地图布局、库存、皮带和单机状态。

行动项最多 3 条，与既有回答格式一致。没有任何同步状态时，指南退化为**通用阶段澄清**：
给出第 1 阶段说明和全部 8 个阶段概览，并在 `[缺失数据]` 中说明这不是对当前工厂的判断。

模型只能解释已经执行的只读工具结果：数字冲突、无证据引用、额外行动列表或可执行
Lua / RCON 输出仍会被丢弃并回落到本地答案，加入指南不会削弱这层保护。

## 触发方式

| 提问类型 | 意图 | 首个工具 |
| --- | --- | --- |
| “下一步做什么 / 该扩建什么 / 路线 / 阶段” | `planning` | `read_progression_guide` |
| “最该研究什么 / 科技” | `research` | `read_advisor_alerts`（随后追加 `read_progression_guide`） |
| “最大的三个瓶颈” | `bottlenecks` | `read_advisor_alerts` |
| “每分钟 N 个 X 要多少机器 / 怎么配” | `calculation` | `calculate_production_ratio` |

`calculation` 的目标和速率由 Companion 从自然语言解析：常见中文别名（蓝瓶、绿板、
钢材……）、当前游戏语言的同步显示名和静态 catalog 中的 prototype ID 都能命中，玩家
不需要输入内部 ID。解析不出唯一目标或缺速率时返回澄清问题，而不是猜测。

游戏内 Chat 页的第二个快捷按钮（“下一步扩建” / “What to expand”）直接命中 `planning`，
第四个（“产线配比” / “Machine ratio”）直接命中 `calculation`。

## 更新流程

指南是数据，不是代码分支；更新时按下面的顺序做：

1. **确认目标版本**。以 `wube/factorio-data` 对应 tag 的 base mod 为准
   （例如 `git clone https://github.com/wube/factorio-data && git checkout 2.0.72`），
   而不是凭记忆或攻略。同一次更新里 `GUIDE_FACTORIO_VERSION` 和
   `packages/calculator/fixtures/` 的目标版本应保持一致。
2. **核对结论**。技术 ID 以 `base/prototypes/technology.lua` 为准，配方以
   `base/prototypes/recipe.lua` 为准，实体数值（如 `rocket_parts_required`）以
   `base/prototypes/entity/entities.lua` 为准。无法查证的结论不要写入指南。
3. **改数据**。在 `packages/guide/src/data.ts` 增删规则或阶段；
   新增来源时同时写入 `SOURCES`（含 `url`、`accessed`、`applies_to`）并更新本文的来源表。
4. **升版本**。语义化调整 `GUIDE_VERSION`；只改措辞时提升 `GUIDE_REVISION`。
5. **补 fixture**。`packages/guide/fixtures/progression-stages.json` 至少保持
   每个阶段一个 case，新增阶段必须同时新增 fixture。
6. **跑闸门**。`npm run verify`（含 `check:release` 的指南来源一致性校验）与
   `npm run package`、`npm run package:verify` 必须全绿。

指南只描述**原版**流程。加入 Space Age 或其它 Mod 的内容前，需要先扩展
`ProgressionGuide.game` 维度并按 Mod 集合选择指南，不要把 DLC 内容混进 base 指南。
