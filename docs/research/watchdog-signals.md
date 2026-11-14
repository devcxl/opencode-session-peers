# 看门狗可用的任务进展、等待与纠正信号（OpenCode v2.2.7 / @opencode/plugin 2.0.16）

研究日期：2026-11-14。
研究票：<https://github.com/devcxl/opencode-session-peers/issues/50>，
地图：<https://github.com/devcxl/opencode-session-peers/issues/49>。

本文只陈述事实、证据与限制，不替用户选择监护范围或停滞政策。所有结论都区分三层：
**插件存活**（插件实例还在不在）、**宿主回合活动**（有没有一个 turn 在跑）、**任务实质推进**
（这件事本身有没有前进）。三者互不蕴含。

## 0. 方法与版本基线

| 项 | 值 | 证据 |
| --- | --- | --- |
| 本机宿主 | `opencode v2.2.7` | `opencode --version`（2026-11-14） |
| 宿主二进制 | `/usr/bin/opencode`，258,848,944 字节，mtime 2026-11-11 | `ls -la` |
| 仓库类型依赖 | `@opencode/plugin` **2.0.16** | `package.json`；`~/.config/opencode/node_modules/@opencode/plugin` |
| 宿主自带插件包 | `packages/plugin` 版本 **2.2.7**（与宿主同版） | `packages/plugin/package.json` at tag `v2.2.7` |
| 宿主源码 | GitHub tag `v2.2.7`（<https://github.com/anomalyco/opencode/tree/v2.2.7>） | 逐文件读取，链接见附录 |

证据标签：

- **[src 2.2.7]**：读取宿主 tag `v2.2.7` 的源码字符串；未执行。
- **[measured 2.0.27/2.0.29]**：仓库既有的隔离实测记录（`docs/research/*.md` 中标注 `[ran]` 的部分）。
- **[repo src]**：本仓库 `src/` 的现状。
- **[inferred]**：由源码推理、未直接执行。

本轮**没有启动任何测试会话或隔离服务**；未读取宿主数据库或服务凭据，未接触用户运行中的会话。
因此一切“运行时行为”要么来自已标注日期的既有实测，要么标为 `[inferred]`。

### 0.1 必须先说的版本错位

- 仓库用 **2.0.16** 的类型做类型检查，但运行时是 **2.2.7**。2.2.7 已经提供而 2.0.16 类型里**没有**的
  能力至少有：`ctx.session.list`、`ctx.session.remove`、`ctx.session.compact`、`session.hook("experimental.idle")`、
  `ctx.event.subscribe({ types })` 类型过滤（见 `packages/plugin/src/effect/session.ts` 的 `SessionDomain`）。
- 仓库已安装的 `dist/promise/session.d.ts` 中 `SessionDomain` 仍是
  `Pick<SessionApi, "create" | "get" | "switchAgent" | "switchModel" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "update" | "move" | "wait" | "context">`，
  无 `list`。**用 2.0.16 类型写不出枚举全部会话的看门狗**；运行时支持，但需要升级类型依赖才可类型安全地使用。
- 既有研究分别钉在 2.0.27、2.0.29、2.2.5。本文尽量以 2.2.7 源码校正，但 2.2.7 上的行为实测仍是空白。

---

## 1. 结论速览：三层信号

| 层 | 可观察 | 不可观察 / 不可证明 | 置信度 |
| --- | --- | --- | --- |
| 插件存活 | 实例的 `setup`/`cleanup`；自己的心跳写入插件 storage；同进程内所有位置的事件流 | 宿主没有“插件健康”查询；别的实例是否活着只能靠它自己的心跳值；跨服务进程完全不可见 | 高 |
| 回合活动 | `session.execution.started/succeeded/failed/interrupted`（durable）；`SessionInfo.time.busy` / `time.idle` / `outcome`；transcript 的 step/tool 事件与时间戳 | `session.status` 在 tag 内找不到发布点；`session.idle` 已 deprecated；没有“本回合心跳”；跨进程无事件 | 中高 |
| 任务实质推进 | transcript 里的 assistant 文本/推理/工具调用及其 `time.created/ran/completed`、`todowrite` 的工具输出 | 宿主没有“任务”实体，也没有完成度；`outcome` 只是“上一次执行怎么结束” | 高（“没有”这一面） |
| 正常等待 | 待决 permission（`ctx.permission.list`）、`permission.asked/replied`、form 事件、storage 里的待答 ask、运行中的 `subagent`/`shell` 工具片段、子会话 `parentID` | 人“在想/离开”没有信号；跨进程看不到对方的待决 permission/form | 中高 |
| 纠正生效 | prompt 接纳记录（admission）；`steer` 在下一个安全边界被提升；`queue` 在空闲边界被提升 | 接纳 ≠ 投递 ≠ 已读 ≠ 任务恢复；卡死工具/被 park 的回合没有边界，`steer` 永远不生效 | 高 |
| 存储互斥 | 单键 upsert、前缀扫描、跨位置/跨进程共享、持久 | **没有 compare-and-set、没有唯一插入、没有事务快照、没有 leader** | 高 |

---

## 2. 插件存活（plugin liveness）

### 2.1 实例模型

- **一个位置（directory）一个插件实例**，同一服务进程内可有 N 个实例；模块被重新求值，模块级单例是
  每位置一份。[measured 2.0.27] `docs/research/plugin-instance-scoping.md` §1。
- 位置是**惰性激活**的：只有真正服务该 location 的请求/回合才会加载插件；重复请求不会重复 `setup`。
  同前，§1.2。
- 服务进程关闭（SIGTERM）时 `cleanup` 会运行；每个实例一个。[measured 2.0.27] 同前，§1.3。
- 2.2.7 源码：`InstancePlugins` 的列表是该实例的“出生参数”，实例生命周期内不可变；运行时动态性靠
  transform/reload。[src 2.2.7] `packages/core/src/plugin/instance.ts`。

### 2.2 位置回收（会杀掉看门狗的定时器）

- `LocationActivity` 默认 `timeToLive = 60 minutes`，每分钟扫描一次；可用实验性配置
  `experimental.location_idle_timeout` 覆盖；有打开的终端或客户端 MCP socket 时位置被保留（`isRetained`）。
  [src 2.2.7] `packages/core/src/location-activity.ts`。
- 槽位被回收意味着位置服务作用域关闭，插件实例与它持有的 `setInterval`/订阅一起消失。[inferred，源码结构明确；
  2.0.27 的 60 分钟 TTL 未被实际等到]
- 结论：**看门狗不能假设“插件会一直活着”**；它在每次实例重建后都要能从 storage 恢复状态。

### 2.3 心跳只能自证

- 宿主没有“列出插件实例/健康状态”的 API。`ctx.plugin.list()` 只列已加载插件定义，不报心跳。
- 仓库的做法：每个实例把“我服务的会话”写进共享 storage，值里带 `updatedAt`；读取方按
  `rosterTtlMs`（默认 90 s）判活，心跳间隔为 TTL/3（默认 30 s）。[repo src] `src/peers/roster.ts:122-130`、
  `src/config.ts:26-33`。
- 因为 storage 没有 host 侧 TTL，**过期判定必须由值里的时间戳完成**，不能依赖 host 清理。
- 一个实例死亡后，它的记录不会自己消失；下一个服务同一位置的实例会“收养”它（`seed()`），或由 sweep 回收。
  [repo src] `src/peers/roster.ts:133-160`。

---

## 3. 宿主回合活动（turn activity）

### 3.1 权威信号是执行生命周期事件

`session.execution.started/succeeded/failed/interrupted` 都是 **durable** 事件；`session.status`、
`session.idle` 是 **ephemeral**。[src 2.2.7] `packages/schema/src/session-event.ts`（`Execution.*` 用
`Event.durable`）、`packages/schema/src/session-status-event.ts`（`Status` 与 `Idle` 用 `Event.ephemeral`，
`Idle` 注释为 deprecated）。

一次 busy 周期由一个协调器管理：`started` 在第一次 drain 前发布一次，`settled` 在最终 drain 后发布一次终端事件；
一个回合内合并的多次 drain 只有一个终端。[src 2.2.7] `packages/core/src/session/run-coordinator.ts`、
`packages/core/src/session/execution.ts`（`coordinator` 的 `started`/`settled`）。

### 3.2 `SessionInfo` 的时间字段（比事件更适合做“多久没动”）

`Session.Info.time` 在 2.2.7 为：`created`、`updated`、`busy`、`idle`、`viewed`、`archived`；`outcome` 是
“上一次完成的执行”的 `succeeded`/`failed`/`interrupted`。[src 2.2.7] `packages/schema/src/session.ts`。

- `time.busy`：最近一次执行的**开始**时间。由 `Execution.Started` 投影写入，**终端事件不会清空它**
  （`projectIdle` 只写 `time_idle` 与 `idle_outcome`）。[src 2.2.7] `packages/core/src/session/projector.ts`
  （`time_busy: event.created`；`projectIdle`）。
- `time.idle`：最近一次完成执行的结束时间。
- 因此 **`busy > idle`（严格大于）是一个可用的“最近一次执行尚未结算”近似**：要么正在跑，要么进程在跑的时候死了。
  [inferred，来自上述写入点；未实测时钟回拨等异常]
- 进程崩溃留下的不是“永远忙碌”：宿主在启动时会扫描未释放的执行 claim 并自动续跑（见 §6.3）。

### 3.3 `session.status` / `session.idle` 不要依赖

- 在 tag `v2.2.7` 的 `packages/core` 与 `packages/server` 里**没有找到 `session.status` 的发布点**；
  只有 schema 定义、事件清单引用，以及 UI 自己的状态存储（`packages/session-ui/src/context/data.tsx` 的
  `session_status` 映射）。2.0.27 的隔离实测中，612 个事件里 `session.status` 出现 0 次、`session.idle`
  出现 0 次。[measured 2.0.27] `docs/research/plugin-instance-scoping.md` §3.3。
- 仓库 `src/host/events.ts` 仍监听 `session.status` 与 `session.idle`，但它们很可能永远不触发；真正的状态推进
  来自 `session.execution.*` 分支。这意味着仓库 roster 里的 `status` 字段可能长期是 `undefined`。
  [repo src] `src/host/events.ts:90-115`。置信度：中高（“找不到发布点”是负面证据，未见 2.2.7 实测）。

### 3.4 `wait` 是进程内语义

`ctx.session.wait({ sessionID })` 落到 `execution.awaitIdle`，而 `SessionExecution` 只管**本进程**的活动执行
（`active` 注释为 “Snapshots active execution owned by this process”）。[src 2.2.7]
`packages/core/src/session/execution.ts`、`packages/core/src/session/session.ts`（`wait`）。
2.0.27 的实测里，A 位置等 B 位置的回合是有效的（同一进程），但那不是跨进程等待。
[measured 2.0.27] `plugin-instance-scoping.md` §2.3。**跨服务进程的 wait 会立即返回**，不能当作观察手段。

### 3.5 事件流：进程内、实时、无重放

- 2.2.7：`ctx.event.subscribe` 直接订阅进程内 `Bus`，可按 `types` 过滤；插件不接收 `server.connected`。
  [src 2.2.7] `packages/core/src/plugin/host.ts` 的 `event` 段；官方文档
  <https://opencode.ai/docs/build/plugins/server>（Events）。
- 事件只在**本服务进程**内广播；订阅开始前的事件不重放；跨进程 0 事件、`Last-Event-ID` 不重放。
  [measured 2.0.27] `docs/research/opencode-multiprocess-topology.md` §5。
- 因此看门狗若只靠事件，**重启即失忆**；必须把“最后观察到的进展”落到 storage。
- 事件队列有容量上限，溢出会断开订阅者（`SubscriberOverflowError`）。[src 2.2.7]
  `packages/server/src/event-feed.ts`。

---

## 4. 任务实质推进（substance）

宿主没有“任务”实体，也没有“完成度”。能证明“有推进”的只有 transcript 的结构变化：

| 信号 | 形状 | 说明 |
| --- | --- | --- |
| 新消息 | `SessionMessageInfo.time.created`、`seq` | 会话内递增；`ctx.session.context()` 可取 |
| assistant 步骤 | `session.step.started/ended`、`session.text.*`、`session.reasoning.*` | step 结束是“模型这一轮输出完了” |
| 工具调用 | 工具片段的 `state.status`（`streaming`/`running`/`completed`/`error`）与 `time.created`/`ran`/`completed` | 卡死工具 = `running` 且 `ran` 很旧、无 `completed` |
| 工具结果 | `session.tool.success/failed` | 成功/失败都算“有动作”，但不算“朝目标前进” |
| 待办清单 | `todowrite` 工具输出 `{todos:[{content,status}]}`，`status` ∈ `pending/in_progress/completed/cancelled` | 模型自述，不是宿主任务状态；只存在于 transcript 的工具输出里 |
| 计划/回合结束 | assistant 消息的 `time.completed`、`finish`、`error`、`retry` | 结束≠任务完成 |

证据：[src 2.2.7] `packages/schema/src/session-message.ts`（`AssistantTool.time`、`ToolState*`、`Assistant.time`、
`Assistant.retry`）、`packages/core/src/tool/plugin/todo.ts`（`todowrite` 的 input/output）。

**关键否定事实**：`SessionInfo.outcome` 只描述“上一次执行如何结束”，一个 `succeeded` 的回合完全可能什么都没完成
（模型说了“做完了”或直接结束）。宿主没有任何字段表达“目标是否达成”。[src 2.2.7] `packages/schema/src/session.ts`
的 `outcome` 注释。

### 4.1 宿主自带的“停滞”先例：`/goal` 插件

宿主内置 `opencode.goal` 插件，是一个 **stop-hook 循环**，恰好覆盖“未完成 + 长时间无推进”的一半场景，值得作为
事实基线（它不是通用看门狗，只对显式 `/goal` 生效）：

- 只在 `session.hook("experimental.idle")` 触发：即“会话马上要空闲、且没有待处理输入”时。[src 2.2.7]
  `packages/core/src/session/runner/llm.ts`（idle hook 调用点）；`packages/core/src/plugin/goal.ts`。
- 用 `ctx.session.generate` 让模型做裁判，输出 `done/continue/blocked/paused/wait`。
- 停滞判定：**与上一轮 reason 相同**，或**自上次 kickoff/continuation 以来没有任何工具调用**；连续 3 次即暂停
  （`MAX_STALLS = 3`）。轮次上限 50；服务重启后的目标直接暂停（用 `boot` id 识别）。
- 空闲等待上限 `WAIT_LIMIT = 30 minutes`：有后台工作时（shell/subagent/image）等通知，超时才暂停。
  [src 2.2.7] `packages/core/src/plugin/goal.ts`。
- 它处理 storage 无 CAS 的方式是：写前重读并比对 `id/updatedAt/status`，不匹配就放弃这次写入。同文件
  `replace()`，注释明确 “Storage has no compare-and-set”。这是**仓库之外**对同一约束的独立确认。

---

## 5. 正常等待的识别

| 等待类型 | 可观察信号（进程内） | 边界与陷阱 |
| --- | --- | --- |
| 人工审批 | `permission.asked` / `permission.replied`（ephemeral）；`ctx.permission.list({sessionID})` 返回待决请求；会话仍 `busy`、无新进展 | 待决队列在服务进程内存中；ephemeral 不落库、不跨进程；`list` 必须带 `sessionID` |
| 人工填表/交互 | `form.created` / `form.replied` / `form.cancelled`（ephemeral）；HTTP 有 `session.form.list` | 2.0.16 的插件 domain 没有 form；只能靠事件，且跨进程不可见 |
| 同伴询问（ask） | storage 里的 ask 记录（含 `createdAt`/`expiresAt`）；发起方工具调用处于 running；被问会话可能是 idle 或 busy | 记录是插件自己写的，不是宿主状态；过期后仍可能存在，需按 `expiresAt` 判读 |
| 前台子会话 | 父会话 transcript 里有 `subagent` 工具片段且 `state.status === "running"`；父会话 `busy` | 运行中的 `subagent` 片段**不携带子会话 id**（2.0.29 实测）；只能“父被 park”这个近似 |
| 后台子会话 | 子会话 `parentID`；父会话可能 idle；宿主 Job（`kind:"subagent"`，含 `childSessionID`）在跑 | Job 不在插件 domain 里；2.2.7 只能通过 `experimental.idle` 的 `background` 看到 |
| 后台 shell | transcript 的 shell 消息片段 `status:"running"`；Job（`kind:"shell"`，含 command） | 同上；完成通知会唤醒会话 |
| 人离开 / 在想 | 会话 idle、无待决 permission/form、无待答 ask、无后台 job | **与“任务被放弃/模型停住”在信号上不可区分** |
| 回合等待重试 | `session.retry.scheduled`（durable）；assistant 片段的 `retry` | 重试有退避，期间没有新消息，容易被误判为停滞 |

证据：[src 2.2.7] `packages/schema/src/permission.ts`、`packages/schema/src/form.ts`、
`packages/schema/src/session-event.ts`（`RetryScheduled`）、`packages/schema/src/job.ts`、
`packages/core/src/session/background.ts`、`packages/core/src/plugin/host.ts`（permission domain）；
[measured 2.0.29] `docs/research/parked-parent-signal.md` §2；官方文档
<https://opencode.ai/docs/build/plugins/server>（Permissions / Sessions）。

**核心困难**：以上所有“正常等待”都是**基于对象的存在**（待决请求、后台 job、parked 片段）来识别的；
而“人还没回消息”只是一个沉默的 idle，宿主不记录“在等谁”。所以只凭活跃度无法把“正常人工等待”与
“真停滞”分开，必须有额外契约（见票 #51）。

---

## 6. 投递：接纳、生效与失效

### 6.1 接纳语义

`ctx.session.prompt({sessionID,text,delivery})`：

1. 校验会话存在，准备 prompt，`SessionInbox.admit` 落一条 inbox 记录（durable 事件 `session.inbox.enqueued`），
   返回 **admission 记录**；
2. 除非 `resume: false`，随后 `execution.wake(sessionID)`。
   [src 2.2.7] `packages/core/src/session/session.ts` `prompt`；`execution.ts`。
3. `delivery` 缺省是 `"steer"`。`steer` 与 `queue` 的差别**只影响在哪个边界被提升**，不改变“被接纳”。

接纳 ≠ 投递 ≠ 已读 ≠ 任务恢复（ADR-0005 的既定结论）。

### 6.2 边界规则（决定软纠正能不能生效）

- `nextPromotable`：**先看 steer 队列**；只有 `promotable === "input"` 时才看一条 queue。
  [src 2.2.7] `packages/core/src/session/inbox.ts`。
- drain 循环里：模型 step 之间的边界只允许 `steer`（以及 control 项 compaction/move）；`queue` 只在
  “进入回合”或“本来要空闲”的边界被提升，一次一条。[src 2.2.7]
  `packages/core/src/session/runner/llm.ts`（`advanceToStep`、`promotable`）。
- 因此：
  - **空闲会话**收到 `steer` 或 `queue` 都会开新回合（prompt 会 wake）。
  - **运行中会话**收到 `steer`：下一个 step 边界注入；收到 `queue`：等本次执行彻底结束。
  - **卡在工具里的会话没有 step 边界**：`steer` 会一直躺在 inbox 里，`queue` 更不会开始。这是“接纳了但永不生效”
    的精确形态。
- 2.0.27 的实测给出了一个真实例子：父会话被前台 `subagent` park 时，子会话的 `steer` 在 ~2 ms 内被接纳，
  但要到 `subagent` 返回的那一刻才被投递；子会话若等父回答就会死锁。
  [measured 2.0.27] `docs/research/subagent-lifecycle.md`、`docs/research/parked-parent-signal.md` §3。

### 6.3 重启、崩溃与中断

- `Execution.Started` 在同一个事务里写“执行 claim”（`session_v2.time_suspended`）。终端事件释放 claim；
  **优雅关闭的中断故意保留 claim**，供下次启动续跑。[src 2.2.7] `packages/core/src/session/execution.ts`
  注释与 `claimOnCommit`；`packages/core/src/session/store.ts`（`claim`/`release`）。
- 启动时 `SessionRestart.resumeSuspendedSessions` 恢复孤儿 claim：先写一条 synthetic
  “The server restarted while you were working…” 再续跑；同一回合最多 `DEFAULT_MAX_ATTEMPTS = 10` 次，
  超过就发布 `Execution.Failed`（`aborted`，“will not be resumed automatically”）。
  [src 2.2.7] `packages/core/src/session/execution/restart.ts`。
- 结论：**进程死亡造成的“停滞”由宿主自动修复**，看门狗不该重复处理，也看不到 claim 本身
  （`SessionInfo` 不含 `time_suspended`）。
- `interrupt` 被用户明确排除在自动纠正之外；这里只记录事实：它是唯一能让“卡在工具里的回合”停止的宿主操作，
  且 `awaitIdle` 需要另行等待清理完成。

### 6.4 跨服务进程

- 事件、`wait`、待决 permission/form 都是进程内的。
- `session.get` / `context` 是 DB 读取，跨进程可见（2.0.27 实测）。[measured 2.0.27]
  `plugin-instance-scoping.md` §2.1。
- 从进程 B 对“正被进程 A 执行的会话”发 `steer`：inbox 行写进共享 DB，但 `wake` 只作用于 B 的本地协调器；
  A 是否会在自己的下一个边界提升这条 steer **未实测**。[inferred；A 的 drain 读 DB，理论上会]
- 从进程 B 对“空闲会话”发 prompt：B 会自己把这个回合跑起来（2.0.27 实测的跨进程 prompt 就是这样完成的）。
  [measured 2.0.27] `opencode-multiprocess-topology.md` §4。

---

## 7. 真正挂起、软纠正无效的情形

| 情形 | 可观察征兆 | 软纠正是否可能生效 |
| --- | --- | --- |
| 工具永久阻塞（`fetch` 无超时、进程不返回、交互式命令） | 最后一次进展停在 `tool` 片段 `running`，`time.ran` 很旧；`busy > idle`；无新 step/消息 | **否**：没有 step 边界，steer 不投递，queue 不开始 |
| 前台子会话 park 父会话 | 父 transcript 有 running `subagent`；父 `busy`；子可能也在等 | 否：父 inbox 在 `subagent` 返回前不排空 |
| 进程崩溃 / SIGKILL | 无事件；`busy > idle`；claim 留在 DB | 宿主启动时自动续跑（≤10 次），不需要看门狗 |
| 宿主重试退避中 | `session.retry.scheduled`；无新内容；`busy` | 是“正常等待”，不应纠正 |
| 会话被另一个服务进程执行 | 本进程无事件、`wait` 立即返回；`get/context` 能读到 | 只能靠 DB 轮询判断；本地 steer 是否生效未验证 |
| 位置被回收（60 min 空闲） | 插件实例消失，之后重建 | 会话本来就空闲；插件需从 storage 恢复 |
| 整个服务进程退出 | 没有看门狗进程（本插件没有 daemon） | 不存在“插件层面”的监护 |
| 模型输出“完成”但任务没完成 | 回合 `succeeded`、transcript 有结尾文本 | 不属于“停滞”，属于目标判定；宿主无任务实体 |

宿主对普通会话**没有**“回合超时”或“进度心跳”：`SessionExecution` 没有计时器；唯一的超时/终止机制是
`interrupt`、provider 重试与崩溃恢复。[src 2.2.7] `packages/core/src/session/execution.ts`、`run-coordinator.ts`。

---

## 8. 存储：可依赖与不可依赖的能力

### 8.1 事实

- 命名空间：`plugin:<UTF-16LE hex(plugin id)>:`，**没有位置维度**；同机所有位置、所有服务进程共享；
  跨重启持久。[measured 2.0.27] `plugin-instance-scoping.md` §4；[src 2.2.7]
  `packages/core/src/plugin/host.ts` 的 `storage()`。
- API：`get` / `set` / `remove` / `scan({prefix, after, limit})`。[src 2.2.7] `packages/core/src/kv.ts`。
- `set` 是 `INSERT … ON CONFLICT(key) DO UPDATE`，即**单键最后写入者胜**。没有版本号、没有 CAS、没有唯一插入。
  同文件。
- `scan` 按 key 升序分页（`limit` 默认 100、上限 1000），用 `after` 续页；**不是快照**，两次分页之间可能插入/删除；
  多次 scan 不构成事务。同文件。
- 因此跨实例的“读—判断—写”都有竞态窗口；仓库自己的实现与测试已经把这个窗口写成已知限制：
  `removeIfStill` 不是原子 compare-and-delete，`test/storage-race.test.ts` 明确构造了“刷新后被误删”。
  [repo src] `src/host/storage.ts:79-94`、`test/storage-race.test.ts`。
- 没有 host 侧 TTL；过期只能写进值里。仓库用 `Peer.updatedAt` + `rosterTtlMs`。
- 仓库并发测试（`test/ask-concurrency.test.ts`）同样只描述窗口，不承诺互斥。

### 8.2 对看门狗的直接含义

- **不能**用 storage 实现“只有一个实例在监护”的锁（没有 CAS/leader）；最多能做“尽力而为的租约”，并接受两个实例
  同时行动的窗口。
- **能**用它做：最后观察时间、已发纠正次数、已升级标记、待处理/已完成的会话清单。写入必须幂等、可重入。
- 任何“只执行一次”的承诺都需要下游策略自己定义冲突合并规则，而不是假设宿主提供互斥。

---

## 9. 多实例、热重载与生命周期

| 事件 | 发生什么 | 证据 |
| --- | --- | --- |
| 文件变更（插件源码） | 源文件被 watch，`PluginModule.changes` 触发重新加载；旧 activation 作用域关闭，注册被 dispose | [src 2.2.7] `packages/core/src/plugin/module.ts`、`packages/core/src/plugin.ts` |
| 配置变更 | 同一次 `activate` 差异比对；新增/变更插件重新装载，移除的关闭作用域 | 同前 |
| 位置首次被服务 | 惰性 `setup`；模块重新求值 | [measured 2.0.27] `plugin-instance-scoping.md` §1 |
| 位置空闲 60 min | 位置服务被回收；插件实例与定时器消失（可配置） | [src 2.2.7] `location-activity.ts`；[inferred] 实例随作用域关闭 |
| 服务进程退出 | `cleanup` 运行；内存状态丢失；storage 保留 | [measured 2.0.27] §1.3；[src 2.2.7] storage |
| 服务重启 | 插件重新 `setup`；宿主恢复孤儿执行 claim（≤10 次） | [src 2.2.7] `execution/restart.ts` |
| 同进程 N 个位置 | N 个实例都收到**全部**事件（不按位置过滤），都会写共享 storage | [measured 2.0.27] §3 |

推论（事实层面）：看门狗的定时器天然是“每位置一份”，不是“每机器一份”；位置回收/热重载会重置它；
多实例会重复观察同一批会话事件。任何“次数上限”的计数必须落在 storage 里并对并发写有容错。

---

## 10. 下游决策可以依赖什么（只列事实）

- **#52（判定证据）**可以依赖：`session.execution.*` 事件（durable）、`SessionInfo.time.busy/idle/outcome`、
  transcript 的 step/工具状态与 `time.*`、`session.context` 的消息序列、`ctx.permission.list`、
  storage 里的 ask 记录、`session.list`（2.2.7 运行时；2.0.16 类型没有）。
- **#52 不能依赖**：`session.status`、`session.idle`、跨进程事件、跨进程 `wait`、宿主“任务/完成度”、
  回合心跳、执行 claim 字段。
- **#53（纠正策略）**的硬约束：`steer` 只在 step 边界生效；`queue` 只在空闲边界生效；卡死工具没有边界；
  接纳不可撤回（本仓库无删除 inbox 的 API）；每次 `prompt` 都会 `wake`；重复发送会累积 inbox 项。
- **#54（责任归属）**的硬约束：storage 无 CAS/leader；N 个实例可能同时判定与行动；心跳只能证明“实例写过”，
  不能证明“宿主在服务”。
- **#51（任务契约）**的事实前提：宿主没有任务实体；`outcome` 不等于完成；`/goal` 是 opt-in 且只覆盖显式目标。

---

## 11. 残余未知与不可证明项

1. **`session.status` 是否真的没有任何发布点**：结论基于 tag 内 `core`/`server` 的检索与 2.0.27 实测；
   存在第三方/未来插件发布同名事件的可能。置信度中高，非 2.2.7 实测。
2. **`busy > idle` 作为“执行未结算”的判据**未在 2.2.7 上实测（写入点明确，但时钟/迁移等边界未验）。
3. **跨进程 `steer` 的最终投递**未实测：inbox 是共享 DB，wake 是本地；A 进程是否在下一个边界提升 B 写入的 steer
   没有证据。
4. **待决 permission/form 的跨进程可见性**未验证；从实现看是进程内内存表。
5. **位置回收是否真的会调用插件 `cleanup`**：源码结构指向作用域关闭，但 2.0.27 的 60 分钟 TTL 没有被等到。
6. **`experimental.idle` 在第三方插件中的实际触发时机与失败模式**只有源码与宿主自带 `/goal` 的使用例，
   未在 2.2.7 上实测；2.0.16 类型里没有这个 hook。
7. **`ctx.session.list` 在 2.2.7 运行时的分页/过滤行为**未实测；2.0.16 类型没有它。
8. **插件心跳与宿主真实存活的偏差**：storage 写入成功只能证明 DB 可写；不证明宿主还能推进回合。
9. **provider 层挂起**（连接建立但无数据、无错误、无重试）没有专门事件；只能表现为“无新事件 + busy”。

---

## 12. 附录：证据索引

宿主源码（tag `v2.2.7`，`https://github.com/anomalyco/opencode/blob/v2.2.7/` 前缀）：

- `packages/schema/src/session-status-event.ts` — `SessionStatus = idle|retry|busy`；`Status`/`Idle` 均 ephemeral，`Idle` deprecated。
- `packages/schema/src/session.ts` — `Session.Info.time`（含 `busy`/`idle`）、`outcome`。
- `packages/schema/src/session-event.ts` — execution/inbox/step/tool/retry 事件；durable 与 ephemeral 的划分。
- `packages/schema/src/session-message.ts` — 工具状态与 `time.created/ran/completed`、assistant `time/error/retry`。
- `packages/schema/src/permission.ts` — `permission.asked/replied`（ephemeral）与 Request 字段。
- `packages/schema/src/form.ts` — `form.created/replied/cancelled`。
- `packages/schema/src/job.ts` — `Job.Info`（shell/subagent/image、status、time）。
- `packages/core/src/session/execution.ts` — claim 注释、`awaitIdle` 仅本进程、终端事件。
- `packages/core/src/session/run-coordinator.ts` — busy 周期、doorbell、settle。
- `packages/core/src/session/runner/llm.ts` — `promotable` 边界、`experimental.idle` 触发点。
- `packages/core/src/session/inbox.ts` — `nextPromotable`（steer 优先、queue 仅 input 边界）。
- `packages/core/src/session/store.ts` — `claim`/`release`/`listSuspended`（`time_suspended`）。
- `packages/core/src/session/projector.ts` — `time_busy` 写入；`projectIdle` 只写 idle/outcome。
- `packages/core/src/session/execution/restart.ts` — 孤儿 claim 续跑、10 次上限。
- `packages/core/src/session/background.ts` — 后台工作枚举（shell/subagent/image，含后代）。
- `packages/core/src/kv.ts` — get/set/remove/scan；`onConflictDoUpdate`；分页非快照。
- `packages/core/src/plugin/host.ts` — 插件 storage 命名空间、`session.list`、事件订阅（含 `types`）。
- `packages/core/src/plugin/goal.ts` — `/goal` 的停滞判定、3 次上限、30 min 等待上限、无 CAS 的写前重读。
- `packages/core/src/location-activity.ts` — 60 min TTL、1 min 扫描、`experimental.location_idle_timeout`。
- `packages/plugin/src/effect/session.ts` / `promise/session.ts` — 2.2.7 的 `SessionDomain`（含 `list`/`remove`/`compact`/`experimental.idle`）。

官方文档：

- <https://opencode.ai/docs/build/plugins/server> — 生命周期/context/storage/session/permission/events（当前版）。
- <https://opencode.ai/docs/build/plugins> — 插件部件与加载。
- <https://opencode.ai/docs/config> — 配置与热重载。

仓库内既有实测（版本各自标注）：

- `docs/research/plugin-instance-scoping.md` — 每位置一实例、事件不按位置过滤、storage 共享持久（2.0.27）。
- `docs/research/opencode-multiprocess-topology.md` — 一服务多 TUI、跨进程 prompt、事件进程内且无重放（2.0.27）。
- `docs/research/parked-parent-signal.md` — 运行中的 `subagent` 片段不带子 id；parked 父不排空 inbox（2.0.29）。
- `docs/research/subagent-lifecycle.md` / `subagent-background-mode.md` — 前台 park、后台可应答（2.0.27）。
- `docs/research/opencode-2.2.5-stage-one.md` — 2.2.5 的隔离双进程 ask/reply 与存储非 CAS 结论。
- `docs/research/opencode-v2-plugin-api.md` — 2.0.27/2.0.16 的 API 面与版本漂移。

仓库现状：

- `src/host/events.ts` — 事件索引与 status 折叠。
- `src/peers/roster.ts` — 心跳、TTL、收养、sweep。
- `src/host/storage.ts` — 记录键布局与 `removeIfStill` 的非原子说明。
- `src/actions/delivery.ts`、`src/domain/policy.ts` — 按 roster `status` 选择 steer/queue。
- `src/config.ts` — `rosterTtlMs=90s`、`askTimeoutMs=10min`。
