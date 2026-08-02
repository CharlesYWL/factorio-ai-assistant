# 开发模式（热重载）

用于在不重新打包的前提下，边改代码边在游戏里验证。

## 一次性准备

```bash
npm install
```

Factorio 启动项仍需带上（Steam → 属性 → 启动选项）：

```
--enable-lua-udp=34198
```

## 1. 把工作区的 mod 链接进 Factorio

```bash
npm run dev:link
```

会在 `%APPDATA%\Factorio\mods\` 下创建目录联接 `factorio-ai-assistant_0.1.0` 指向仓库的
`factorio-mod/`，并把已安装的 `factorio-ai-assistant_0.1.0.zip` 重命名为
`.zip.disabled` 以免与联接冲突。Windows 上创建目录联接不需要管理员权限。

恢复成打包版本：

```bash
npm run dev:unlink
```

mods 目录不在默认位置时，用 `FACTORIO_MODS_DIR` 覆盖。

### 改动生效范围

| 改动的文件 | 生效方式 |
| --- | --- |
| `control.lua`、`ui.lua`、`state_collector.lua` 等运行期脚本 | 回主菜单重新读档即可 |
| `data.lua`、`settings.lua`、`info.json`、`locale/` | 必须完全重启 Factorio |

## 2. 启动 companion 热重载

```bash
npm run dev
```

它会：

1. 以 `tsc -b --watch` 增量编译整个项目引用图；
2. 监听 `companion/dist` 与 `packages/*/dist` 的产物变化；
3. 防抖 300 ms 后先 `SIGTERM` 关掉旧的 companion 进程（3 秒后强制结束），再启动新的。

配置文件解析顺序：

1. `FACTORIO_ASSISTANT_CONFIG` 环境变量；
2. 仓库根目录的 `companion.config.local.json`（已在 `.gitignore` 中）；
3. `%LOCALAPPDATA%\FactorioAI Assistant\factorio-ai-assistant-companion-0.1.0\companion.config.json`。

日志直接打到终端（不写 `logs/`）。`Ctrl+C` 会一并结束编译器与 companion。

若 watcher 被强制中断（例如终端窗口关闭），companion 子进程可能成为孤儿并继续占用
34197，导致下次启动报 `EADDRINUSE`。用以下命令清理：

```bash
npm run dev:stop
```

它按命令行精确匹配 companion 进程，不会误伤机器上其他 Node 程序。

现在 `npm run dev` 会自动处理这种情况：启动时先清理孤儿进程；若因端口被占导致
companion 起不来，会按 0.5s→1s→2s→4s→8s→15s 递增重试，并在重试前再清一次孤儿。
只有连续 6 次都失败才会放弃，此时终端会打印醒目提示。

> **为什么重要**：companion 没在监听时，游戏发出的包会被静默丢弃——表现是
> **定时提醒消失、提问无响应**，但游戏内没有任何报错。若发现提醒长时间未出现，
> 先看 dev 终端是否有 `EADDRINUSE` 或 `companion is NOT running`。

## 3. 不进游戏直接提问

```bash
node scripts/dev-ask.mjs "每分钟 60 个绿板要多少铜线"
```

它用真实的 UDP 协议向正在运行的 companion 发一条 `assistant_request`，打印 `mode`、
`fallback_reason` 和完整回答。排查对话类 bug 时，这比在游戏里反复点开面板快得多，
而且拿到的是与游戏内完全相同的代码路径。

可用环境变量：`FACTORIO_ASSISTANT_COMPANION_PORT`（默认 34197）、
`FACTORIO_ASSISTANT_FORCE_ID`（默认 `player`）。

用 `--after` 模拟「追问」，不必在游戏里开设置就能验证多轮路径：

```bash
node scripts/dev-ask.mjs "那铜板呢" --after "每分钟60个绿板要多少铜线|需要 1 台组装机。"
```

前提是 companion 已通过 `npm run dev` 启动，且游戏已同步过静态快照
（companion 重启后需等下一次 hello 往返，约 5 秒，否则会返回 `STATE_UNAVAILABLE`）。

### 排查时看什么日志

| 事件 | 含义 |
| --- | --- |
| `static_snapshot_state` | 静态快照是否完整（`truncated`、`recipes` 数量） |
| `assistant_grounding_empty` | 没有证据可用，附带确切的求解器 `error_code` |
| `assistant_model_conflict` | 模型回答被校验拒收，`conflict_type` 说明原因 |
| `assistant_request_completed` | `mode: model` 表示采用模型回答，`local` 表示回退 |

## 典型循环

- **只改 companion（TypeScript）**：保存即可，进程自动重启，游戏内会重新握手，无需重启游戏。
- **只改 mod 运行期 Lua**：保存后回主菜单重新读档。
- **改了 mod 的 data/settings**：保存后完全重启 Factorio。

## 回归到发布产物

```bash
npm run dev:unlink
npm run package
```
