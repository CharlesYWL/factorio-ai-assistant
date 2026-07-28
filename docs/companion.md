# Companion 配置、安全与故障排查

Companion 默认不连接模型，以 `local` 模式启动：精确计算器、状态同步和本地规则顾问
全部可用。配置 OpenClaw / OpenAI-compatible 或 Ollama 后，后续对话 UI 可通过同一
`AssistantService` 调用模型；模型失败时仍返回本地计算或规则答案。

## 启动与配置优先级

配置优先级为环境变量、`FACTORIO_ASSISTANT_CONFIG` 指向的本机 JSON 文件、内置默认值。
示例文件为 [`companion.config.example.json`](../companion.config.example.json)。

```powershell
Copy-Item .\companion.config.example.json "$env:LOCALAPPDATA\factorio-ai-assistant.json"
$env:FACTORIO_ASSISTANT_CONFIG = "$env:LOCALAPPDATA\factorio-ai-assistant.json"
npm start
```

启动日志是单行 JSON。无模型时会明确记录：

```json
{"level":"info","event":"assistant_mode","mode":"local","provider":"local","model":null,"reason":"deterministic rules and calculator only"}
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
| `model_timeout_ms` | `FACTORIO_ASSISTANT_MODEL_TIMEOUT_MS` | 每次尝试 `4000`，范围 `250..30000` |
| `model_retry_count` | `FACTORIO_ASSISTANT_MODEL_RETRY_COUNT` | `1`；只能是 `0` 或 `1` |
| `context_budget_bytes` | `FACTORIO_ASSISTANT_CONTEXT_BUDGET_BYTES` | `12000`，范围 `1024..65536` |
| `max_output_tokens` | `FACTORIO_ASSISTANT_MAX_OUTPUT_TOKENS` | `800`，范围 `64..4096` |

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
  `4xx` 不重试。默认最坏模型等待约为两次 4 秒尝试加 100 ms 退避。
- provider 响应硬限制为 64 KiB，最终回答限制为 16,384 字符。空 body、错误 UTF-8、
  错误 JSON 或错误字段都会安全降级。
- 模型不可用、限流或超时后，已有确定性计算结果优先返回；否则返回最多 3 条本地告警；
  没有本地结果时明确说明本地模式。模型调用不运行在 Factorio 游戏线程。

## 上下文与输入边界

问题限制为 2,000 字符且最多 4,096 UTF-8 bytes，控制字符会被拒绝。模型上下文不是
完整状态转储，而是按问题选择并逐项装入 byte budget：

- 当前研究及需要时最多 64 个已研究科技 ID；
- 与问题或缺口最相关的最多 16 条物品 / 流体聚合产销和电力摘要；
- 严重度最高的最多 3 条活动告警；
- 确定性计算的目标、机器数、机器 / 插件 / 科技假设和外部原料摘要。

地图、坐标、玩家名称、聊天历史、存档、完整 prototype 表和 API Key 都不进入模型
上下文。system prompt 把问题和 JSON context 标记为不可信数据，并禁止 Lua/RCON
或自动修改工厂。

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
