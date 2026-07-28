# UDP 协议 v1

协议使用 UTF-8 JSON，每个 UDP datagram 恰好包含一个消息。M0 的最大消息大小为
16 KiB。

## 公共信封

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `protocol_version` | integer | 当前固定为 `1` |
| `message_id` | string | 发送方生成的非空唯一 ID，最多 128 字符 |
| `type` | string | `hello` 或 `hello_ack` |
| `tick` | non-negative integer | Factorio 消息的游戏 tick |
| `timestamp` | non-negative integer | Companion 消息的 Unix epoch milliseconds |
| `payload` | object | 消息类型对应的负载 |

`hello` 使用 `tick`，`hello_ack` 使用 `timestamp`。

## `hello`

Factorio Mod 每 300 tick（约 5 秒）发送：

```json
{
  "protocol_version": 1,
  "message_id": "factorio-600-2",
  "type": "hello",
  "tick": 600,
  "payload": {
    "mod_version": "0.1.0"
  }
}
```

## `hello_ack`

Companion 返回到 datagram 的源地址和源端口：

```json
{
  "protocol_version": 1,
  "message_id": "companion-550e8400-e29b-41d4-a716-446655440000",
  "type": "hello_ack",
  "timestamp": 1753680000000,
  "payload": {
    "reply_to": "factorio-600-2",
    "companion_version": "0.1.0"
  }
}
```

Mod 仅接受来自配置的 Companion 端口、且 `reply_to` 对应待处理 `hello` 的响应。

## 错误处理与版本策略

- 非 UTF-8、非 JSON、超过 16 KiB、缺字段或字段类型错误的 packet 会被拒绝。
- 未知 `protocol_version` 以 `UNSUPPORTED_VERSION` 拒绝，不会按 v1 猜测解析。
- 未知 `type` 以 `UNSUPPORTED_TYPE` 拒绝。
- UDP 无连接且不保证送达，因此错误 packet 不返回错误响应，心跳负责重试。
- TypeScript 的权威编解码实现在 `packages/protocol/`；Lua Mod 使用同一 v1 schema
  的最小镜像校验。

## 网络边界

Factorio 的 `helpers.send_udp` 只能发送到 localhost。Companion 也固定绑定
`127.0.0.1`，并且没有可配置 host。M0 协议不包含认证信息或密钥，不应转发到局域网
或公网。
