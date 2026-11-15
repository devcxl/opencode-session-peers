# 看门狗安全账本的原子额度与人工移交能力验证（OpenCode 2.2.7 / 2.3.0 隔离实测）

研究日期：2026-11-15。
研究票：<https://github.com/devcxl/opencode-session-peers/issues/57>，
地图：<https://github.com/devcxl/opencode-session-peers/issues/49>。
前置：[#50 信号研究](https://github.com/devcxl/opencode-session-peers/issues/50)、
[#56 观测实测](https://github.com/devcxl/opencode-session-peers/issues/56)；
政策：[#53 决议](https://github.com/devcxl/opencode-session-peers/issues/53#issuecomment-6877204987)。

本文只回答“一个插件自有的 `bun:sqlite` 安全账本能证明什么、不能证明什么”，
不实现看门狗，不替用户决定自动纠正或人工恢复的业务范围，也不把实验设计当成已通过。
文中的“责任移交”指任务执行所有权从旧 activation 转到新 activation，
**不是** `CONTEXT.md` 里的“交接（Handover，上下文摘要）”。

## 0. 结论先行

### 0.1 能力成立的部分

在**单 OpenCode 服务进程、同一位置（directory）、账本文件本地可写**的前提下，
插件自有 SQLite 账本可以作为以下事实的唯一权威源：

- 一个会话最多一个有效（active/paused）监护任务，并发登记只有一个成功；
- 同一 `requestId` 的重复登记幂等返回同一任务；
- 每任务累计最多三次预留，预留行永久保留，成功/中止/未知都不退还额度；
- 预留提交先于外部 `prompt` 调用，每个预留最多一次自动发送；
- `expectedGeneration + ownerActivation` 匹配才能新建预留；
- 相同 expected generation 的并发人工确认只有一个成功；
- 旧 owner 的新预留被拒；
- 有未决动作（`reserved/sending/accepted/result_unknown`）时责任移交被拒；
- 封存/取消阻止新预留；
- 路径、`ledgerId`、schema/protocol 版本不符、文件损坏、只读、锁超时都只返回明确错误码，不重建旧任务额度。

OpenCode 2.2.7 与 2.3.0 的插件运行时都直接支持 `bun:sqlite`；两者实测均为
Bun 1.4.4 / SQLite 3.53.4。事务、唯一约束、WAL、`synchronous=FULL`、
有限 `busy_timeout` 在插件运行时可用。

### 0.2 不能成立或不能宣称的部分

- **不能**用事务 fencing 阻止旧 owner 在更早预留后延迟发送 `prompt`。
  代次变更只能拒绝**新**预留；已经提交的预留仍可能被旧进程调用。
- **不能**由账本证明“旧 owner 已停稳”。`confirmHandover` 只记录调用方提交的
  stop proof；它不能验证进程是否真的停止。
- **不能**由账本证明“没有未消费的纠正消息”。`session.prompt` 的接纳不等于消费；
  账本只记录调用方声明的 `accepted/consumed`，没有读宿主 inbox。
- **不能**在封存/取消后撤回已接纳的消息，也不能消灭所有已越过最后检查的迟到 prompt。
  封存只能挡新预留；合作方可以停手，已在途的调用停不住。
- **不能**提供 exactly-once。可证明的只是“每个预留最多一次自动调用尝试”，
  且崩溃/未知后不自动重放；不保证宿主不重复投递，也不保证消费恰好一次。
- **不能**由 SQLite 证明“只有一个宿主服务”。`ownerActivation` 是 bearer 值，
  不是进程或宿主身份；三个独立进程持有同一 activation 时可以依次花掉同一任务额度。
- **不能**锁住宿主自身、用户输入、其他插件或跨进程执行。SQLite 只序列化账本写入者。
- **不能**把同 OS 用户的其他进程视为不可信边界之外；文件权限只挡其他 OS 用户。
- **不能**在 SQLite 3.51.2 及更早版本上无条件宣称 WAL 安全：SQLite 官方记录了
  3.7.0–3.51.2 的 WAL-reset 罕见竞态，3.51.3 起修复；本机 Bun 1.3.13 带的是
  3.51.2，OpenCode 运行时带的是 3.53.4。生产账本应要求修复版本。

**因此：账本原语可行；但仅凭账本不足以安全启用自动纠正。**
单宿主、旧 owner 停稳、消息消费结果这三项必须由账本之外的事实提供；
任一项无法证明时，自动路径应保持禁用，人工责任移交也只应按“有证据才移交”处理。

## 1. 版本、运行时与文件系统前提

### 1.1 版本基线

| 项 | 值 | 证据 |
| --- | --- | --- |
| 本机宿主 | `opencode v2.3.0`，`/usr/bin/opencode`，2026-11-14 构建 | `opencode --version` |
| 目标版本复核 | 官方 release `v2.2.7` 的 `opencode-linux-x64.tar.gz`，解压后 `opencode v2.2.7` | GitHub release asset；`--version` |
| OpenCode 插件运行时（两版） | Bun **1.4.4**、Node 26.3.0、SQLite **3.53.4** | 插件内 `Bun.version` / `process.versions` / `sqlite_version()` |
| 本机纯 Bun 实验 | Bun **1.3.13**、SQLite **3.51.2**；另用 Bun **1.4.4** 重跑 | `bun --version`；`sqlite_version()` |
| 仓库类型依赖 | `@opencode/plugin` 2.0.16 | `package.json`（未升级） |
| OS | Linux x86_64 | `uname` |

版本结论要拆开说：

- **2.2.7 与 2.3.0 都实测**了插件内 `bun:sqlite`，不是从 2.3.0 外推 2.2.7。
- 两版插件运行时都嵌入 Bun 1.4.4 / SQLite 3.53.4；这不是本机 `bun` CLI 的版本。
- 纯并发实验同时在 Bun 1.3.13 / SQLite 3.51.2 与 Bun 1.4.4 / SQLite 3.53.4
  下跑过；下面的 107 项检查以 Bun 1.4.4 的最终全量运行为准。
- 只验证 Linux x64；**不声称** macOS/Windows 或其他架构同样成立。

### 1.2 插件运行时实测（隔离实例）

探针插件在一次性 `opencode serve` 中加载，实例使用私有 `HOME`、四个 XDG 目录、
随机 loopback 端口和 scratch 项目；只请求 `GET /api/model` 激活位置，不调用模型。
证据文件在 `runtime-probe.ts` 的 artifact 目录，关键值：

| 检查 | 2.2.7 | 2.3.0 |
| --- | --- | --- |
| `import { Database } from "bun:sqlite"` | 成功 | 成功 |
| `PRAGMA journal_mode = WAL` | `wal` | `wal` |
| `PRAGMA synchronous = FULL` 后读取 | `2` | `2` |
| `PRAGMA busy_timeout = 1500` 后读取 | `1500` | `1500` |
| `PRAGMA foreign_keys = ON` | `1` | `1` |
| `db.transaction(fn).immediate()` | 函数存在且提交成功 | 同 |
| 唯一约束冲突错误码 | `SQLITE_CONSTRAINT_UNIQUE` | 同 |
| `readonly: true` 下写入 | `SQLITE_READONLY` | 同 |
| `create: false` 打开不存在文件 | `SQLITE_CANTOPEN` | 同 |
| 数据库 / WAL / SHM / 目录权限 | `0600/0600/0600/0700` | 同 |
| `ctx.storage` 键 | `get, remove, scan, set` | 同 |
| `ctx.storage.compareAndSet` | `undefined` | `undefined` |
| `ctx.storage.transaction` | `undefined` | `undefined` |
| `ctx` 键中有宿主/服务身份 | 无；`app` 只有 `channel/name/version`，`location` 只有 `directory/project/workspaceID` | 同 |

隔离断言：运行前后 `service.json` md5 均为 `fe79ebf3151c4a3fdb132d6b3193fca2`，
live pid `1725441` 仍存活；实例端口为随机 loopback（如 `36237`），
实例停止且端口关闭；没有读取宿主 SQLite、auth、service 凭据或现有会话。

### 1.3 官方文档给出的前提

- `bun:sqlite` 是 Bun 内置模块；Bun 官方 1.1 发布说明写明 “Since 1.0, Bun has had
  built-in support for SQLite”。当前文档列出事务、WAL、`.immediate()` 变体、
  prepared statement 与 `Database` 选项：
  <https://bun.com/docs/runtime/sqlite>、<https://bun.com/blog/bun-v1.1>。
  文档没有给出 `.immediate()` 的精确最低版本；实测覆盖 Bun 1.3.13 与 1.4.4。
- SQLite WAL 要求所有进程在同一台主机，**不能放在网络文件系统**上；
  WAL 依赖 `-wal` 与 `-shm` 共享内存：
  <https://www.sqlite.org/wal.html>。
- `synchronous=FULL` 时 WAL 在每次事务提交时同步；`NORMAL` 不保证掉电持久性。
  同前，§2.3。
- SQLite 官方记录 WAL-reset 竞态：影响 3.7.0–3.51.2，3.51.3 起修复；
  多连接同文件并发写/checkpoint 的极窄窗口。见 WAL 文档 §11。
- OpenCode 插件 server 部分运行在 OpenCode server 内；`ctx.storage` 的公开 API 只有
  `get/set/remove/scan`，没有 compare-and-set 或事务：
  <https://opencode.ai/docs/build/plugins/server>。

### 1.4 文件系统与路径前提

- 账本必须放在**本地**、当前 OS 用户可写、非网络文件系统的状态目录；
  WAL 需要同目录 `-wal/-shm` 可创建或可读。
- 目录 `0700`、数据库与 sidecar `0600`；探针实测 SQLite 创建的文件默认可能是
  `0644`，插件必须自己 `chmod`，不能只依赖 umask。
- 路径必须是绝对、规范化、非 symlink 的插件状态路径；不得接受会话文本提供的路径。
  实现在打开时 `realpath`、拒绝 symlink、记录 canonical path；复制到另一路径会被拒。
- 同 OS 用户的其他进程仍可读写/删除该数据库；`ledgerId`、schema、路径检查能发现
  误复制/误重建，**不是防篡改或认证**（与 ADR-0004 的信任边界一致）。

## 2. 账本契约（研究原型）

### 2.1 表与权威字段

| 表 | 作用 | 关键约束 |
| --- | --- | --- |
| `meta` | `ledger_id`、schema/protocol、canonical path | 主键 key；打开时校验版本与路径 |
| `watch_tasks` | 任务身份、session、state、owner activation、generation、`reserved_count` | `reserved_count BETWEEN 0 AND 3`；`session_id` 上部分唯一索引（active/paused） |
| `reservations` | 每次预留的永久行 | `UNIQUE(task_id, attempt_no)`；部分唯一索引限制每任务最多一个 open 动作 |
| `handovers` | 责任移交审计 | `UNIQUE(task_id, to_generation)` |
| `registration_requests` | 登记幂等键 | `request_id` 主键，绑定 task/session |
| `ledger_events` | 追加审计 | 仅追加，不参与授权判断 |

部分唯一索引：

```sql
CREATE UNIQUE INDEX one_live_task_per_session
  ON watch_tasks(session_id) WHERE state IN ('active','paused');

CREATE UNIQUE INDEX one_open_reservation_per_task
  ON reservations(task_id)
  WHERE state IN ('reserved','sending','accepted','result_unknown');
```

`watch_tasks.ledger_id` 与 `meta.ledger_id` 必须一致；`meta.canonical_path` 必须与
本次打开路径一致；`schema_version/protocol_version` 不符直接拒绝打开。

### 2.2 预留状态机

```text
reserved ──markSending──> sending ──prompt outcome──> accepted ──consumed──> result_recorded
    │                        │                          │
    ├── not_accepted ────────┼──> aborted               └── unknown ──> result_unknown
    ├── accepted ────────────┤
    └── unknown ─────────────┴──> result_unknown
```

- `reserved/sending/accepted/result_unknown` 都是 **open**：阻止新预留与责任移交。
- `result_recorded` 表示有明确消费结果；`aborted` 表示确定未接纳；两者都不回退额度。
- `result_unknown` 永不自动重放；只能由人工对账后另行处理，账本不提供“自动重发”。
- 预留行不删除；`reserved_count` 只增不减；没有 refund API。

### 2.3 发送协议（调用方必须遵守）

1. `reserve()` 提交成功且 `fresh=true` 才可能发送；
2. `markSending()` 返回 `maySend=true` 才允许调用一次 `session.prompt`；
3. `markSending()` 返回 `already_sending` 时**不得**再发（崩溃后的新进程尤其如此）；
4. 调用后记录 `accepted`（宿主接纳但未消费）、`consumed`（有消费结果）、
   `not_accepted`（确定未接纳）或 `unknown`（结果不明）；
5. `unknown`/`accepted` 未消费时，下一次 `reserve` 必被 `pending_attempt` 拒绝。

账本不执行 `prompt`，也不观察宿主 inbox；协议的正确性依赖调用方不绕过这些检查。
`raw-send` 负控制证明：绕过账本的进程仍可发消息，账本无法阻止。

### 2.4 责任移交（ownership transfer）契约

`confirmHandover` 在同一个 `BEGIN IMMEDIATE` 中要求：

- 任务存在、`ledger_id` 匹配、state 为 `active` 或 `paused`；
- `generation == expectedGeneration` 且 `owner_activation == fromActivation`；
- 没有 open reservation；
- 调用方提交完整的 `HandoverEvidence`：
  `oldOwnerStopped: true`、`inFlightResolved: true`、`noUnconsumedMessages: true`、
  非空 `stopProof`、`observedAt`；
- 更新 owner、`generation+1`、state 回到 `active`，并插入唯一 handover 行。

**关键限制**：`HandoverEvidence` 是调用方声明，不是账本验证的事实。
账本只能保证“没有声明就不移交”，不能保证声明为真。

### 2.5 封存/取消

`setState('sealed'|'cancelled')` 只改变任务状态：

- 新 `reserve` 返回 `not_active`；
- 合作方 `markSending` 也会被 `not_active` 拒绝；
- 已经 `sending` 的调用不受影响；已 `accepted` 的消息仍可能被消费；
- 不存在撤回宿主 inbox 的 API，因此不能承诺“封存后绝无迟到消息”。

## 3. 实测矩阵

### 3.1 运行方式

```sh
# 最终全量（Bun 1.4.4，SQLite 3.53.4）
/tmp/opencode/bun-1.4.4/bun-linux-x64/bun scripts/research/watchdog-ledger/run.ts

# 本机默认 Bun 1.3.13（SQLite 3.51.2）
bun scripts/research/watchdog-ledger/run.ts

# 运行时探针：可指向 2.2.7 官方 release
OPENCODE_BIN=/tmp/opencode/opencode-2.2.7/opencode \
  bun scripts/research/watchdog-ledger/runtime-probe.ts
```

最终全量：**13 个场景、107 项检查、0 失败**。
证据在 `/tmp/opencode/watchdog-ledger-evidence/final-bun144/summary.json`
（本次运行的 artifact 目录；报告只引用数值，不提交二进制证据）。
Bun 1.3.13 的同一矩阵也通过；差异见 §4.9 的 SQLite 版本说明。

### 3.2 场景结果

| 场景 | 方法 | 结果 |
| --- | --- | --- |
| `registration` | 8 个真实进程并发登记不同 request；8 个并发登记同一 request | 不同 request：1 个 `created`、7 个 `session_conflict`、任务行 1；同一 request：全部返回同一 task，只有 1 次插入 |
| `registration`（状态） | active -> paused -> 新 request；paused -> sealed -> 新 request | paused 仍占唯一 live 槽；sealed 后显式新轮次可登记 |
| `quota` | 3 轮、每轮 8 进程并发 `reserve`，每轮解析获胜者；之后 8 进程再抢 | 每轮恰好 1 个预留；第 1/2 轮其余 `pending_attempt`，第 3 轮其余 `quota_exhausted`；`reserved_count=3`、3 行；重开不退还 |
| `no-refund` | 3 次 `reserve -> markSending -> not_accepted` | 第 4 次仍 `quota_exhausted`；3 行均 `aborted` |
| `pending-and-unknown` | `unknown`、`accepted`、预留后崩溃、发送后崩溃、同一 reservation 双进程 | 所有 open 状态阻塞新预留；崩溃后无自动重发；同一 reservation 只发 1 次 |
| `handover` | 10 进程并发同一 expectedGen；旧/新 owner 各 reserve；重启 activation；缺失/虚假 evidence；pending/accepted/unknown | 恰好 1 个成功、9 个 `stale_owner`、generation 只 +1；旧 owner `stale_owner`；新 owner 可预留；重启 activation `stale_owner`；缺证据/`oldOwnerStopped=false` 拒绝；pending/accepted/unknown 均 `pending_attempt` |
| `late-send` | 旧 owner 预留后 sleep 再发送；先尝试移交；强制只改代次的负控制 | 严格移交在预留 open 时拒绝；旧 owner 仍发送 1 次；消费后才可移交；强制代次移交后旧 owner 仍发送，旧 owner 记录结果 `stale_owner`，新 owner 被旧 open 预留阻塞 |
| `seal` | 预留后封存；合作方 `markSending`；raw send；封存前 accepted | 封存挡新预留；合作方被停；raw send 仍发生；accepted 消息封存后仍可被消费；取消同样挡新预留 |
| `busy-timeout` | 一进程 `BEGIN IMMEDIATE` 持锁 2s；另一进程 `busy_timeout=300` 抢 | 约 300ms 级 `lock_timeout`（<1.5s）；释放后同一预留成功 |
| `durability` | 5 次在预留提交后 `SIGKILL` | 5/5 重开仍见 `reserved` 行与 `reserved_count=1` |
| `identity-and-corruption` | 复制库、损坏头、schema/protocol 改版、删除重建、symlink、相对路径、只读、权限 | 复制：`ledger_path_mismatch`；损坏：`corrupt`/`io_error`；版本：`unsupported_schema`；重建：新 `ledgerId`，旧 task `unknown_task`；symlink/相对：`unsafe_path`；只读：`readonly`/`io_error`；权限 `0600/0700` |
| `lww-negative-control` | 10 进程共享读-改-写计数并各自发送 | 10 次发送，最终计数 1；无法把动作限制在 3 次 |
| `single-host-identity` | 3 个独立进程使用同一 activation 依次 `reserve-send` | 3 次都被接受并花掉 3 次额度；第 4 次被 quota 拒绝，不是被“进程身份”拒绝 |
| `reserve-before-send` | 正常 `reserve-send` | 发送日志有预留 id，且发生在预留之后 |

### 3.3 关键数值

- 并发登记：8 -> 1 个任务；同一 request 8 -> 1 次插入、同一 taskId。
- 并发预留：8 -> 1 个；三轮共 3 个；第 4 个全部拒绝。
- 并发责任移交：10 -> 1 个成功；generation 1 -> 2；handover 行 1。
- 崩溃持久性：提交后 SIGKILL 5/5 保留。
- 锁等待：holder 2000ms，contender `busy_timeout=300`，实测约 300ms 级返回 `lock_timeout`，未无限等待。
- 发送后崩溃：send log 恰好 1 条；重开仍 `sending`；新预留 `pending_attempt`。
- LWW 负控制：10 次发送 / count=1。

## 4. 硬边界与不可消除的竞态

### 4.1 代次 fencing 不能替代“旧 owner 停稳”

时间线：

1. 旧 owner A 成功提交 `reserve(res-1)`，然后暂停/网络延迟/调度延迟；
2. 人工确认想移交给 B；
3. 如果移交只检查 `generation`、不检查 open reservation，则更新成功；
4. A 之后仍调用 `session.prompt`，消息发出；账本无法撤回；
5. A 再记录结果时因 generation 已变而 `stale_owner`，留下一个永远 open 的旧动作。

本实验的 `force-handover` 负控制精确复现了第 3–5 步：task 到 generation 2、
旧 `res-1` 仍 `sending`、send log 1、旧 owner `recordOutcome` 返回 `stale_owner`、
新 owner `reserve` 返回 `pending_attempt`。消息已经发出，账本只能阻塞后续动作，
不能撤回这一条。

严格实现因此在移交事务里要求“没有 open reservation”，并在调用侧要求
`oldOwnerStopped`、`inFlightResolved`、`noUnconsumedMessages`。但这些都是**声明**；
真正的停止必须由进程生命周期/宿主关闭/人工操作来证明。

### 4.2 “已接纳”不等于“已消费”

- `session.prompt` 返回成功只表示宿主接纳；可能仍在 inbox、尚未开始回合。
- 账本把 `accepted`（已接纳未消费）视为 open，拒绝新预留和移交；
- 只有调用方声明 `consumed` 后才变 `result_recorded`；
- 如果声明为真但宿主仍有迟到消费，账本不知道；
- 如果声明为假，移交会被错误允许，迟到 prompt 仍可能发生。

因此“无未消费纠正消息”必须来自宿主侧可核验事实；本实验没有找到插件 API 能读
inbox 消费状态。可用的只有 `session.context`/事件等间接证据，未在本轮重测，
不能作为移交证明。

### 4.3 封存/取消只挡新预留

- 合作方会尊重 `not_active`：`markSending` 被拒；
- 已经 `sending` 的调用不受影响；
- 已经 `accepted` 的消息仍可能被消费；
- 绕过账本的 `raw-send` 仍能发消息。

所以不能写“事务封存后绝无迟到消息”，也不能把删除本地记录当成撤回成功。

### 4.4 exactly-once 不成立

- `reserve` 的持久行 + `markSending` 的持久标记，能保证调用方**最多一次自动调用尝试**；
- 但外部调用与本地记录之间没有原子性：崩溃在调用前 -> 额度已花但未发；
  崩溃在调用后 -> `sending` 阻塞，可能已发但无结果；
- 未知结果不自动重放，所以不会自动重复；但宿主/传输层是否重复投递不由账本控制；
- 接纳、消费、恢复确认是三件事，账本只记录调用方声明。

因此报告只使用“至多一次自动尝试”“不自动重放”，不使用 exactly-once。

### 4.5 单宿主不是 SQLite 能证明的属性

- 三个独立进程使用同一 activation 依次成功预留、发送、消费；
  账本把它们视为同一 owner；第 4 次才被 quota 挡住。
- `ctx.app` 只有 `channel/name/version`，`ctx.location` 只有目录/项目/工作区；
  运行时没有暴露“服务实例 id”或“宿主 pid”。
- WAL 的“同主机、非网络 FS”只保证 SQLite 文件语义，不保证只有一个 OpenCode 服务。
- 两个独立服务共享状态时，跨进程 `prompt` 已由 #56 实测为不安全（会中断正在运行的工具）；
  账本不知道 session 实际由哪个服务执行。

结论：单宿主、同位置必须作为**部署前提**由外部保证或在启动时显式确认；
不能从账本推断。多独立宿主共享状态时自动路径应禁用。

### 4.6 SQLite 不锁宿主/用户输入

账本只序列化自己的写入者。它不能阻止：

- 用户或其他会话继续向目标会话发消息；
- 宿主自动恢复/重试回合；
- 其他插件进程修改数据库；
- 旧 owner 已经越过最后检查的 `prompt` 调用。

所以账本的作用是“给出可审计的动作资格和额度”，不是“把目标会话锁住”。

### 4.7 文件权限与同用户攻击

- 目录 `0700`、数据库/`-wal`/`-shm` `0600` 可挡其他 OS 用户；
- 同 OS 用户进程仍可直接读、写、删除、篡改数据库；
- `ledgerId`、canonical path、schema/protocol 检查能发现误复制、误重建、版本漂移，
  不能发现恶意同用户篡改；
- 与 ADR-0004 一致：信任边界是 OS 用户，不做 peer 认证。

### 4.8 冷启动与锁竞争

一次未预初始化的 8 进程并发首开（Bun 1.4.4）出现过 1 个 `lock_timeout`：
首次建表/meta 写入是写事务，多个进程同时冷启动会竞争。预初始化后同一测试全通过。
部署上应：

- 由一个已知实例先创建/迁移账本，再允许并发使用；或
- 对冷启动失败做**有界**幂等重试，最终仍失败则只通知，不自动行动。

这不是预算/所有权错误；但它是必须处理的启动路径。

### 4.9 SQLite 版本与 WAL-reset

- 本机 Bun 1.3.13 带 SQLite **3.51.2**，落在官方 WAL-reset 竞态影响范围
  （3.7.0–3.51.2；3.51.3 修复）。
- OpenCode 2.2.7/2.3.0 插件运行时带 SQLite **3.53.4**，已修复。
- 本实验的纯并发矩阵在 3.51.2 与 3.53.4 上都通过，但没有故意触发该极窄竞态；
  不能据此宣称 3.51.2 安全。
- 生产账本应要求 SQLite >= 3.51.3（或厂商已回移修复的构建），并在启动时记录
  `sqlite_version()`；版本不符时只通知，不启用自动路径。

### 4.10 掉电持久性未实测

- `SIGKILL` 只验证进程崩溃后的 WAL 恢复；不等价于掉电/硬重启。
- `synchronous=FULL` 的官方语义是每次提交同步 WAL；实际掉电行为依赖文件系统、
  磁盘缓存和 OS。未做断电实验，不能宣称“掉电也绝不丢已提交预留”。
- 若要更强保证，需要目标平台的断电/fsync 故障注入；不在本轮环境内。

### 4.11 多平台未验证

- 只测 Linux x64；Bun 文档说明 macOS 使用系统 SQLite，版本/编译选项不同；
  Windows 也未测。
- 不能把 Linux 的权限、WAL、`busy_timeout` 结果外推到所有平台。

## 5. 下游落地门槛与最小接口

### 5.1 自动路径必须同时满足

1. **单 OpenCode 服务进程**执行目标会话；同一 OS 用户/状态目录没有第二个独立服务
   共享账本；这是部署前提，不能由账本证明。
2. 观察者与目标会话**同一位置**；跨位置/跨进程自动纠正禁用（#56）。
3. 账本路径来自插件状态目录（如 `XDG_STATE_HOME` 下的插件子目录），
   绝对、规范化、非 symlink；不接受会话文本路径；目录 `0700`、文件 `0600`。
4. 运行时 SQLite >= 3.51.3（或已修复构建）；`bun:sqlite` 可用；WAL 在本地 FS；
   `busy_timeout` 有界并在超时后只通知。
5. 打开时校验 `ledgerId`、canonical path、schema/protocol；任何不符、损坏、只读、
   锁超时 -> 只通知，不创建新任务、不重建旧额度。
6. 每次动作前重新检查任务状态、owner/generation、剩余额度、open 动作、观测完整性；
   预留提交先于发送；发送前 `markSending` 只能成功一次；未知结果不重放。
7. 重载/重启/迁移默认安全暂停：新 activation 不能自动接管；只有人工移交且
   stop proof、在途结果、无未消费消息三项都有证据时才恢复；累计额度保留。
8. `ctx.storage` 只做发现/展示，不作为预算、代次、授权或有效任务的第二真源。

### 5.2 最小接口（研究原型）

```ts
registerTask({ requestId, taskId, sessionId, ownerActivation, authorizationRound })
  -> { taskId, generation, created } | error

reserve({ reservationId, taskId, expectedGeneration, ownerActivation })
  -> { reservationId, attemptNo, fresh, maySend } | error

markSending({ reservationId, taskId, expectedGeneration, ownerActivation })
  -> { maySend: true } | { maySend: false, code: "already_sending" } | error

recordOutcome({ reservationId, taskId, expectedGeneration, ownerActivation,
                outcome: "accepted"|"consumed"|"not_accepted"|"unknown" })
  -> { state, changed } | error

confirmHandover({ handoverId, taskId, expectedGeneration,
                  fromActivation, toActivation, evidence })
  -> { generation, changed } | error

setState({ taskId, expectedGeneration, ownerActivation,
           state: "paused"|"sealed"|"completed"|"cancelled" })
  -> { state } | error
```

错误码至少区分：`quota_exhausted`、`pending_attempt`、`stale_owner`、`not_active`、
`stop_proof_missing`、`lock_timeout`、`readonly`、`corrupt`、`unsupported_schema`、
`ledger_path_mismatch`、`ledger_mismatch`、`unknown_task`。调用方对所有这些错误
都应“通知/停止自动”，不应自行猜测并继续。

### 5.3 下游必须先回答的外部问题

- 如何证明“只有一个 OpenCode 服务进程”？（当前 `ctx` 没有服务 id）
- 如何证明旧 owner 已停稳？（进程退出、`cleanup`、人工确认？）
- 如何证明没有未消费的纠正消息？（宿主 inbox 消费状态或等价证据？）
- 如何证明 `consumed` 不是调用方自报？（事件/消息结果的可关联证据？）

在这些问题有可验证答案前：

- 自动纠正保持**禁用**；
- 人工责任移交只能按“有 stop proof + 在途结果 + 无未消费消息”的显式证据执行，
  且保留累计额度；
- 账本可以继续用于预算、代次、任务身份和审计，但不能单独作为自动路径的安全证明。

## 6. 残余未知

1. **宿主/服务身份**：`ctx.app`、`ctx.location` 没有服务实例 id；未找到官方 API。
   若用配置约定 + 心跳租约，需要另行验证；租约不是“只有一个宿主”的证明。
2. **旧 owner 停稳证明**：没有进程级握手；`cleanup` 在 SIGKILL 下不保证运行；
   宿主位置回收/热重载的时序也未与账本绑定。
3. **inbox 消费证据**：`session.prompt` 只返回接纳；没有插件 API 读“这条消息是否被消费”。
   事件/context 的间接证据未在本轮验证，不能作为移交前置。
4. **跨进程/跨位置**：本轮没有启动两个真实 OpenCode 服务共享账本并执行同一会话；
   只验证了账本层面的多进程写入与 #56 的既有结论。自动路径已按 #56 禁用。
5. **多平台**：Linux x64 之外未测；macOS 系统 SQLite 版本/编译选项不同。
6. **掉电/fsync 故障**：未测；`synchronous=FULL` 只是配置事实。
7. **冷启动并发**：观察到一次 `lock_timeout`；未量化不同启动顺序/重试策略。
8. **同用户篡改**：未做攻击测试；账本不是认证机制。
9. **SQLite 版本差异**：3.51.2 与 3.53.4 行为在本矩阵一致，但 WAL-reset 修复差异
   是官方文档事实，未用故障注入复现。
10. **Bun `.immediate()` 的最低版本**：官方文档未给精确最低版本；实测 1.3.13/1.4.4，
    更老版本未测。

## 7. 证据与复现资产

本轮新增（未改 `src/`、未升级依赖、未合并主分支）：

- `docs/research/watchdog-ledger-validation.md`（本文）
- `scripts/research/watchdog-ledger/`：
  - `ledger-core.ts` / `ledger-ops.ts` / `ledger.ts`
  - `worker.ts`（真实子进程：reserve/handover/crash/raw-send/LWW）
  - `scenarios-*.ts`、`run.ts`、`experiment.ts`
  - `runtime-probe.ts`、`probe-plugin/index.ts`
  - `README.md`

复现命令与 artifact 说明见 `scripts/research/watchdog-ledger/README.md`。
最终全量：107 项检查 0 失败（Bun 1.4.4 / SQLite 3.53.4）；
Bun 1.3.13 / SQLite 3.51.2 同矩阵通过（除冷启动竞争说明外）。
`bun run typecheck` 通过；`git diff --check` 通过。

## 8. 来源索引

官方文档/发布：

- Bun SQLite：<https://bun.com/docs/runtime/sqlite>
- Bun 1.1 发布说明（“Since 1.0, built-in SQLite”）：<https://bun.com/blog/bun-v1.1>
- SQLite WAL（同主机/非网络 FS、`synchronous`、WAL-reset §11）：<https://www.sqlite.org/wal.html>
- SQLite `PRAGMA synchronous`：<https://www.sqlite.org/pragma.html#pragma_synchronous>
- SQLite `BEGIN IMMEDIATE`：<https://www.sqlite.org/lang_transaction.html>
- OpenCode 插件 server / storage：<https://opencode.ai/docs/build/plugins/server>

本仓库前置研究：

- `docs/research/watchdog-signals.md`（#50）
- `docs/research/watchdog-observation-validation.md`（#56，含空闲不等号勘误）
- ADR：`docs/adr/0001-in-process-primitives-instead-of-a-broker.md`、`docs/adr/0004-same-os-user-trust-boundary.md`、`docs/adr/0005-send-does-not-queue-and-the-recipient-declares-its-policy.md`
- 政策决议：<https://github.com/devcxl/opencode-session-peers/issues/53#issuecomment-6877204987>
