# Todo-List 上游兼容补丁

Factorio AI Assistant 需要把玩家确认过的 AI 建议写进第三方 Mod
[Todo-List](https://mods.factorio.com/mod/Todo-List) 的共享任务列表。Factorio 的 Mod
之间 Lua 状态完全隔离，只能通过 `remote` 接口通信，而 Todo-List 19.15.3 还没有对外接口。

本目录保存**为上游准备的最小补丁**以及可重复构建 / 校验本地 patched ZIP 的脚本。它不是
Factorio AI Assistant 的运行时代码，`factorio-mod/` 和 `companion/` 不会加载这里的任何文件。

> **未获批准前不得公开提交。** 目前 `upstream.json` 里 `upstream_contribution.status` 为
> `not-submitted`：不得创建公开 fork，也不得向 `JonasJurczok/factorio-todo-list` 提交
> PR / issue / 评论。等 Charles 明确批准后再走公开流程。

## 上游出处

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/JonasJurczok/factorio-todo-list |
| 标签 | `v19.15.3`（`info.json` 版本 19.15.3） |
| 提交 | `253f6e3d3c884d367f2351af000cc6b6f497554d` |
| 许可证 | MIT，Copyright (c) 2018 Jonas Jurczok |
| Factorio | 2.1 |

补丁产出的本地版本号是 **19.16.0**（新增功能 → minor 版本）。机器可读的出处记录在
[`upstream.json`](upstream.json)，构建脚本和测试都以它为准。

上游代码是 MIT 授权的第三方作品。本目录只保存我们自己写的差异（`patches/` 下的 diff），
不复制上游源码；构建脚本在运行时按上述提交号自行拉取，patched ZIP 内保留上游 `LICENSE`。

## 补丁做了什么

`patches/0001-add-todo-list-remote-interface.patch`：

| 文件 | 变更 |
| --- | --- |
| `src/todo/features/remote_interface.lua` | 新增，实现整个接口 |
| `src/todo/todo.lua` | `require` 新特性文件 |
| `src/control.lua` | 在 control 阶段加载时调用 `todo.register_remote_interface()` |
| `src/info.json` | 19.15.3 → 19.16.0 |
| `changelog.txt` | 19.16.0 条目 |
| `README.md` | 上游 README 的 API 文档章节 |
| `.luacheckrc` | 声明 `remote` 全局 |
| `spec/remote_interface_spec.lua` | 新增 21 条 busted 规格（自带桩，不依赖 faketorio） |

**兼容性**：没有 `remote.call` 时行为与 19.15.3 完全一致。存档 schema 不变，玩家交互不变，
不新增 GUI 元素、设置、locale 或事件订阅。远程创建的任务与玩家在对话框里输入的任务
完全同构，可以照常编辑 / 转派 / 完成 / 导出。

## API 契约

接口名 `todo_list`，只暴露两个调用，没有任意函数执行、`storage` 写入或 GUI 元素操作。

### `api_version() -> number`

返回远程契约版本，当前为 `1`。只有破坏性变更才会 +1；新增调用或新增可选字段不改动它，
所以调用方用 `api_version() >= 1` 守卫即可。

### `add_task(payload) -> table`

在 open 列表创建一条任务，并刷新所有玩家的列表。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `player_index` | number | 是 | 1 到 4294967295 的整数，且必须对应有效玩家；成为 `created_by` / `updated_by` |
| `title` | string | 是 | 去除首尾空白后最多 200 字节 |
| `description` | string | 否 | 最多 4000 字节；上游字段名 `task` 也被接受 |
| `assignee` | string | 否 | 必须是现有玩家名 |
| `add_to_top` | boolean | 否 | 默认 `false`（追加到末尾） |

所有字符串都会去掉控制字符（description 保留 `\t` / `\n` / `\r`）并去首尾空白。长度上限按
**字节**计：Factorio 的 Lua 没有 `utf8` 库，中文标题 200 字节约 66 个汉字。

成功返回 `{ created = true, id = <number> }`；`id` 就是普通任务 id，导出里也能看到。

失败**返回**而不是抛出，因此非法输入既不会让调用方崩溃，也不会损坏存档：

```lua
{ created = false, error = "<code>", message = "<human readable>" }
```

`error` 取值：`invalid_payload`、`not_initialized`、`invalid_player_index`、`unknown_player`、
`invalid_title`、`title_too_long`、`invalid_description`、`description_too_long`、
`invalid_assignee`、`unknown_assignee`、`invalid_add_to_top`、`internal_error`。
调用方应把未知取值当作一般失败处理。

`player_index` 在交给 `game.get_player` 之前会先完整校验（必须是整数、非 NaN、在 uint 范围内），
因为该 API 对非法 uint 是**抛错**而不是返回 nil，而抛出的错误会顺着 `remote.call` 打到调用方。

实现复用上游既有流程 `todo.assemble_task` → `todo.save_task_to_open_list` →
`todo.update_main_task_list_for_everyone`，调用方永远接触不到 `storage.todo`。写入与 GUI 刷新
分开保护：只要任务已经进入列表（用上游的 `todo.get_task_by_id` 复核），即使 GUI 副作用抛错也
返回 `created = true`。因此 `created = false` + `internal_error` 表示**什么都没写进存档**，
调用方可以安全重试，不会产生重复任务。

### 调用方示例

`info.json` 里声明可选依赖，缺失时本 Mod 仍能启动：

```json
"dependencies": ["base >= 2.0", "? Todo-List >= 19.16.0"]
```

```lua
local function add_to_todo_list(player, title, description)
  local api = remote.interfaces["todo_list"]
  if not (api and api["api_version"] and api["add_task"]) then
    return nil, "todo-list-unavailable"
  end
  if remote.call("todo_list", "api_version") < 1 then
    return nil, "todo-list-incompatible"
  end

  local result = remote.call("todo_list", "add_task", {
    player_index = player.index,
    title = title,
    description = description,
    assignee = player.name,
    add_to_top = true,
  })

  if result.created then
    return result.id
  end
  return nil, result.error
end
```

注意 Todo-List 是**所有玩家共享**的列表，新任务对全服可见，UI 上要说清楚。

## 构建可安装的 patched ZIP

```bash
node compat/todo-list/build-patched-zip.mjs
```

脚本会按 `upstream.json` 浅克隆上游 `v19.15.3`，**校验 HEAD 与固定的提交号一致**（标签被移动
或改写就直接失败），`git apply --check` 后应用补丁，核对 `info.json` 版本，然后写出确定性
ZIP 和 SHA-256：

```
compat/todo-list/dist/Todo-List_19.16.0.zip
compat/todo-list/dist/Todo-List_19.16.0.zip.sha256
```

同样的输入重复运行得到字节相同的 ZIP。需要 `git` 和访问 github.com 的网络。可选参数：
`--out <dir>` 换输出目录，`--expect <sha256>` 在摘要不符时失败（用于校验别人给的 ZIP）。

产物目录在 `.gitignore` 覆盖范围内，不会被提交。

## 本地安装（临时方案，务必先读）

1. 关闭 Factorio，备份存档。
2. 打开 mods 目录（Windows 一般是 `%APPDATA%\Factorio\mods`）。
3. **删除或移出原版 `Todo-List_19.15.3.zip`**。绝不能同时放两个 Todo-List：Factorio 会因为
   同名 Mod 重复而拒绝启动或行为不可预期。
4. 把 `Todo-List_19.16.0.zip` 复制进去，启动游戏并在 Mod 列表确认版本是 19.16.0。

**这是临时替换，不是发布。** 需要清楚知道：

- **会被 Mod Portal 更新覆盖。** 只要上游发布的版本号高于 19.16.0，Factorio 的自动更新
  就会用官方版本替换它，`todo_list` 接口随之消失，Factorio AI Assistant 的“加入 Todo-List”
  按钮会退回禁用状态。升级前建议在 Mod 设置里关掉自动更新，或每次升级后重新构建。
- **不要重新分发。** 这个 ZIP 只供 Charles 本机测试，不上传 Mod Portal，也不改 Mod 名字。
- **多人游戏所有人都得装同一个 ZIP**，否则会 Mod 校验失败。
- 启用任何 Mod 的存档都拿不到 Steam 成就。

## 验证

`npm test` 会跑 `scripts/todo-list-compat.test.mjs`：它直接从补丁里取出新增的 Lua，做
Factorio 兼容的语法解析，再用 fengari 在最小 Factorio API 替身（`game.get_player` 会像真实 API
一样对非法 uint 抛错）上执行，覆盖成功创建、置顶 / 追加顺序、`description` / `task` 别名、
控制字符清理、每一条非法输入拒绝路径、未初始化存档、GUI 副作用抛错和内部错误上报。它还校验
补丁只改了声明的那几个文件、固定了正确的上游提交号，并且 `upstream.json` 里列出的错误码与实现、
busted 规格、本文件三处完全一致。测试不需要网络，也不需要上游代码副本。

同一批断言在补丁自带的 `spec/remote_interface_spec.lua` 里以 busted 形式存在，给上游维护者用。
注意上游 CI 目前只跑 `luacheck ./src/*.lua` 和 `luacheck ./src/todo/*.lua`（连 `src/todo/features/`
都没覆盖），并不执行 busted，所以我们自己这条 `npm test` 才是真正的回归防线。

游戏内实机验收（Windows）：

1. 装好 patched ZIP，新建或载入存档。
2. `/c remote.call("todo_list", "add_task", {player_index = 1, title = "smoke test"})`
   （注意：控制台命令会禁用该存档的成就）。
3. 打开 Todo List，确认任务出现、`created_by` 是自己、可以正常编辑和完成。
4. 多人测试：另一位玩家的列表应立刻刷新。
5. 非法输入（例如 `player_index = 999`）应返回 `created = false` 且游戏不崩溃。
