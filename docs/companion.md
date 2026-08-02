# Companion 配置、安全与故障排查

Companion 默认不连接模型，以 `local` 模式启动：聊天触发的精确生产计算、状态同步和
本地规则顾问全部可用。配置 OpenClaw / OpenAI-compatible 或 Ollama 后，后续对话 UI 可通过同一
`AssistantService` 调用模型；模型失败时仍返回本地计算或规则答案。

## 启动与配置优先级

配置优先级为环境变量、`FACTORIO_ASSISTANT_CONFIG` 指向的本机 JSON 文件、内置默认值。
示例文件为 [`companion.config.example.json`](../companion.config.example.json)。

Release ZIP 用户直接运行 `start-companion.cmd`；脚本检查 Node.js 22，把输出写入
`logs/companion-current.log`，并在存在 `companion.config.json` 时自动使用它。
`node companion.mjs --version` 可在排错时输出 Companion 版本。

```powershell
Copy-Item .\companion.config.example.json "$env:LOCALAPPDATA\factorio-ai-assistant.json"
$env:FACTORIO_ASSISTANT_CONFIG = "$env:LOCALAPPDATA\factorio-ai-assistant.json"
npm start
```

启动日志是单行 JSON。无模型时会明确记录：

```json
{"level":"info","event":"assistant_mode","mode":"local","provider":"local","model":null,"reason":"deterministic rules and deterministic calculations only"}
```

| JSON 字段 | 环境变量 | 默认值 / 约束 |
| --- | --- | --- |
| `host` | `FACTORIO_ASSISTANT_HOST` | 只能是 `127.0.0.1`；其他地址直接拒绝启动 |
| `port` | `FACTORIO_ASSISTANT_COMPANION_PORT` | `34197`，范围 `1..65535` |
| `language` | `FACTORIO_ASSISTANT_LANGUAGE` | `zh-CN`；也支持 `en` |
| `sampling_interval_ms` | `FACTORIO_ASSISTANT_SAMPLING_INTERVAL_MS` | `5000`；整秒，范围 `1000..60000` |
| `provider` | `FACTORIO_ASSISTANT_PROVIDER` | `local`；也支持 `openclaw` / `openai-compatible` / `openai` / `ollama` |
| `model` | `FACTORIO_ASSISTANT_MODEL` | compatible 默认 `gpt-4o-mini`；Ollama 默认 `llama3.2` |
| `provider_url` | `FACTORIO_ASSISTANT_PROVIDER_URL` | OpenClaw-compatible 默认 `http://127.0.0.1:18789/v1`；Ollama 默认 `http://127.0.0.1:11434` |
| `api_key` | `FACTORIO_ASSISTANT_API_KEY` | 无默认值；只从环境或所选本机配置文件读取 |
| `model_timeout_ms` | `FACTORIO_ASSISTANT_MODEL_TIMEOUT_MS` | 每次尝试 `30000`，范围 `250..90000`。开放式问题（如「油电还是蒸汽」）需要生成数百字推理，实测本地端点约 17 秒，云端更慢 |
| `model_retry_count` | `FACTORIO_ASSISTANT_MODEL_RETRY_COUNT` | `1`；只能是 `0` 或 `1` |
| `context_budget_bytes` | `FACTORIO_ASSISTANT_CONTEXT_BUDGET_BYTES` | `60000`，范围 `1024..524288`。发给模型走 HTTP，不受 UDP 的 16 KiB 限制 |
| `max_output_tokens` | `FACTORIO_ASSISTANT_MAX_OUTPUT_TOKENS` | `1600`，范围 `64..4096` |
| `history_directory` | `FACTORIO_ASSISTANT_HISTORY_DIR` | `history`；每个存档一个 `.jsonl` 文件 |

JSON 配置只接受表中的字段。`provider_url` 必须是绝对 `http(s)` URL，不能携带 URL
用户名、密码、query 或 fragment。不要把含 `api_key` 的实际配置提交到仓库；`.env`
文件已被忽略。共享电脑上优先使用当前进程环境变量，并限制配置文件的读取权限。

## Provider

### OpenClaw / OpenAI-compatible

适配器调用 `<provider_url>/chat/completions`，使用标准 chat-completions
`messages`、`model`、`temperature` 和 `max_tokens`。远程 endpoint 没有
`FACTORIO_ASSISTANT_API_KEY` 时不会启用，而是保持本地模式；localhost 上的 OpenClaw
gateway 可按本机配置使用无鉴权模式。

```powershell
$env:FACTORIO_ASSISTANT_PROVIDER = "openclaw"
$env:FACTORIO_ASSISTANT_PROVIDER_URL = "http://127.0.0.1:18789/v1"
$env:FACTORIO_ASSISTANT_MODEL = "your-model"
npm start
```

远程 OpenAI-compatible 服务还需在启动 Companion 的同一终端设置：

```powershell
$env:FACTORIO_ASSISTANT_API_KEY = "..."
```

### Ollama

Ollama 走本机 `<provider_url>/api/chat`，强制 `stream: false`，无需 API Key：

```powershell
$env:FACTORIO_ASSISTANT_PROVIDER = "ollama"
$env:FACTORIO_ASSISTANT_MODEL = "llama3.2"
npm start
```

## 超时、重试与降级

- 每次模型调用都有独立 `AbortSignal`；玩家取消会立即向 provider 传播且不重试。
- 仅网络错误、HTTP `408/425/429/5xx` 和超时可重试，最多一次；schema 错误和其他
  `4xx` 不重试。所有尝试共享 30 秒硬上限；慢模型建议配置单次 30 秒并关闭重试，
  游戏内请求会等待最多 40 秒，随后才显示本地超时结果。
- provider 响应硬限制为 64 KiB，最终回答限制为 16,384 字符。空 body、错误 UTF-8、
  错误 JSON 或错误字段都会安全降级。
- 模型不可用、限流或超时后，已有确定性计算结果优先返回；否则返回最多 3 条本地告警；
  没有本地结果时明确说明本地模式。模型调用不运行在 Factorio 游戏线程。

## 只读工具与回答约束

Assistant 在调用模型前先按问题执行受限的本地工具，模型不能提交任意函数名或参数：

| 工具 | 输入边界 | 输出 |
| --- | --- | --- |
| `calculate_production_ratio` | 当前 force、物品 / 流体 prototype ID、正数每分钟目标 | 目标配方、精确机器数、向上取整机器数与计算假设 |
| `read_advisor_alerts` | 当前 force，固定上限 `1..3` | 已触发规则的严重度、证据与建议 |
| `read_progression_guide` | 当前 force，步骤上限 `1..3` | 内置 Factorio 2.0 原版流程指南判定的当前阶段、有顺序的下一步、数据缺口与资料来源 |

“红 / 绿 / 黑 / 蓝 / 紫 / 黄 / 白瓶”和同步状态中的 prototype ID 可映射为计算目标；
缺少 force、目标、速率或完整静态状态时工具返回明确错误，不把缺失值交给模型猜测。
`read_progression_guide` 在完全没有同步状态时返回 `STATE_UNAVAILABLE`，但仍给出通用阶段
说明，并在缺失数据中标明这不是对当前工厂的判断；详见 [`docs/guide.md`](guide.md)。
回答由 Companion 统一渲染 `[事实]`、`[计算结果]`、`[流程指南]`、`[推断]`、`[缺失数据]`、
`[假设]` 和最多 3 个 `[行动]`。每个行动引用 `[C1]`、`[A1]` 或 `[G1]` 形式的工具证据；
有活动告警时，告警派生的行动排在通用流程步骤之前。

模型只允许补充带证据 ID 的简短推断和最多 3 条只读建议；列表会由 Companion 压成
单段文本，不会因为模型使用项目符号而整段丢弃。模型可以逐字复述所引用确定性证据中已有的
阿拉伯数字与单位，但不能新增、换算或估算数字；所有权威数字仍由 Companion 直接渲染。
以下输出会触发
`assistant_model_conflict`，整段模型输出被丢弃并改用本地答案：

- 模型新增证据中不存在的数字、把证据数字换算成其他单位，或没有引用有效证据 ID；
- Lua code block、`/c`、RCON、`remote.call` 等可执行控制内容；
- 声称自动建造、拆除或修改工厂。

## 上下文与输入边界

问题限制为 2,000 字符且最多 4,096 UTF-8 bytes，控制字符会被拒绝。模型上下文不是
完整状态转储，而是按问题选择并逐项装入 byte budget：

- `recipe_catalog`：本 force 当前可造的**全部配方**，但只有 `id` 与游戏内显示名，
  **不含原料、产物和制作时间**。模型需要这些细节时通过 `get_recipe` 工具索取。
- 当前研究及需要时最多 128 个已研究科技 ID；
- 最多 20 条物品 / 流体聚合产销和电力摘要；
- 严重度最高的最多 3 条活动告警；
- `ore_patches`：本势力**已探索**区域内的矿脉，按 chunk 聚合并把相邻同种矿合并成一片，
  给出中心坐标、剩余储量和覆盖格数。这是模型唯一的「地图」——没有它，「下一个矿点开在
  哪」只能答出方位而给不出位置。
- `selected_area`：玩家框选区域内的机器详情。每台带 `unit`（稳定编号）、`facing`
  （朝向）、`recipe`、`status`、库存与流体；**机械臂另带 `link`**，标明它从哪里取料、
  给到哪里——这是快照里唯一的连接关系，缺了它「这台为什么断料」就只能靠坐标猜。
- 仅当提问玩家自行开启「追问时发送最近对话」时，附带 `recent_turns`：该玩家本人最近
  的问答原文，最旧的先被 budget 挤掉。默认关闭。
- `recent_trend`：最近约 10 分钟的产量变化摘要。它由本地历史计算得出，只发送结论
  而不是原始时间序列。

### 为什么配方目录不带原料

实测一个 200 条配方的存档，把完整配方（含原料）放进上下文要 **31.6 KB，占整个
预算的 87%**，真正反映工厂现状的实时产销只剩 4%。

现在改为 Companion 持有全部配方数据，只把目录发给模型：

| | 字节 |
| --- | ---: |
| 旧：完整配方块 | 21,912 |
| 新：目录（id + 名称） | 4,840 |
| 新：`get_recipe` 取 5 条 | 545 |
| **合计节省** | **75.4%** |

（基准用合成标识符，真实存档的中文名更长，实际收益更高。）

目录必须完整发送而不能按问题裁剪：玩家说「黄瓶」时，这个词在存档里叫「银金分析包」，
按名字匹配会一条都命中不了。模型看得见完整目录才能自己完成这个映射。

### 只读工具

模型只能调用固定的几个工具，参数由 Companion 校验，错误以数据形式返回让模型自我纠正：

| 工具 | 输入边界 | 输出 |
| --- | --- | --- |
| `get_recipe` | 最多 16 个配方 ID | 每条的原料、产物、制作秒数与显示名 |
| `search_recipes` | 至少 2 字符的查询串 | 最多 12 条 ID / 名称匹配 |
| `highlight_entities` | 最多 12 个标注；每个要么给选区内真实存在的 `unit`，要么给 `x`/`y` 坐标 | 在游戏世界与地图上画出彩色方框、文字标签和地图标签 |

标注有两种目标，区别在于能不能校验：

- **`unit`**（已有机器）——会与当前选区比对，模型编造的编号会被拒绝并告知，不会产生
  指向空无一物的标注。同时记录坐标作为后备，实体被拆掉后仍能画出。
- **`x`/`y`**（地图坐标）——无从校验，按原样接受。这正是「建议在这里开矿」「这里该加个泵」
  能被表达出来的前提：**空地上没有实体可引用**。

每个标注会同时产生这些东西：世界里的**彩色方框 + 文字标签**、一个**地图标签**
（chart tag），以及——当严重度是 `problem` 或 `warning` 且目标是真实实体时——一条
**原生告警**。

告警是最容易被注意到的那一层：它出现在游戏右上角的告警列表里，**悬停显示消息、点击
直接把地图跳到那台机器**。它用 `signal-alert` 图标，与引擎自己的警报视觉上区分开，
清除时也按这个图标过滤，不会误删玩家的其他告警。

建议类标注（`info`，例如「建议在此开矿」）**不进告警列表**：告警的语义是「有东西出问题
了」，而不是「你可以在这盖点什么」。它们仍然有世界标注和地图标签。坐标标注同理——原生
告警需要一个实体作为跳转锚点，空地上没有。

标注**不会自动消失**，会一直保留到你手动清除或下一次回答产生新标注（定时消失的问题是
你走过去的路上它就没了）。清除方式：`Ctrl+Shift+C`，或聊天页「清空」旁边的
「清除标注」按钮。清除会同时删掉世界标注、地图标签和告警。

### 矿脉扫描的代价

扫描跑在**游戏主线程**上，中后期地图有几万个矿石实体，直接全扫会掉帧。所以：

- **只走已探索的 chunk**（没探索的地方本来也不该推荐），上限 2048 个
- **按 chunk 聚合**，再把相邻同种矿**洪水填充合并成一片**，避免同一片矿被报成一堆
  32×32 的方格
- **每两游戏分钟才刷新一次**——矿不会跑，5 秒一次的采样频率纯属浪费
- 按储量排序后只留最大的 40 片

聚合后通常只有几 KB，比逐个实体上报小几个数量级。

工具轮次上限为 3。超出后 Companion 会去掉工具再问一次，强制模型用已取到的数据作答，
而不是无限循环直到超时。每轮工具调用都会记 `assistant_tool_call` 日志。

### 超时是分层的

一次提问可能要好几趟模型往返（查配方 → 决定标注 → 写答案），所以等待上限有四层，
**必须从内到外递增**，否则外层会先放弃、把已经算好并付过钱的答案丢掉：

| 层 | 值 | 含义 |
| --- | ---: | --- |
| `model_timeout_ms` | 60s | 单次 HTTP 请求 |
| `MAX_PROVIDER_TOTAL_WAIT_MS` | 90s | 单趟往返，含重试 |
| `MAX_TOOL_LOOP_MS` | 120s | 全部工具轮次 |
| `UI_REQUEST_TIMEOUT_TICKS` | 240s | Mod 界面等待 |

最坏情况是「工具循环耗尽 120s + 最后一次无工具调用 90s = 210s」，Mod 等 240s，
留出 30s 余量。

> 曾经踩过的坑：Mod 侧原本只等 40s，那是加工具调用**之前**定的。一次 48.5s 的请求
> 明明成功产出了答案和 10 个标注，界面却已经报超时——外层比内层紧，是最容易被忽略的
> 错配方式。改动任何一层时，都要重新核对这张表。

> 注意：`/chat/completions` 是无状态协议，每轮都要重放完整对话。所以工具调用省的是
> token，代价是往返延迟——这也是轮次上限存在的原因。

### 回答到达时的界面行为

一次提问可能要等上一两分钟，玩家很可能已经关掉面板去干别的了。所以回答到达时：

- **面板开着**：滚到最新一行（这一条本来就有）。
- **面板关着**：自动以**迷你模式**打开，只显示这条回答和输入框；切出迷你模式时会
  恢复玩家原本的尺寸。
- **`/ai` 提问除外**：那个玩家主动选择了不开面板，答案已经打进聊天区，再弹窗是打扰。

自动打开**不会触发自动暂停**。暂停的语义是「玩家打开面板去思考」，而这次是面板自己
弹出来的——因为一条回答恰好到了就冻结游戏，会打断玩家正在做的事。

## 生产历史

Companion 每游戏分钟记录一个数据点，存在 `history_directory` 下、按存档 ID 命名的
`.jsonl` 文件里，用于回答「产量什么时候开始掉的」「刚才的改动有效果吗」这类问题。

- **降采样**：动态快照每 5 秒一次，但历史每分钟才存一点。原样存储约需 1.4 GB / 100 小时，
  降采样后约 27 MB。趋势类问题不需要更细的分辨率。
- **按存档隔离**：Mod 在初始化时生成一个随机 `save_id` 存进存档，历史以它为键。不同存档
  的时间线不会混，Companion 也永远看不到存档文件名或路径。
- **读档回滚**：`tick` 倒退说明玩家读了更早的存档，晚于该 tick 的历史会被丢弃——那描述的
  是一个不再发生的未来。
- **上限**：默认保留 6,000 个点（约 100 小时游戏时间），超出后丢弃最旧的。
- 旧版 Mod 不发送 `save_id`，此时不记录历史：两个存档共用一条时间线比没有历史更糟。

地图、坐标、玩家名称、存档、完整 prototype 表和 API Key 都不进入模型上下文。
聊天内容默认同样不进入；只有玩家在 Mod 设置里主动开启「追问时发送最近对话」后，
才会附带他**本人**的最近几轮问答，用途仅限解析「那它呢」这类指代。历史由 Mod
持有并随请求发送，Companion 不保存任何会话状态，因此同一势力的其他玩家的对话
永远不会进入你的请求。system prompt 把问题和 JSON context 标记为不可信数据，
明确工具结果优先，规定 `recent_turns` 只能用于解析指代、不得当作证据、不得从中
复述数字，要求用 `localized_names` 的名称而不是原始 ID 作答（没有名称时回退 ID），
并禁止 Lua/RCON 或自动修改工厂；返回文本还会经过同样的本地安全与冲突检查。

## 显示名称同步

Mod 用官方 `request_translation` / `on_string_translated` 机制把当前游戏语言的
prototype 名称通过可选的 `localization_update` 推给 Companion。Companion 缓存最多
4,096 条，`payload.reset` 时整体重置，语言变化时同样重置，未翻译的 ID 原样显示。

Chat 的事实 / 计算 / 行动正文和 Alerts 证据都优先使用这些名称；ID 保留在结构化工具
输出（`target_id`、`recipe_id`、`machine_id`）和 Mod 面板的 tooltip 里，便于调试和
消歧。Companion 语言（`FACTORIO_ASSISTANT_LANGUAGE`）决定句式，游戏 locale 决定
名称，两者独立。

## UDP 与日志安全

- UDP socket 固定绑定 IPv4 `127.0.0.1`。即使配置 `host`，也只接受该值。
- TypeScript codec 在解析前执行 16 KiB 上限和 schema/version 校验。
- `hello`、静态 chunk 和 delta 的响应按来源与 `message_id` 关联。60 秒内的完全相同
  重复包重放同一个 ack；同 ID 不同内容会拒绝。缓存最多 1,024 项。
- Mod 对未确认静态包每 5 秒重试；动态快照由下一次采样自然覆盖。Companion 通过
  `hello_ack.sampling_interval_ticks` 把本机采样配置同步给 Mod。
- 日志默认是结构化 JSON，只记录事件名、request ID、provider、状态码和计数，不记录
  完整问题或状态。字段名包含 key/token/secret/authorization/question/prompt/context/state
  时强制替换为 `[REDACTED]`，Bearer 和常见 `sk-` token 也会二次脱敏。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 启动时报 remote bind refused | 删除 `host` 或改为 `127.0.0.1`；不要监听 LAN / 公网 |
| `assistant_mode` 为 `local` | 默认正常；如需远程 compatible provider，检查 provider URL、model 和当前进程的 API Key |
| OpenClaw / Ollama 连接失败 | 先确认对应本机服务与模型已启动，再检查端口；Companion 会继续提供本地能力 |
| 经常 `timeout` | 检查模型负载；可在安全范围内提高 timeout，或关闭一次重试以更快降级 |
| HTTP `429` | Companion 只重试一次；等待 provider 限流窗口，不要无限重试 |
| `invalid_response` | endpoint 必须返回所选 provider 的非流式 JSON schema，且 body 小于 64 KiB |
| 配置 JSON 无法加载 | 检查 UTF-8 JSON、字段拼写和 64 KiB 文件上限 |
| 日志需要分享 | 可分享结构化事件，但仍应人工检查本机路径；日志设计上不含 key、问题或完整状态 |

Windows release 包可运行 `collect-diagnostics.ps1`。它只收集 Companion 当前日志、
`factorio-current.log`、版本信息和脱敏配置，不收集存档或环境变量；分享前仍要检查本机
路径。
