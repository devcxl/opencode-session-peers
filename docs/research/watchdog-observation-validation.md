# 保守看门狗的空闲、等待与观测恢复能力（OpenCode v2.2.7 隔离实测）

研究日期：2026-11-14。研究票：<https://github.com/devcxl/opencode-session-peers/issues/56>。
地图：<https://github.com/devcxl/opencode-session-peers/issues/49>。
前置研究：<https://github.com/devcxl/opencode-session-peers/issues/50>，
`docs/research/watchdog-signals.md`（只读源码，未跑 2.2.7）。
判定政策：<https://github.com/devcxl/opencode-session-peers/issues/52#issuecomment-6872480347>。

本文只回答“能观察到什么、能不能安全地据此自动纠正”，不重开 #52 的政策选择，
也不把 2 分钟 / 10 分钟 / 30 分钟当作实测最优值。

## 0. 结论先行

在同一服务进程、同一位置（directory）内，2.2.7 能可靠给出**粗粒度回合状态**：
`session.execution.*` 事件 + `SessionInfo.time.busy/idle` 可以区分
“正在执行”“已结算”“终端失败/中断”。这足以支撑 #52 的“持续空闲未完工”候选，
但**不足以**证明任务实质推进，也不足以单独证明“没有等待”。

隔离实测同时确认了四条硬边界：

1. **`permission.list` 是位置作用域的当前快照**：同一位置能读到待决审批；
   另一个位置对同一会话读到空列表。跨位置把空列表当成“没有等待”是错的。
2. **form 没有插件 domain 快照**：2.2.7 运行时的 `ctx.session` 没有 `form`；
   只能靠 `form.created` 事件，漏掉事件后插件侧无法补读。
3. **跨服务进程 `prompt`/steer 不安全**：B 进程向 A 正在跑的会话发 steer，
   B 会启动自己的 execution，并把 A 正在运行的工具以
   `Tool execution interrupted: shell` 结束；A 没有终结事件。两次复现一致。
4. **`time.updated` 不是活动时钟**：标题更新、排队消息接纳都会推进它；
   花名册心跳不会。`outcome` 在新回合运行期间仍显示上一回合的 `succeeded`。

因此首版自动纠正的安全门槛应是：**同一位置、事件订阅完整、当前快照可读、
没有 permission/form/retry/ask 等待、没有观测缺口，且 `busy > idle` 的持续空闲
经过分离时点复核**；任何一项不满足都只能通知，不能注入“继续”。

## 1. 版本与隔离证明

| 项 | 值 |
| --- | --- |
| 宿主 | `opencode v2.2.7`（`/usr/bin/opencode`） |
| 仓库类型依赖 | `@opencode/plugin` 2.0.16（运行时 2.2.7） |
| Bun | 1.3.13 |
| 实例 | 一次性 `opencode serve --hostname 127.0.0.1 --port <随机>` |
| 模型 | 本地确定性 stub（OpenAI-compatible，loopback） |
| 状态 | 每次实验独立 XDG data/state/cache/config + 独立 SQLite |
| 用户服务 | `service.json` 运行前后 md5 相同，live pid 存活，未连接其端口 |

每次运行的隔离断言都写入证据 `summary.json`。本次全部运行中：

- `service.json` md5 前后一致（`a6dab5b9b6ea6f451faf6ae9ee8fa7cd`），live pid `2520923` 仍存活；
- 实例端口都是随机 loopback 端口，与 live URL `http://0.0.0.0:49374` 不同；
- 没有复制/读取 `auth.json`，没有读取宿主 SQLite；stub 的 API key 是字面量 `stub`；
- 没有写全局配置，所有配置都在 scratch 目录内。

**残余隔离边界（如实披露）**：宿主仍会监听真实的 `~/.config/opencode/skills`
（server log 可见），并可能刷新公开的 models.dev 目录；这两者都不包含用户会话、
provider 凭据或私有数据库，stub 回合也从未加载/调用这些 skill。若要求“连用户级
skill 目录也不读”，需要在实例环境中把 `HOME` 也指向 scratch，本实验未这样做。

复现命令：

```sh
cd /home/devcxl/Projects/OpenCodePlugins/opencode-session-peers/.worktrees/watchdog-observation-validation
bun scripts/research/watchdog-observation/run.ts --scenario=main
bun scripts/research/watchdog-observation/run.ts --scenario=permission
bun scripts/research/watchdog-observation/run.ts --scenario=form
bun scripts/research/watchdog-observation/run.ts --scenario=failure
bun scripts/research/watchdog-observation/run.ts --scenario=eviction   # 约 60 s
bun scripts/research/watchdog-observation/run.ts --scenario=hot
bun scripts/research/watchdog-observation/run.ts --scenario=cross
# 或一次跑完（约 4 分钟）：--scenario=all
```

证据默认写到 `/tmp/opencode/watchdog-observation-evidence/<时间戳>/`：
`summary.json` + 每个场景的 `probe-*.jsonl`（逐事件、逐快照）。

## 2. 实验设计

探针插件（`scripts/research/watchdog-observation/probe-plugin/index.ts`）每个位置
加载一次，做三件事：

1. 订阅本进程全部事件，逐条写 JSONL（类型、时间、data、pid、位置）；
2. 每 500 ms 用 `ctx.session.list()` + `ctx.permission.list({sessionID})` 取一次
   当前快照（`time.busy/idle/updated`、`outcome`、title、待决 permission）；
3. 每秒往插件 storage 写一个心跳键，测“心跳是否会被当成会话活动”。

确定性 stub（`stub-model.ts`）只按用户消息里的指令作答，支持普通文本、延迟、
一次 `shell` 工具调用（可 `sleep`）、`question` 表单工具、HTTP 500 注入。
所有驱动都通过实例自己的 HTTP API；没有真实模型调用。

## 3. execution 生命周期与 `time.busy/idle/outcome`

### 3.1 一次正常回合（实测）

普通文本回合（stub 立即答复）：

| 观察 | 值 |
| --- | --- |
| `time.busy` | 1794635578612（执行开始） |
| `time.idle` | 1794635578666（执行结束） |
| `outcome` | `succeeded` |
| 事件 | `session.inbox.enqueued` → `session.execution.started` → `session.inbox.delivered` → `session.execution.succeeded` |
| `time.busy > time.idle` 区间 | 运行中为真；结算后 `idle > busy` |

结算后 `time.busy` **不会清空**，它仍是本次执行的开始时间；`time.idle` 是结束时间。
因此 `busy > idle` 是“最近一次执行尚未结算”的近似，不是“当前一定有模型在输出”。

### 3.2 长工具（实测）

`shell` 执行 `sleep 10`：

| 观察 | 值 |
| --- | --- |
| execution.started / busy | 1794635579760 |
| tool created / ran | 1794635579787 / 1794635579791 |
| tool completed | 1794635589803（约 10.0 s） |
| execution.succeeded / idle | 1794635589839 / 1794635589837 |
| `outcome` | `succeeded` |

工具运行期间 `busy` 不变，没有 step 事件；只有 `session.tool.progress`。
这意味着“长工具运行”在信号上就是“busy + 无新 step”，与“卡死工具”无法只靠
事件区分；需要工具片段的 `time.ran/completed` 或正常等待声明。

### 3.3 重试等待（实测）

一次 HTTP 500 后宿主自动重试：

- `busy` 1794635598440，`session.retry.scheduled` 1794635598461，
  `session.execution.succeeded` 1794635600298；总时长 2.96 s。
- 重试期间 `outcome` 仍是**上一回合的 `succeeded`**，`busy > idle` 仍为真。
- 因此“outcome 已 succeeded”不能说明当前回合没有在跑；重试必须当作正常等待。

### 3.4 终端失败（实测）

持续 HTTP 500：

- 10 次 `session.retry.scheduled`，约 88.4 s 后 `session.execution.failed`；
- `outcome` 变为 `failed`，`busy` 1794636033356，`idle` 1794636120311；
- 最后 8 s 内 `time.updated` 停在 1794636112073，只有终止时跳到 1794636120309。
  **重试退避期间 `time.updated` 也可能长时间不动**，不能拿它当活动时钟。

### 3.5 中断（实测）

`shell sleep 30` 运行中调用 `session.interrupt`：

- `session.tool.failed`（`aborted`，“Tool execution interrupted”）
- `session.step.failed`（`aborted`，“Step interrupted”）
- `session.execution.interrupted`（`reason: "user"`），`outcome: interrupted`
- `idle` 随后写入；`busy` 仍保留为开始时间。

### 3.6 字段缺失与重建

- 会话第一次执行前，`SessionInfo.time` **没有 `idle` 字段**（实测 permission/form 场景）。
  此时 `busy > idle` 是 `number > undefined`，不同实现的语义不同；必须显式把
  “idle 缺失”标成未知，而不是 0。
- 位置回收后重新加载，`ctx.session.list()` 仍返回同一会话及其旧
  `time/outcome`（实测 eviction 场景）；但事件不会重放（见 §5）。
  重建观察时不能把“旧 idle 时间戳”当作刚刚发生的空闲。

**结论（实测）**：`execution.*` 事件 + `busy/idle` 适合判断“运行中 / 已结算 /
终端失败或中断”；`outcome` 只描述上一次结算，不是当前状态；`time.updated`
不是活动时钟；缺少 `idle` 或跨进程时必须退让为未知。

## 4. 等待快照与漏事件退让

### 4.1 permission（实测）

配置 `permissions: [{ action: "shell", resource: "*", effect: "ask" }]` 后，
stub 调用 `shell sleep 6`：

- `permission.asked` 在 `session.execution.started` 后约 42 ms 出现；
- 同一位置的 `ctx.permission.list({ sessionID })` 返回完整请求：
  `id`、`action: "shell"`、`resources: ["sleep 6"]`、`save`、`source`；
- 会话保持 `busy > idle`，`outcome` 仍是上一回合（或缺失）；
- 回复 `once` 后，`ctx.permission.list` 立即变为空，工具继续，随后正常结算。

**漏事件恢复（实测）**：把探针的事件订阅延迟 3 s，使其错过 `permission.asked`；
同一位置的快照仍在 0.5 s、1 s、1.5 s 读到同一条待决请求。也就是说：
**漏掉事件不等于丢失当前快照**，同一位置的 `permission.list` 可以补读。

**跨位置（实测）**：在 permission 待决期间激活另一个位置 project-c。它的
`ctx.permission.list({ sessionID })` 对同一会话返回 `[]`，而同位置的
project-a 同时返回 1 条。由此确认 `permission.list` 是**位置作用域**的。
跨位置看到空列表只能记为“不可见/未知”，不能记为“没有等待”。

**重复事件（实测）**：两个位置实例各自记录到同一条 `permission.replied`
（时间戳相同），说明事件广播到进程内所有实例。计数前必须按事件 id/请求 id 去重，
不能把“两个观察者各记一次”当成用户回复两次。

### 4.2 form（实测）

用 `question` 工具制造表单：

- 事件 `form.created`；会话 `busy > idle`；
- HTTP `GET /api/session/<id>/form` 返回完整表单（字段 key `q0`、选项、metadata）；
- 回复 `q0=Yes` 后 `form.replied`，工具成功，会话结算；
- 2.2.7 运行时的 `ctx.session` keys 为：
  `hook, list, create, get, remove, switchAgent, switchModel, prompt, generate,
  command, compact, synthetic, interrupt, update, move, wait, context, instructions`；
  **没有 `form`**；`ctx.permission` 则有 `hook, list, get, reply, assert`。

因此插件侧没有 form 的当前快照 API，只有 ephemeral 的 `form.created`。
如果看门狗晚于表单创建才订阅，它既没有事件也没有插件快照；HTTP 端点是否跨进程
可见未测（form 状态看起来在服务进程内）。安全结论：**无法排除 form 等待时，
不能自动注入继续**。

### 4.3 插件 ask（未重测）

ask 不是宿主等待对象，而是本插件自己写进 storage 的记录；宿主没有“待答询问”
查询。本轮没有加载生产插件重跑 ask 链，故不把 ask 快照写成“2.2.7 已验证”。
可依赖的事实只有：

- 插件 storage 的 `get` 是跨位置共享的（本次用固定键从 project-c 读到了
  project-a 写入的值）；
- storage 记录在位置回收/热重载后仍在（§5）；
- 是否过期必须由记录里的 `expiresAt` 自己判断，宿主不会清理。

在 ask 语义未重测前，自动纠正不应仅凭“storage 里没有 ask”就断定没有等待。

### 4.4 retry（实测）

`session.retry.scheduled` 是事件，不是 `SessionInfo` 字段。终端失败实验里出现 10 次；
晚订阅者看不到这些事件时，只能看到 `busy > idle` + 旧 `outcome`，与“卡死工具”
在信号上相同。安全结论：**只有亲眼看到 retry 事件（或明确声明）才把它当正常等待；
否则按未知处理，只通知。**

## 5. 活动可见性与排除项（实测）

| 行为 | 事件 | `time.updated` | `busy/idle` | `outcome` | 能否刷新活动时钟 |
| --- | --- | --- | --- | --- | --- |
| 执行 step / 文本 / 工具状态变化 | `session.step.*`、`session.text.*`、`session.tool.*` | 会变 | busy 保持，idle 不变 | 不变直到结算 | **能**（真正的执行活动） |
| 标题更新 | `session.renamed` | 579785 → 582217 | 不变 | 不变 | **不能** |
| 排队消息接纳 | `session.inbox.enqueued` | 590311 → 590335 | busy 不变 | 仍为上一回合 | **不能** |
| 插件 storage 心跳 | 无会话事件 | 不变 | 不变 | 不变 | **不能** |
| 会话创建 | `session.created` | 创建时间 | 无 | 无 | 不能当执行活动 |

具体证据：

- 长工具运行中重命名标题：`session.renamed` 在 1794635582219；`time.updated`
  从 1794635579785 跳到 1794635582217，而 `busy` 仍是 1794635579760、`idle` 仍是
  1794635578666。若用 `time.updated` 做活动时钟，会把改名误判成“有进展”。
- 运行中追加一条 `queue` 消息：`session.inbox.enqueued` 在 1794635590334；
  `time.updated` 从 1794635590311 变成 1794635590335，`busy` 不变，且没有新的
  `session.execution.started`。接纳 ≠ 执行 ≠ 进展。
- 探针每秒写 storage 心跳，10 s 长工具期间没有任何会话事件，`time.updated` 仅在
  标题更新时变化。心跳不能证明宿主还在推进回合。
- `outcome` 在新回合运行期间保留上一回合的 `succeeded`（多次快照实测），
  直到新回合终结才改写。不能用它判断“当前已完成”。

**结论**：看门狗的活动时钟只能由执行会话自己的 step/文本/工具状态变化推动；
标题、心跳、同伴消息接纳、看门狗自己的消息接纳都不能刷新。

## 6. 位置回收与热重载（实测）

### 6.1 位置回收

配置 `experimental.location_idle_timeout = "5 seconds"`，会话结算后不再访问该位置：

- server log 在 **59.0 s** 后出现 `location services evicted`（TTL 5 s + 固定
  1 分钟扫描周期）；
- 探针 `cleanup` 被调用，实例存活 59.484 s；
- 重新激活同一位置后 **0.96 s** 内第二次 `setup`；
- 第二次 `setup` 读到上一次的 storage 心跳值（`updatedAt` 仍在）；
- `ctx.session.list()` 仍能读到旧会话的 `time/outcome`，但重新订阅后没有旧事件重放，
  只看到 `integration/provider/model/agent/command/skill/...` 等重载事件。

结论：位置回收会真正调用插件 cleanup，杀掉定时器和订阅；重建后必须从 storage
和当前快照重建基线，不能把回收期间的时间算成“连续空闲”，也不能把旧
`idle` 时间戳当成刚刚结算。

### 6.2 热重载

修改被加载的插件源文件（一次性副本，不碰生产入口）：

- `cleanup` 在约 1.4 s 后调用；
- 第二次 `setup` 在触碰后约 1.25 s 完成；
- storage 心跳仍在；
- 重载后只看到 provider/model 更新事件，没有旧会话事件重放。

结论：热重载的语义与位置回收相同——旧观察者死亡、状态需从 storage/快照恢复。
任何“连续 N 秒无活动”的计数都必须在重载后重新开始。

## 7. 跨进程 steer 的最终投递（实测，结论为不安全）

两个一次性 `opencode serve` 进程 A、B 共享同一 scratch SQLite 和同一 stub，
A 在 project-a 跑 `shell sleep 15`，1 s 后 B 对同一会话发送
`delivery: "steer"` 的 prompt。两次有效运行结果一致：

| 观察 | 结果 |
| --- | --- |
| A 的 shell | `status: "error"`，约 1.58 s 结束（不是 15 s） |
| 事件 | B 发出 `session.execution.started` 后立即 `session.tool.failed`：
  `Tool execution interrupted: shell` |
| A 的终结事件 | **没有** `session.execution.succeeded/failed/interrupted` |
| B 的终结事件 | `session.execution.succeeded` |
| 会话 `time` | 被 B 的 execution 覆盖为 B 的 busy/idle；A 的开始时间被替换 |
| transcript | 同时含 A 的 shell prompt 和 B 的 steer 文本；B 自己的回合产生了回答 |

这不是“A 在下一个 step 边界提升 B 的 steer”，而是 **B 启动了自己的执行，
并把 A 正在运行的工具当成 stale 工具终止**（宿主 `settleStaleToolCalls` 的语义）。
因此跨服务进程的 prompt/steer 不能作为安全纠正路径：
它可能中断用户正在跑的工具，且接纳/投递记录无法证明 A 真的继续了任务。

**安全结论**：首版禁用跨进程自动纠正；只允许同进程、同位置的观察与投递。
如果未来要跨进程，必须先有宿主级执行所有权/租约，而不是依赖 inbox + wake。

## 8. 能力安全矩阵

| 能力 | 本轮证据 | 能否用于自动纠正 | 使用条件 / 退让 |
| --- | --- | --- | --- |
| `session.execution.*` 事件 | 实测 started/succeeded/failed/interrupted | **可以**作为回合状态 | 必须同进程；漏订阅/重载后先重建基线 |
| `time.busy/idle` | 实测正常、长工具、重试、失败、中断 | **可以**作辅助 | `idle` 缺失=未知；结算后 `busy` 不清空；不证明任务进展 |
| `time.busy > idle` 单独 | 实测 | **不可以单独** | 重试/运行中均成立；跨进程会被覆盖；需配合事件与分离时点复核 |
| `outcome` | 实测 | **不可以**当当前状态 | 新回合运行期间仍是上一回合值 |
| `time.updated` | 实测被标题/接纳推进 | **不可以**当活动时钟 | 只作元数据 |
| 同位置 `permission.list` | 实测可补读漏事件 | **可以**作为等待证据 | 空列表仍需与事件/任务契约交叉；有 TOCTOU |
| 跨位置 `permission.list` | 实测对同一会话返回空 | **不可以** | 空=不可见，不是没有等待 |
| `form.created` 事件 | 实测 | 仅能作为“看到等待” | 插件无 form 快照；漏事件=未知 |
| form HTTP 快照 | 实测同进程可读 | 不作为插件自动路径 | 跨进程未验证；不能假设可用 |
| 插件 ask storage | 本轮未重测 | **暂不可以** | 只有 storage 记录，无宿主快照；需按 expiresAt 判读 |
| `session.retry.scheduled` | 实测 10 次 | **可以**作为正常等待 | 只有亲眼看到才成立；晚订阅者看不到 |
| 标题/心跳/inbox 接纳 | 实测不刷新执行活动 | **不可以** | 显式排除 |
| 位置回收/热重载 | 实测 cleanup + 重建 | **必须重置基线** | 回收/重载窗口内不判定停滞 |
| 跨进程 steer | 实测会中断正在运行的工具 | **不可以** | 首版禁用 |

## 9. 对首版策略的直接安全门槛

1. **观察者必须在目标会话的同一位置**；跨位置只能做只读提示，不能自动纠正。
2. 判定“持续空闲”必须同时满足：
   - 同位置事件订阅完整（或明确从快照重建了基线）；
   - `idle` 存在且 `busy <= idle` 连续成立；
   - 没有同一位置的待决 permission、没有 form 事件、没有 retry 事件、
     没有有效的 ask 记录、没有人工暂停声明；
   - 至少两个分离时点的快照一致；
   - 期间没有位置回收/热重载/订阅中断。
3. 任一等待快照不可读、位置不匹配、事件有缺口、`idle` 缺失、`outcome` 与
   `busy/idle` 冲突 → 记为**观测未知**，只通知，不注入。
4. 运行中静默（`busy > idle` 且无新 step/tool 变化）只通知，不自动继续；
   长工具和重试退避都属于这一类，直到有明确等待声明或事件。
5. `outcome=failed/interrupted` 或人工暂停：不自动续跑。
6. 看门狗自己的消息接纳、标题更新、storage 心跳不得进入活动时钟。
7. 跨进程 steer/纠正首版禁用；不要用“inbox 已接纳”证明任务恢复。

## 10. 残余未知

1. **form 的跨进程可见性**：未测；插件侧本来就没有 form domain，自动纠正应直接禁用。
2. **插件 ask 在 2.2.7 的完整链路**：本轮未重跑；只验证了 storage 跨位置可读、
   回收/重载后仍在。ask 过期与冲突合并仍需按仓库实现判读。
3. **活跃会话是否一定阻止位置回收**：源码注释与配置说明称运行中的会话/后台 job
   会 retain 位置；本轮只等到空闲回收（59 s），没有等一个活跃会话跨过 TTL。
4. **`session.status` / `session.idle` 的发布点**：575 条事件记录中两者均为 0；
   这是负面证据，仍不能排除未来版本或第三方插件发布同名事件。
5. **时钟跳变/系统休眠**：未测；所有时间比较都应允许时钟异常并退让。
6. **permission.list 的 TOCTOU**：从 list 到注入之间存在用户刚好批准/新请求到达的窗口；
   #52 已要求分离时点复核，本轮未量化窗口。
7. **多观察者重复事件**：本轮确认同一事件会被多个位置实例各记录一次；按事件 id
   去重是下游实现责任，本轮未测事件 id 在 2.2.7 的稳定性。
8. **窗口参数**：2 分钟/10 分钟/30 分钟未被本轮验证为最优；本文只验证信号能力。

## 11. 复现资产

- `scripts/research/watchdog-observation/run.ts`：隔离实例、场景驱动、隔离断言、证据落盘。
- `scripts/research/watchdog-observation/stub-model.ts`：确定性 loopback stub。
- `scripts/research/watchdog-observation/probe-plugin/index.ts`：事件 + 快照 + 心跳探针。
- 本文件。

实验不使用生产入口，不修改 `src/`，不升级依赖；所有 scratch 在 `/tmp/opencode`，
实例与 stub 在 finally 中停止。本工作树没有 `.codegraph/` 索引，按 AGENTS 规则未初始化
CodeGraph；宿主行为以上述运行证据为准，源码结论只用于解释事件形状。
