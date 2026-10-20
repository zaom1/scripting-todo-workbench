# 待办工作台（Todo Workbench）产品需求文档 v0.3

> 目标平台：iOS · 实现载体：Scripting 脚本工程（TypeScript / TSX）
> 文档状态：**已随实现校订（v0.3）** · 日期：2026-10-20

| 项 | 内容 |
|---|---|
| 产品代号 | `todo-workbench`（中文名待定，暂称「待办工作台」） |
| 定位 | 重度效率党的**高频自用工作台**，非协作、非多端同步 |
| 数据 | **本地为主**（Scripting Storage），可选**推送到 iOS 系统提醒事项**换取通知 / Siri / iCloud 备份 |
| 交付范围 | **v0.3：PRD + 已实现代码**（`todo-workbench/` 下 `index.tsx` `widget.tsx` `app_intents.tsx` `control_widget_button.tsx` `spotlight.tsx` + `types/parse/logic/store/reminders/runtime/core` 分层，213 条单测 + `tsc` 全绿） |
| 订阅状态 | **已确认：审阅者持有 Scripting PRO** → 触感、控制中心控件、Spotlight、SnippetIntent 从「降级项」升级为**正式需求**（见 9.3）；`CloudSharedData` 在实现中被 **App Group 本地文件**替代（见 5.2），不再需要 PRO；仍为每条 PRO 依赖写了无 PRO 退路，以备换设备或订阅到期 |

**v0.1 → v0.2 变更**：PRO 确认后翻盘的四处 —— ① 新增 **FR-704 控制中心控件**（iOS 上唯一等价于安卓悬浮球的一步捕获，见 A1）；② 新增 **FR-602 Spotlight 系统搜索直达**，顺带解决 v0.1 的 R7（深链到任务详情）；③ **FR-701 小组件的数据可读性问题被 `CloudSharedData` 解掉**（R2 收敛）；④ **FR-401 触感**成为正式需求（R8 关闭）。

**v0.2 → v0.3 变更（实现回填，逐条核对官方文档全文 + 代码已落地）**：本版按「可以写代码」的授权实现了 M0+M1+M3 外壳，过程中 **8 处 v0.2 假设被真文档推翻或收敛**，已在正文就地改正，摘要如下 ——

| # | v0.2 的写法 | v0.3 的事实 | 影响 |
|---|---|---|---|
| ① | `Storage` 是异步 API | **同步**：`get` 未命中返回 `null`，`set` 返回 `boolean` | 5.2 落库与 `runtime.ts` 的 KV 层因此可以完全同步，撤销/切片写入不再有异步竞态 |
| ② | 小组件数据靠 `CloudSharedData`（经 iCloud） | `FileManager.appGroupDocumentsDirectory` + `Path.join` + `writeAsStringSync/existsSync` 即可让小组件跨进程读同一份文件 | **R2 关闭、R14 作废、D14 的隐私摩擦消失**；切片不出设备，且无 iCloud 也能用 |
| ③ | 通知可自定义 identifier 以便取消 | `Notification.schedule` **不接受自定义 identifier** | 取消改为扫 `getAllPendingsOfCurrentScript()` 按 `content.userInfo.taskId` 反查（副作用 `alarm.cancel` 携带 `taskIds`） |
| ④ | 视图修饰符用链式 `modifiers()` | 官方约定：**单层修饰符就是普通 JSX prop**，只有同类多层/需显式顺序才用 `modifiers()` | UI 代码全部改成 prop 写法（`font` / `foregroundStyle` / `listStyle` / `toast` …） |
| ⑤ | 文字颜色 `color="…"` | 属性名是 **`foregroundStyle`**；`listStyle="insetGroup"`；`toast` 是对象 prop `{isPresented,onChanged,message}` | FR-401/402/601 的实现细节 |
| ⑥ | snooze 后任务「折叠为稍后」（13.2） | 实现改为 **snooze 只压提醒、不压可见性** | 今日/计划里仍看得见，避免「稍后 = 消失」这个竞品抱怨；新增 `isSnoozed()` 仅用于行内标记 |
| ⑦ | 只有日期没有时刻的任务如何通知未定义 | 新增 **D15**：默认在当天 `allDayNotifyHour`（默认 09:00）推一条，可用 `allDayNotifyEnabled` 关闭 | FR-502 P0 补齐空缺，`recomputeAlarm` 统一算 `scheduledAt` |
| ⑧ | 撤销栈「内存最近 20 条」 | 实现为**持久化 40 条**，条目存「受影响任务的前镜像 + 新增 id」而非整库快照 | 杀进程仍可撤销，且撤销不会吞掉期间的新增（竞品常见坑） |

另外：**R4 / R7 / R11 / R12 从「未验证」降级为「已按文档实现，待真机确认」**（AppIntent 注册、`Spotlight.current.parameters` 回传、通知按钮 `Script.createRunURLScheme` 回跳、`Spotlight.delete/deleteItems/deleteAll` 均文档已给出）；**D8 实时活动本版未实现**；M3 的导入导出 UI、FR-404 拖拽投放（R10）在实现里给了 `contextMenu` 退路但未做拖拽投放区。真机待验项已单独整理为 [`todo-workbench/真机验证清单.md`](todo-workbench/真机验证清单.md)。

**审阅指引**：需要你拍板的是 **第 12 章的 14 个决策点**；其余章节我按「合理默认 + 可推翻」来写，标 🟡 的是我替你做的设计选择，标 ⚠️ 的是尚未经文档验证的技术假设。

---

## 1. 背景与目标

### 1.1 问题

系统提醒事项够用但「整理成本高、执行路径长」；Todoist / 滴答清单功能全但要订阅、要云同步、功能堆叠让**整理成本 > 执行成本**。Scripting 这类脚本环境允许我们把一个 iOS 原生 UI 用 TSX 写出来，因此可以做一个「只服务自己工作流」的待办工具：**去掉所有付费墙、同步、协作、社交、模板市场，只保留捕获 → 整理 → 今日执行 → 归档这条主干，并把它做到极快。**

### 1.2 目标（按优先级）

1. **一步捕获**：在任意 App 内拉出控制中心点控件（FR-704）、点小组件「＋」（FR-701）、或对 Siri 说话（FR-702）即可落库，**不需要打开本 App、不丢当前上下文**。
2. **今日视图每天归零**，靠手动挑选建立当日承诺，而不是让逾期项自动涌进来。
3. 完成任务时的反馈（**触感** + 动效 + 可撤销）达到 Things 3 的主观手感。
4. 关键项能被**系统级通知**叫醒（这是「本地为主」方案的短板，用推送系统提醒事项补齐）。
5. 数据是**一个可读的 JSON 文件**，随时能导出、能改、能带走。
6. **系统级入口齐全**：Spotlight 搜到即直达任务详情（FR-602）、锁屏/快捷指令内嵌捕获卡片（FR-705），把「iOS 没有安卓悬浮球」这个先天劣势补到接近 1 步。

### 1.3 非目标（明确不做）

| 不做 | 原因 |
|---|---|
| 多端实时同步 / 云端账号 | 主库永远是设备本地 JSON。小组件用的「当日切片」经 **App Group 本地文件**共享（v0.3 校订：不再走 `CloudSharedData`/iCloud），不作为跨端主库、不承担冲突合并（见 D5、5.2） |
| 协作、指派、共享清单 | 单人自用 |
| 看板 / 番茄 / 习惯 / 四象限全家桶 | 竞品差评集中点：功能堆叠使整理成本超过执行成本。**四象限只借机制（FR-404 拖拽即改判），不借视图** |
| 无限层级子任务 | Things 3 刻意只做到两层；本方案子任务固定一层 |
| 日历视图（月历格子） | 成本高、自用收益低；用「未来 7 天分组」替代（🟡 见 D3） |
| 数量配额、付费墙 | 竞品（Todoist 2025-11 收紧免费项目数）差评主因 |

---

## 2. 目标用户与核心场景

用户 = 你本人。设备 = 一台 iPhone，Scripting 已装。使用频次预期：**每天 8–20 次打开，每天捕获 5–20 条，完成 5–15 条**。

**S1 · 打断式捕获**（最高频，日均 10+）
正在做别的事，想起「报销单要在周五前交给财务」。→ 从桌面小组件/快捷指令点一下 → 常驻输入框敲 `周五 #工作 @财务 !1 报销单交财务` → 回车 → 焦点保留，立刻回去干活。**要求：从解锁到记录 ≤ 2 步，不出现任何需要顺手做决定的弹窗。**

**S2 · 晨间规划**（每天 1 次，60–120 秒）
打开今日视图，空态。下拉或点「挑选」→ 从收集箱 + 计划 + 各项目里勾选今天要做的事 → 它们进入今日，带上当日日期标记。昨天没做完的**不自动带过来**，需要显式「拾取逾期」。**要求：昨日遗留必须可见但不强迫。**

**S3 · 执行中勾选**（日均 10+）
做完一件事 → 行首圆圈单击 → 触感 + 划线 + 淡入归档位，底部出现 5 秒「撤销」。**误勾不需要重新找。**

**S4 · 到点必须被叫醒**（低频但价值最高）
「19:00 给妈妈打电话」→ 勾选「同步到提醒事项」→ 系统提醒事项出现该条并按时推送；在系统里勾掉它，下次打开工作台时本地状态自动对齐。

**S5 · 周复盘**（每周 1 次，2 分钟）
看归档（Logbook）里本周完成 47 条、遗留 6 条逾期 → 删掉不再关心的 4 条，剩下的重新排期。

---

## 3. 竞品结论 → 设计决策

### 3.1 iOS 侧

| 竞品 | 抄什么 | 落到的需求 |
|---|---|---|
| Todoist | Quick Add 语法 `tomorrow 7pm !30min #项目 @标签 p1`，输入即解析、保存后从标题剥离 | FR-201 |
| 滴答清单 | 输入时**高亮**日期词、保存后剥离；勾选与滑动均可撤销；小组件显示完成进度 | FR-202、FR-401、FR-701 |
| Things 3 | 四段时间语义（Today / This Evening / 指定日 / Someday）+ Logbook 归档；FAB 展开为卡片；子任务**只有一层**；勾选带触感与归档动画 | FR-301、FR-401、FR-501、FR-801 |
| Microsoft To Do | My Day **每天清零 + 手动挑选**，逾期不自动进今日 | FR-301 |
| Apple 提醒事项 | 智能列表（按标签/日期/旗标/优先级过滤）、旗标、优先级三档 | FR-601 |
| Due | 「不放行式重提醒」——过期后按 1/5/10/15/30/60 分钟反复提醒直到处理 | FR-503（仅对**少数关键项**开放，默认关） |

**避免**（来自竞品差评）：① 用数量做付费墙；② 过滤视图与完成操作解耦（Apple 智能列表在非列表视图功能退化）；③ 无限标签/嵌套导致整理成本 > 执行成本。

### 3.2 Android 侧

导航形态上安卓与 iOS 并不同构：Todoist 两端都用底部 Tab（可自定义，「Browse」固定右下），但**安卓多出快捷设置磁贴（Quick Settings tile）与长按图标 shortcuts** 两条原生入口；滴答清单两端都用抽屉承载清单，安卓把编辑藏在「管理清单和标签」二级入口里（更绕，不抄）；Google Tasks 是单列表 + 顶部清单切换的极简结构。真正值得抄的是下面这些：

| # | 安卓侧事实 | 落到本 PRD |
|---|---|---|
| A1 | **1 步捕获是安卓的杀手锏**：滴答有悬浮球（桌面及任意 App 上方点「＋」1 步进添加页）、通知栏下拉添加、小组件「＋」、应用内底部常驻快速添加框（支持自然语言 + 按住说话转文字）；Todoist 走小组件 Add Task / Quick Settings 磁贴 / 长按 shortcut，均 1–2 步 | iOS 没有系统级悬浮球，只能靠 `AppIntent`（快捷指令、背面轻点、Siri）与小组件「＋」逼近 → **FR-101、FR-701、FR-702 是「捕获步数」的等价物，不是可选项** |
| A2 | Todoist 安卓**左右滑动作可自定义映射**为 Complete / Schedule / Reminders / Delete，并用方向颜色编码；iOS 端已弃用左滑多选 | 滑动动作**进设置页可重映射**（🟡 默认映射见 FR-402） |
| A3 | 滴答通知自带**四态动作按钮**（Dismiss / Start Focus / Done / Snooze），snooze 档位 15 分钟 / 30 分钟 / 2 小时；**Constant Reminder 持续提醒**逐分钟重复直到用户处理，且移动端免费 | 直接对上 Scripting 已验证的 `Notification` 操作按钮 + `notification.tsx` → **FR-502、FR-503** |
| A4 | Microsoft To Do 的 My Day **每晚自动清空且不可关闭**；未完成不删除、退回原列表，次日靠右上角灯泡「建议」重现；「逾期不自动进今日」是用户最集中的抱怨 | 保留每日重置语义，但**必须可关闭**（新增决策点 D11），并把「昨日遗留 + 建议池」做成显式入口而非猜你 → **FR-301** |
| A5 | 滴答四象限：**长按拖动任务跨象限即改判**重要/紧急，官方预置规则可自定义 —— 「视图即编辑器」比弹窗设规则顺手 | 提炼为 FR-404「拖拽即改判」，但**不做默认视图**（见 D10） |
| A6 | 本地/开源阵营存在的理由：Tasks.org 可完全离线、同步是可选附加项（CalDAV/DAVx⁵ 等）；Simpletask Cloudless 直接把 **todo.txt 纯文本**放本地存储，换来可 grep、可备份、跨 App 互操作 | 印证「本地为主」架构；导出格式在 JSON 之外**增加 todo.txt 兼容层** → **FR-901** |
| A7 | 差评实证：滴答**安卓通知延迟 3–5 分钟**（依赖推送通道）；Google Tasks 子任务仅一层且**子任务无到期日、无重复、无标签**；Todoist 免费版从 80 个项目砍到 **5 个**，被迫升级是最大差评源 | 本地通知绕开推送通道（**FR-502**）；子任务一层可接受，但要给「子任务计数与进度」补偿（**FR-501**）；数量配额写进非目标（**1.3**） |
| A8 | **坑**：Todoist 用户反馈「提醒不随重复任务一起重复」——重复任务的闹钟排了一次就不再更新 | 写进 **FR-502 的验收标准**：重复任务生成下一次实例时必须重新排定提醒，并在 F4 流程里显式落一步 |

**从安卓移植（5 条）**：每日空白落地页 + 建议池（但可关闭）、可重映射的滑动动作、通知四态按钮 + 持续催办、拖拽即改判、纯文本可导出的本地数据层。
**判定不适合自用工具（3 条）**：Karma / streak 等外部激励体系（需服务端，且对高频自用者是噪声）、协作与共享清单（本地无同步底座，做不全反而拖复杂度）、把安卓「抽屉 + Tab 双轨」导航整体照搬。

---

## 4. 信息架构

```
                    ┌──────────────────────────────────────┐
   快捷指令/Siri ──▶│  捕获层 Capture（不进入主界面）        │
   小组件「＋」 ───▶│  输入框 + NL 解析 + 立即落库            │
                    └──────────────────────────────────────┘
                                    │ 落库
                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  主界面 NavigationStack                                          │
│  ┌─ 顶部分段切换（可左右滑动翻页，非底部 Tab）────────────────┐   │
│  │ 今日 │ 收集箱 │ 计划 │ 项目 │ 旗标 │ 归档 │ 设置          │   │
│  └──────────────────────────────────────────────────────────┘   │
│  工具栏：搜索(searchable) · 排序 · 多选(selection) · 新增         │
│  底部：常驻 Quick Add 输入条（获得焦点，连续捕获）                 │
└─────────────────────────────────────────────────────────────────┘
        │ 单击行                       │ 长按行
        ▼                              ▼
   详情 sheet(presentationDetents   contextMenu（改期/优先级/
   medium+large：标题·备注·子任务·    移动到项目/同步提醒事项/转项目）
   日期·提醒·重复·旗标·标签·同步开关）
```

**视图语义**（每条任务只属于一个「位置」，视图是过滤结果，不是复制）：

- **今日**：`inTodayOn == 今天` 且未完成，按优先级 → 截止时间 → 手动排序。
- **收集箱**：无项目归属、无日期。是「未整理」的兜底，允许长期为 0 但不强制。
- **计划**：有日期或重复规则的任务，分组为 `逾期 / 今天 / 明天 / 本周 / 稍后 / 无日期`。
- **项目**：`区域 Area(1 层) > 项目 Project(1 层) > 任务`。项目可含「章节 Heading」，但不支持项目套项目。
- **旗标**：全局旗标视图，跨项目。
- **归档**：按完成日分组（今天 / 昨天 / 本周 / 更早），可反选恢复。

**🟡 D1**：用顶部分段 + 滑动翻页，而不是 `TabView` 底部栏。理由：单手拇指行程短、视图数 7 个偏多、竞品（Things）也是左栏右详情的工作台形态。

---

## 5. 数据模型

### 5.1 Task（核心实体）

```ts
type Priority = 1 | 2 | 3 | 4;              // 1 最高；undefined = 无优先级
type Segment  = "today" | "evening" | "date" | "someday"; // Things 式四段语义

interface Subtask {
  id: string;            // UUID()
  title: string;
  done: boolean;
  order: number;
}

interface Task {
  id: string;                     // UUID，不可变，作为所有引用与同步的锚点
  title: string;                  // 必填，NL 解析剥离后的净标题
  notes?: string;                 // 纯文本，v1 不做富文本
  projectId?: string;             // 归属项目；undefined = 收集箱
  areaId?: string;                // 由 projectId 派生，冗余存储便于过滤性能
  tags: string[];                 // 仅来自 @标签 语法，禁止无管理意图的自由标签膨胀
  priority?: Priority;
  flagged: boolean;               // 旗标（对标 Apple/MS To Do）

  segment?: Segment;              // undefined = 无日期
  dueDate?: string;               // "YYYY-MM-DD" 本地日期，避免时区漂移
  dueTime?: string;               // "HH:mm"，仅 segment="date" 时可设
  endDate?: string;               // 区间任务用（对标 Todoist date range），🟡 见 D4
  scheduledTime?: number;         // 提醒时间戳(ms)，早于 due 时刻
  repeat?: RepeatRule;

  subtasks: Subtask[];            // 固定一层，最多 20（超出提示转项目）
  inTodayOn?: string;             // "YYYY-MM-DD"：被挑进今日的日期 → My Day 每日重置的实现
  pickedFrom?: string;            // 拾取来源视图，用于「退回原处」
  snoozedUntil?: number;          // 稍后提醒，用于 Due 式循环提醒
  waitingFor?: string;            // 等待中（GTD 轻量版），有值则不参与今日推荐

  createdAt: number;
  completedAt?: number;
  done: boolean;
  order: number;                  // 视图内手动排序
  reminderIdentifier?: string;    // 已推送到系统提醒事项的 identifier
  reminderSync?: "off" | "up" | "pending"; // 见 5.4 同步状态机
}

interface RepeatRule {
  freq: "daily" | "weekly" | "monthday" | "interval";
  weekdays?: number[];            // 1=周一…7=周日，weekly 时使用
  bySetPos?: number;              // 每月第 N 个周几，如 2 = 第二个周二
  interval?: number;              // every N days
  mode: "fromCompletion" | "fromDue"; // 完成后重排 / 按日历排（滴答、Things 皆有此分歧）
}

interface Project { id: string; name: string; areaId?: string; color?: string; symbol?: string; archived?: boolean; order: number; }
interface Area    { id: string; name: string; order: number; }
interface Settings {
  schemaVersion: number;          // 1
  firstDayOfWeek: 1 | 0;
  defaultView: "today" | "inbox";
  todayResetHour: number;         // 🟡 默认 4（凌晨 4 点前算昨天），见 D2
  todayResetMode: "reset" | "keep"; // 每日清零 or 保留（微软方案不可关是差评点）
  swipeActions: { leading: string[]; trailing: string[]; fullSwipe: string }; // FR-402 重映射
  nagRepeat: boolean;             // Due 式循环提醒总开关，默认 false
  widgetFamily: "systemSmall" | "systemMedium" | "systemLarge";
  haptics: boolean;
}
```

### 5.2 Storage 落库设计

Scripting 的 `Storage` 是 key-value（`set/get/setData/getData/remove/contains/clear/keys`，**同步 API**：`get` 未命中返回 `null`、`set` 返回 `boolean`，✅ 已在文档逐字确认；v0.2 写的「异步」是错的），支持字符串与二进制 `Data`；`Storage.set(key, value, { shared: true })` 可写入「All scripts」共享域。

**v0.3 实现落地的 key（去掉 `tb.` 前缀，命名空间由脚本自身隔离）**：

```
db.v1          → { tasks, projects, areas, … }   // 单一 JSON，读写原子（主库，本地）
settings.v1    → Settings
meta.v1        → { lastBusinessDay, lastLaunchAt, lastReconcileAt }
undo.v1        → 撤销栈（前镜像 Task 数组 + addedIds，上限 40 条，持久化）
widget.slice.v1→ 当日切片 JSON（同脚本域，小组件的兜底通道）

App Group 文件：<appGroupDocumentsDirectory>/todo-workbench.slice.json   // 小组件首选通道
```

v0.2 设想的 `CloudSharedData: tb.widget.slice` **已被替换**：官方文档给出 `FileManager.appGroupDocumentsDirectory`（+ `Path.join` / `writeAsStringSync` / `existsSync`），同 App Group 的小组件进程可直接读这份本地文件，切片**不出设备**，既省掉 iCloud 依赖又消掉 D14 的隐私摩擦（见 11 章 R2、12 章 D14）。实现里做成**双通道**：先写 App Group 文件，再写 `widget.slice.v1`；读取时文件优先、Storage 兜底，`appGroupDocumentsDirectory` 为 null 也不会失效。

**🟡 D5**：v1 用**单 key 存整库 JSON**，而不是每个任务一个 key。理由：读一次即得全量、写失败可整体回滚、导出即拷贝一个 key。风险是任务量大时写入代价上升 —— 按 2000 条任务 ≈ 600KB JSON 估算，仍在可接受范围，但 ⚠️ **Storage 容量上限文档未说明**，需在 M0 实测（见第 11 章 R1）。若实测不达标，退路是 `FileManager` 写文件，或改用 `SQLite`（✅ PRO，含连接、事务、Schema 管理与自省，适合任务量 > 5000 或需要复杂查询时）。

**双写规则（v0.3 校订：本地优先，不走云端）**：任何会改变「今日列表 / 进度 / 逾期计数」的写操作，先写 `db.v1`（主库，成功即视为操作成功并可撤销），再同步写**当日切片**（App Group 文件 + `widget.slice.v1`）并触发 `Widget.reloadAll()`。切片写失败**不回滚主库**，小组件脚注显示「更新于 <时间>」提示可能非最新。实现上这条规则被收敛到唯一入口 `core.perform()`：撤销入栈 → 归约 → 落盘 → 写切片 → 派发副作用（通知/提醒事项/Spotlight），UI、AppIntent、小组件按钮、通知动作按钮四个入口共用同一条路径，杜绝「某个入口忘了刷新」。

**快照（v0.3 状态）**：v0.2 规划的 `tb.snap.7` 每日 7 份轮转快照**本版未实现**，替代机制是持久化撤销栈（40 条）。若 M3 仍要「误删恢复」，再补每日快照。

### 5.3 ID 与时间约定

`UUID()` 生成 id；日期一律存 `YYYY-MM-DD` 本地日期字符串，时间戳存 epoch ms。不做 UTC 存储（自用、单设备，避免时区变更导致「今日」错乱）。

### 5.4 与系统提醒事项的同步状态机

```
off ──勾选同步──▶ pending ──save() 成功，记录 identifier──▶ up
up  ──改本地字段──▶ pending（重新 upsert）
up  ──本地删除──▶ 删除系统项 → off
up  ──系统在外部被删除/完成──▶ 启动时 reconcile 发现 → 本地标记 done / 回退 off
```

**reconcile 时机**：每次进入主界面时执行一次（异步、不阻塞渲染），对比 `signature` 与系统项实际值。**v0.3 实现的指纹字段**比 v0.2 更宽（`title · notes · dueDate · dueTime · priority · flagged · 子任务勾选态 · done`），任一变化即重新 upsert；**冲突时让系统赢**（用户在 Siri/系统提醒事项里改的概率更高），本地被外部勾掉的直接置 `done`，系统项被手删的本地降级回 `pending` 并在下一次推送。返回结构 `{completedLocally, completedInSystem, detached, needPush, scanned}`，UI 用 `completedLocally.length` 弹 13.1 里那条横幅。

**已知字段损耗**（来自文档 ✅）：Reminder API 支持 title / notes / due date / alarms / recurrence / priority / 完成态，但**未提及子任务与自定义列表**。因此：

- 子任务**只留在本地**，推送时在 notes 里附一份 `[x]/[ ]` checklist 作为可读副本；
- ~~在 notes 首行写入 `tb://<taskId>` 反向锚点~~ → **v0.3 改为存 `task.reminderIdentifier`**（本地 → 系统单向可查，`Reminder.get(identifier)` 即可回读），notes 里只写一行 `工作台 · @标签` 供人眼识别，避免把内部 id 暴露进用户可见的系统备注；
- 优先级映射：**v0.3 按 Apple 的数值语义实现为 `priority = 5 - 本地档位`（本地 1/2/3/4 → 系统 4/3/2/1，0 = 无）**，即数字越小越优先；系统是否真的显示 4 档仍列 R6 待实测；
- **重复任务不在系统里建 RRULE**：每个实例都是新的本地任务 → 推一条新的系统提醒，保证 FR-502 验收线「连续 3 个周五的通知数 = 3」；
- 警报重建用的是官方拼写 **`removAlarm`（文档即如此，非 typo）**：先遍历 `rem.alarms` 逐个 `removAlarm` 再 `addAlarm(EventAlarm.fromAbsoluteDate(scheduledAt))`；「提前 N 分钟」在本地已折算进 `scheduledAt`，不再用 `relativeOffset`。

---

## 6. 功能需求

优先级：**P0 = M0 必须有，缺了就不可用；P1 = 让它成为工作台；P2 = 锦上添花。**
每条带验收标准（G/W/T）。

### 6.1 FR-101 快速捕获 · P0

底部常驻 `TextField` + `onSubmit`，提交后立即清空、**焦点保留**（Things 式连续捕获）。落库时按当前视图注入默认值：在「今日」添加 → 自动 `inTodayOn = 今天`；在项目页添加 → 自动 `projectId`；其余进收集箱。

- **G/W/T**：应用已打开 → 输入「买猫粮」回车 → ≤100ms 内列表出现该项且输入框重新为空并保持焦点；再输入「洗衣服」回车 → 两条都存在。
- **指标**：解锁后 ≤2 步落库；配合 FR-701/702 的小组件「＋」与 AppIntent 做到 **1 步**（对齐滴答悬浮球 / Todoist 磁贴的安卓体验，iOS 侧的等价上限）。
- 输入框右侧提供语音入口需 iOS 系统键盘听写（不自研语音识别，`SpeechRecognition` 列为 P2 增强）。

### 6.2 FR-201 自然语言解析 · P0（语法子集）

单框语法（🟡 我的取舍，去掉 `!30min` 这类与 `!优先级` 冲突的写法）：

| 记号 | 含义 | 例 |
|---|---|---|
| `今天/明晚/周五/10-25/下周三` | → `segment` + `dueDate` | `周五 交报销` |
| `19:00` `晚7点` `早上9点` | → `dueTime` | `19:00 给妈妈打电话` |
| `#词` | → `projectId`（模糊匹配已有项目名，无则**询问是否新建**） | `#工作` |
| `@词` | → `tags[]` | `@财务` |
| `!1`…`!4` | → `priority` | `!1` |
| `^` | → `flagged` | `^` |
| `每周五/每天/每月第二个周二` | → `repeat` | `每周五 周报` |
| `/子任务A /子任务B` | → `subtasks[]`（Things 式斜杠分段） | `搬家 /租箱 /断电` |
| `提前30分钟提醒` | → `scheduledTime` | — |

解析器 = **本地规则 + 中文日期词表**，不依赖网络、不依赖 `NaturalLanguage`。约 200 行纯函数，可单测。

- **G/W/T**：输入 `周五 19:00 给妈妈打电话 #家庭 @重要 !1` 回车 → 净标题恰为「给妈妈打电话」，`dueDate` = 本周周五，`dueTime` = `19:00`，`projectId` = 家庭，`tags = ["重要"]`，`priority = 1`。
- **边界**：无法识别的词**保留在标题里**，绝不吞字；识别歧义（「周三」在下周三之后）时取**最近的未来日期**。

### 6.3 FR-202 解析预览高亮 · P1

输入时实时在输入框下方渲染 chip 条（📅周五 19:00 · #家庭 · !1），并保留原始文本可编辑。⚠️ Scripting 无富文本行内高亮的 `TextField` 能力，故用「输入框 + 下方预览条」替代竞品的高亮方案（🟡 见 D6）。

### 6.4 FR-301 今日视图与每日重置 · P0

- 每日 `todayResetHour`（默认 04:00）之后视为新一天，`inTodayOn != 今天` 的任务**全部离开今日视图**，回到原处，不复制、不删除。
- 「挑选」入口：一个覆盖收集箱/计划/项目的多选面板 → 确认即写入 `inTodayOn = 今天` 与 `pickedFrom`。
- **建议池**：挑选面板顶部固定一段「建议」= 逾期项 + 旗标项 + 连续 3 天被跳过的项目，按优先级排序。**借鉴 Microsoft To Do 的灯泡，但不替用户做决定**——只列不选。
- 逾期区：今日视图顶部**折叠**显示「昨日遗留 3 条」，需显式点开；对其中每条的操作是「拾取回今日 / 改期 / 放弃」，不做自动带入。
- 进度：顶部进度环 `已完成 4 / 计划 7`（滴答小组件同款语义）。
- **可关闭重置**（🟡 D11）：`todayResetMode = "reset" | "keep"`。`keep` 模式下 `inTodayOn` 跨天保留，等同普通「今天」过滤器。微软方案因**不可关闭**被差评，此处必须留退路。
- **G/W/T**：昨天挑了 3 条未做 → 今晨 04:00 后打开 → 今日列表为空、顶部出现折叠的「昨日遗留 3 条」→ 点「拾取」→ 3 条回到今日且 `inTodayOn` 更新为今天；把 `todayResetMode` 设为 `keep` 后重进 → 3 条仍在今日。

### 6.5 FR-401 完成 · 撤销 · 反馈 · P0

- 行首圆圈单击 = 完成：`done = true`、`completedAt = now`；**触感用 `Haptics`（✅ PRO，`Haptics.transient(1.0, 0.7)` / `HapticEngine` 提供 transient·continuous 事件）**：勾中瞬间一记轻击（impact），子任务全完成时一记 success；+ 标题划线 + 0.25s 后淡出，进入归档。无 PRO 时退化为纯动效。
- 撤销：`toast={{ isPresented, onChanged, message: "已完成 · 撤销" }}`（✅ Toast 是**对象 prop**，非链式修饰符），5 秒窗口；同时维护**持久化操作栈最近 40 条**（v0.3：不再是「内存 20 条」），任何写操作（完成/删除/移动/批量）都可撤销，**杀掉脚本重进后仍可撤销**。
- **撤销条目的数据结构（v0.3）**：`{ label, before: Task[]（受影响任务的改动前镜像）, addedIds: string[]（本次新增的 id）, at }`。撤销 = 用 `before` 覆盖同 id 任务 + 删除 `addedIds`，**而不是整库回滚**——这样「A 完成 → 我新增 B → 撤销 A」不会把 B 一起吞掉（竞品常见坑）。一次 `perform` 里多条动作合并为**一条**撤销条目（`#项目` 自动建档 + 新增任务撤销一次即干净回滚）。
- 每日重置 / 清空回收站 / AppIntent 与通知按钮触发的写操作一律 `undoable:false`，不污染撤销栈（后台静默入口不该抢占用户的撤销目标）。
- 子任务全完成时**不自动**完成父任务，父行显示 `2/3` 进度（🟡 Things 语义，见 D7）。
- **G/W/T**：误勾一条 → 点 toast 上的「撤销」→ 该项回到原视图原位（`order` 与 `completedAt` 还原）。

### 6.6 FR-402 滑动与长按 · P1

`leadingSwipeActions` / `trailingSwipeActions` + `allowsFullSwipe`（✅ 存在，按钮需为 `<Button>`）。

| 手势 | 动作 |
|---|---|
| 左滑（leading） | 今日 / 旗标 / 稍后提醒 |
| 右滑（trailing，全滑） | 完成 |
| 右滑（部分） | 改期到明天 / 移到收集箱 |
| 长按 `contextMenu` | 改期、优先级、移动到项目、同步到提醒事项、转为项目、放弃 |

**可重映射**（源自安卓 A2）：设置页可为 leading / trailing 的两个槽位从动作池 `{完成, 今日, 旗标, 改期到明天, 改优先级, 同步提醒事项, 移到收集箱, 放弃, 删除}` 中重选，默认即上表。全滑（`allowsFullSwipe`）动作单独可配，默认「完成」。
撤销窗口 5 秒；**多选不占用左滑**（Todoist iOS 已因弃用左滑多选引发习惯冲突），统一走工具栏 `selection` 入口。
**G/W/T**：把 trailing 槽位改为「改优先级」→ 返回列表右滑某条 → 该项优先级 +1 且出现可撤销 toast；恢复默认后右滑全滑仍为完成。

### 6.7 FR-403 批量操作 · P1

`selection`（✅ 需 `Observable<string[]>`，初值 `[]`）+ 工具栏底部浮条：加入今日 / 移动到项目 / 加旗标 / 完成 / 删除。撤销走同一操作栈。

### 6.8 FR-404 拖拽即改判 · P2（见 D10）

借鉴滴答四象限「拖动 = 写入判断」的**机制**而非其视图：在「挑选」面板与「收集箱」中，长按拖动卡片到顶部两个投放区（`今日` / `以后`）即写入 `inTodayOn` 或清空日期，松手即生效、可撤销。技术上依赖 `Editable List` 的 `onMove`（✅ 存在，需 `EditButton` 进入编辑态）与 `onDrag/onDrop` 修饰符（✅ 文档存在，⚠️ 跨容器投放需实测，见 R10）。**不做四象限矩阵视图**（1.3 非目标）。

### 6.9 FR-501 详情与编辑 · P0

sheet + `presentationDetents`（medium/large，✅ 支持）：标题可改、备注多行、子任务增删（`Editable List` 的 `onMove`/`onDelete` ✅，无新增能力 → 用显式「＋子任务」按钮补齐）、日期/时间/重复/旗标/优先级/标签、「同步到提醒事项」开关与同步状态显示。

### 6.10 FR-502 提醒 · P0/P1

- **P0（本地通知）**：`Notification.schedule({ title, body, userInfo, threadIdentifier, interruptionLevel, trigger: new TimeIntervalNotificationTrigger({ timeInterval, repeats: false }), actions })`（✅ 免费，支持时间/日历/位置触发与操作按钮，可用 `notification.tsx` 自定义 UI）。到期点开 → 深链进入该任务详情。本地通知不经推送通道，规避滴答安卓「通知延迟 3–5 分钟」那类问题（A7）。
- **⚠️→✅ v0.3 关键约束：`schedule` 不能自定义通知 identifier**。因此「改期/删除时取消旧通知」实现为：`getAllPendingsOfCurrentScript()` → 按 `content.userInfo.taskId` 归组 → `removePendings(ids)`。归约层发出的副作用事件相应地是 `alarm.cancel { taskIds: string[] }` 而不是 `{ taskId, identifier }`。兜底手段是冷启动 `rescheduleAll()`：`removeAllPendingsOfCurrentScript()` + 全量重排 + `Notification.setBadgeCount(今日+逾期数)`。
- **通知动作按钮（四态，源自安卓 A3）**：`完成` / `稍后 1 小时` / `改到明天` / `放弃`，每个按钮 `url = Script.createRunURLScheme(settings.scriptName, { act, id, minutes? })`。脚本被拉起后从 `Script.queryParameters.act` 分流到对应归约动作并**静默落库**（`undoable:false`），toast 汇报结果。R4/R11 的代码路径已写完，**只剩真机确认按钮是否能在不显示主界面的情况下完成写库**（清单 V2.2）。
- **snooze 语义（v0.3 修正）**：`snoozedUntil` **只推迟提醒，不隐藏任务** —— 今日/计划里照常可见，行内多一个「稍后」标记（`isSnoozed()`）。v0.2 与 13.2 里「折叠为稍后」的写法作废：把用户明确要做的事从视野里抹掉，是竞品「稍后 = 消失」抱怨的复现。重排时该条按 `snoozedUntil` 排新通知。
- **仅有日期、没有时刻的任务怎么提醒（🟡 新增 D15）**：v0.2 未定义。v0.3 落地为 `recomputeAlarm()` 统一折算 `scheduledAt`：有 `dueTime` 用 `dueDate+dueTime-提前 N 分钟`；只有 `dueDate` 且 `settings.allDayNotifyEnabled`（默认 **开**）时取当天 `allDayNotifyHour`（默认 **09:00**）整点；两者都不满足则不排通知。逻辑单测已覆盖（见 `tests/logic.test.ts`），真机行为见清单 V2.5。
- **P1（系统提醒事项）**：`Reminder` + `EventAlarm`（✅ 非 PRO；`Reminder.save()`、警报用 `EventAlarm.fromAbsoluteDate`，相对档 `EventAlarm.fromRelativeOffset(seconds)` 亦存在）。用于用户要求「人在系统里也能看到、Siri 也能查」的少数关键项。
- 权限：开启「逐脚本权限」时提醒事项/日历需单独授权，用 `Script.requestAccess` 提前发起（✅）。被拒时**降级**为本地通知并在详情页给出说明，不阻塞使用。
- **验收（含竞品踩过的坑 A8）**：一条「每周五 19:00 + 提前 1 小时提醒」的任务，在 10-24 完成后，10-31 的实例必须同时具备 `dueDate` **与**新的通知排期；测试方法 = 连续跑 3 个周五，通知数 = 3、无重复、无遗漏。改期或改重复规则时，旧通知必须先 `cancel` 再重排，禁止叠加。

### 6.11 FR-503 循环催办（Due / 滴答 Constant Reminder 式）· P2

仅对 `flagged && nagRepeat` 的任务，过期后按 1/5/10/15/30/60 分钟反复提醒，直到完成、改期或 snooze。滴答把「逐分钟持续提醒」做成移动端免费能力，说明这个机制对用户是「必须被叫醒」而非「骚扰」——但**默认关闭**（🟡 自用工具一旦烦到想卸载，通知系统就整体失效）。

### 6.12 FR-601 过滤视图与搜索 · P1

`searchable`（✅ `value` + `onChanged`，支持 `searchSuggestions` / `searchCompletion`）。搜索范围：标题 + 备注 + 项目 + 标签；支持 `未整理` `逾期` `今天` 等快捷筛选词。过滤结果里**可直接勾选完成**（对标竞品「视图与操作解耦」的反面教训）。

### 6.13 FR-602 系统 Spotlight 直达 · P1 · 需 PRO

`Spotlight.index({ id, title, contentDescription, keywords, parameters })`（✅ PRO）为每条**未完成**任务建立系统索引（副作用 `spotlight.index { taskId }`，参数键用 `openTask`）；用户从主屏下拉搜索并点击结果后，`spotlight.tsx` 读 `Spotlight.current.parameters.openTask` → `Script.run({ name: settings.scriptName, queryParameters: { id }, singleMode: true })` → 主脚本 **直接呈现该任务的详情 sheet**。

**v0.3 修正两处 v0.2 的认知**：① 反索引 API **文档已给出**：`Spotlight.delete(id)` / `deleteItems(ids)` / `deleteAll()` / `getItems()` / `indexItems(items)`，R12 关闭（只剩索引配额仍未确认，代码上限 500 条、只索引未完成项）；② `Spotlight.current` **只在 `spotlight.tsx` 环境里有值**，不走 `Script.queryParameters` —— 所以落地路径是「spotlight.tsx 当跳板，二次拉起主脚本」，而通知按钮走的是另一条路（`Script.queryParameters.act`）。两条入口在 `index.tsx` 的启动逻辑里合并成同一个 `openId`。
**G/W/T**：主屏下拉输入「报销」→ 系统搜索结果出现该任务 → 点击 → 直接打开并高亮该任务详情，无需先进入任何视图。

### 6.14 FR-701 桌面小组件 · P1

`widget.tsx` 渲染 UI、`index.tsx` 承载逻辑（✅ 官方分工）；`Widget.present(<WidgetView/>, { policy: "atEnd" })`（或 `{ policy: "after", date }`）+ `Widget.reloadAll()` 控制刷新（✅）；点击经 AppIntent（`AppIntentManager.register` + `<Button intent={...}>`，✅ iOS 17+ 交互式小组件）。**基础 Widget 非 PRO**；`Control Widget` 标 PRO（✅ 导航中的 PRO 标记）。

**v0.3 实测约束（写进代码的三个硬规则）**：① `widget.tsx` 里 **hooks 不生效**，所以 `readSlice()` 必须在模块顶层同步取完；② `Widget.present()` **之后的代码不再执行**，所有数据准备、行数裁剪都在 present 前完成；③ 约 30MB 内存上限 → 按尺寸裁剪（small 3 行 / medium 4 行 / large 8 行），根视图挂 `url={Script.createRunURLScheme(...)}` 兜底跳转。收尾必须 `Script.exit()`。

| 尺寸 | 内容 | 交互 |
|---|---|---|
| small | 今日进度 `已勾/总数` + 前 3 条 | 圆圈直接完成（AppIntent 内联）·点行进今日 |
| medium | 今日前 4 条 + 空态引导 | 勾选、「＋挑一条进今日」`PickNextTodayIntent` |
| large | 今日前 8 条 + 脚注「更新于 HH:mm:ss」 | 勾选、刷新、跳「挑选」 |

**头号风险 R2 的最终解法（v0.3 再次改判）**：不再用 `CloudSharedData`（经 iCloud/CloudKit），改用 **App Group 本地文件** —— 主脚本 `FileManager.writeAsStringSync(Path.join(FileManager.appGroupDocumentsDirectory, "todo-workbench.slice.json"), json)`，`widget.tsx` 用 `existsSync` + `readAsStringSync` 读同一份；`appGroupDocumentsDirectory` 为 null 时自动落回**同脚本域的 `Storage` key `widget.slice.v1`**（双通道）。好处：切片**不出设备**（D14 的隐私摩擦消失）、不依赖 iCloud 登录、同步 API 无竞态。剩余待验证收敛为 **R3**（`WidgetReloadPolicy` 刷新预算/最小间隔，勾选后状态可能延迟数分钟）与 **R4**（AppIntent 能否完全静默执行）—— 见真机清单 V5.1 / V6.1。

### 6.15 FR-702 快捷指令 / Siri · P1

`AppIntentManager.register({ name: "捕获任务", protocol: AppIntent, perform })`，参数类型支持文本/枚举（✅ 非 PRO 基本能力，可后台运行）。暴露 4 个 intent：`捕获任务(文本)`、`打开今日`、`完成最近一条`、`挑选今日`。可绑定到锁屏快捷指令、背面轻点、Siri 短语。

### 6.16 FR-704 控制中心控件（Control Widget）· P1 · 需 PRO

`ControlWidget.present(<ControlWidgetToggle ... />)`（✅ PRO）可把**自定义按钮/开关放进控制中心**，点击时关联一个 `AppIntent` 执行脚本并传参（✅）；iOS 18+ 支持部分能力，控件需用户手动在「设置 → 控制中心」添加。

这是 iOS 上对**安卓悬浮球（A1）唯一的等价物**，因此从 P2 升为 P1 并进 M3 首批：

| 控件 | 绑定 AppIntent | 行为 |
|---|---|---|
| `捕获任务` | `CaptureIntent` | 顶层弹出输入卡（sheet），回车落库后返回原 App，**不丢上下文** |
| `打开今日` | `OpenTodayIntent` | 直达今日视图 |
| `完成下一条` | `CompleteNextIntent` | 静默勾掉今日视图第一条（scheduled → pinned → overdue 顺序，依赖 R4）✅ 已注册 |
| `撤销上一步` | `UndoLastIntent` | 弹撤销栈一步；`ControlWidget.parameter === "undo"` 时控件切到这颗（见 6.16） |

**实际注册了 6 个 AppIntent（`app_intents.tsx`）**：`QuickAddIntent(text)`、`CompleteTaskIntent(id)`、`CompleteNextIntent()`、`PickNextTodayIntent()`、`UndoLastIntent()`、`OpenWorkbenchIntent(view)`。共同点：都走 `core.perform(..., { undoable: false })`、都只碰数据不碰 UI、执行完 `Widget.reloadAll()` + `ControlWidget.reloadButtons()`。

**G/W/T**：在其他 App 内 → 下拉控制中心 → 点「捕获任务」→ 输入卡出现 → 敲「买猫粮」回车 → 落库并回到原 App；回到工作台收集箱可见该条。
限制：⚠️ 单个脚本可注册的控件数量、控件刷新频率文档未说明（R13）；无 PRO 退路 = Siri + AppIntent（FR-702）+ 小组件「＋」（FR-701）。

### 6.17 FR-705 快捷指令内嵌捕获卡片（SnippetIntent）· P2 · 需 PRO

`Intent.snippetIntent()` 返回 TSX，配合快捷指令里的「Show Snippet Intent」动作，可**在快捷指令运行界面内直接渲染一个自定义输入卡片**（✅ PRO，**iOS 26+**），不必打开主 App。规划：把「捕获任务」快捷指令做成 snippet 卡（输入框 + 项目快选 chips + 提交），可从锁屏快捷指令、自动化、Siri 调用。与 FR-704 的分工：**控制中心 = 最快（一键起）；snippet = 可组合（能塞进自动化流程，如「收到某封邮件 → 弹出捕获卡」）**。
**G/W/T**：Siri 说「运行捕获任务」→ 快捷指令界面内出现输入卡 → 提交后返回，主 App 未被启动。
⚠️ iOS 26+ 是硬门槛；不满足时自动隐藏该入口并退化为 FR-704 路径。

### 6.18 FR-703 实时活动 · P2

`LiveActivity`（✅ 非 PRO，iOS 14+ / 灵动岛 15+，`start/update/end`）。用途限定为「今日冲刺」计时：专注 25 分钟倒计时 + 完成后一键勾掉当前任务。竞品中无先例，收益不确定，故 P2 且可被砍（见 D8）。

### 6.19 FR-801 归档与统计 · P2

Logbook（按完成日分组、可反选恢复）；统计页用 `Charts`（✅ `BarChart` / `DonutChart` 免费）展示近 30 天完成数、按项目分布、最长连续天数。⚠️ 连续天数指标易沦为「为数据而数据」，v1 只保留完成数与项目分布。

### 6.20 FR-901 数据自助 · P1

导出 `db.v1` 为 `.json`（`FileManager` + `ShareSheet`）；导入（`normalizeDB` 校验字段、丢弃非法条目、旧存档补默认值）；每日快照 7 份（v0.3 未实现，见 5.2）；「重置全部数据」需二次确认并先自动导出。**v0.3 状态：已实现** —— 数据层 `Store.exportJSON/importJSON`（导入时**强制清空撤销栈**，旧前镜像已失效，有单测）+ 设置页两颗按钮：导出走 `FileManager` 写 Documents 再 `ShareSheet.present([path])`，导入走 `Pasteboard.contents()` 里找含 `"db"` 的 JSON。不用系统文件选择器，因为脚本环境里没有确认过可靠的 picker API。
**额外导出 todo.txt 兼容文本**（源自安卓 A6：Simpletask/Tasks.org 靠纯文本换来跨 App 互操作与「可 grep 的数据主权」）：格式 `(A)(2026-10-20) 标题 t:2026-10-24 due:2026-10-24 +家庭 @财务 p:1`，未完成项全量导出，子任务缩进两空格。只保证**导出**可读，导入仍走 JSON。

### 6.21 FR-902 设置 · P1

默认视图、周起始、每日重置时刻与 `todayResetMode`、**触感**（PRO，`haptics: "auto" | "on" | "off"`，实现用 `HapticFeedback.notificationSuccess()/lightImpact()` 等预设，`Haptics.transient(intensity, sharpness)` 作为可调档保留）、全天任务整点提醒开关与小时（D15）、滑动动作重映射、小组件尺寸与切片开关、Spotlight 索引开关、脚本名（通知按钮回跳必需）、控制中心控件安装引导、提醒权限状态、系统同步状态一览（含失败重试与手动 reconcile）、**切片健康度**（最后写入时间 / 路径是否可用）、危险区（清缓存 / 重建索引 / 删除全部同步项 / 清空切片）。

---

## 7. 关键流程

**F1 捕获（控制中心 / 快捷指令路径，1 步）**
控制中心控件（FR-704）或 Siri → AppIntent `QuickAddIntent(text)` → NL 解析（`#项目` 需要时先 `ensureProject`）→ `core.perform({type:"add"}, {undoable:false})` → 写 `db.v1` + **同步**写切片（App Group 文件 + `widget.slice.v1`）→ `Widget.reloadAll()` + `ControlWidget.reloadButtons()` → 回到用户原来的上下文。全程不打开主界面、不丢失当前 App 的状态。
**v0.3 缺口**：`QuickAddIntent` 目前只接**外部传入的 text 参数**（快捷指令 / Siri 可用），「点控件后在控制中心内直接弹输入卡」依赖 `SnippetIntent`（FR-705，iOS 26+，本版未实现）——因此 1 步捕获在 v0.3 里 = 快捷指令传参路径；纯控制中心按钮路径实测为「1 步 + 键盘」（清单 V6.2）。

**F2 晨间挑选**
今日视图 → 点「挑选」→ 多选面板（收集箱/计划/项目 三段 `Section`）→ 确认 → 批量写 `inTodayOn`（一次 `perform` 合并为**一条**撤销条目）→ 进度环从 0/0 变 0/N → toast「已加入 6 条 · 撤销」。

**F3 勾选完成（小组件路径）**
小组件圆圈 → `<Button intent={CompleteTaskIntent({id})}>` → `core.perform({type:"complete"}, {undoable:false})`（内部：归约 → `saveDB` → 写切片 → 派发 `reminder.push` 让系统项同步 done）→ `Widget.reloadAll()`。要求**不弹任何 UI**（R4：代码按静默写完，待真机确认）。

**F4 跨天重置**
启动 → 读 `meta.v1.lastBusinessDay` → 与「按 `todayResetHour` 计算的业务日」比较 → 若新一天：`reduce({type:"rollover"}, undoable:false)` 按 `todayResetMode` 决定是否清 `inTodayOn`（`repeat.mode` 决定基准）→ `purgeTrash` 清过期软删 → `saveDB` + `saveMeta` → `rescheduleAll()` **全量重排通知**（`removeAllPendingsOfCurrentScript` 后逐条重排，天然满足 A8「旧排期先取消」）→ 新一天提示条显示逾期数。整个流程幂等，重复执行结果一致。

**F5 reconcile（双向对齐）**
启动（异步、不阻塞渲染）→ `Reminder.getAll()` 建 `identifier → Reminder` 索引 → 对每个 `reminderSync !== "off"` 的本地任务：系统项缺失 → 清 `reminderIdentifier`、降级 `pending`；系统 `done` 而本地未 done → 本地完成（取 `completionDate`）；本地 done 而系统未 done → 回写系统；`signatureOf(task) !== task.reminderSignature` → 进 `needPush` 重推。返回四类计数供 13.1 的横幅使用。**不再用 `tb://` 标题锚点做匹配**（见 5.4）。

---

## 8. 非功能需求

| 编号 | 需求 | 度量 |
|---|---|---|
| NFR-1 | 捕获路径手感：回车到列表更新无可感知卡顿 | < 100ms（本地 500 条任务下） |
| NFR-2 | 主界面首屏可交互时长 | 目标 < 1s，⚠️ 需实测 JS 引擎冷启动（R5） |
| NFR-3 | 全量写盘不阻塞渲染 | 采用「内存态 + 500ms 去抖写入」，退出前强制 flush |
| NFR-4 | 零网络依赖 | 运行期不发起任何请求；备份仅走本地文件导出（FR-901），**不做远端上传** |
| NFR-5 | 深色模式 / Dynamic Type | 使用 `Color` 语义色与 `preferredColorScheme`，不硬编码色值 |
| NFR-6 | 无障碍 | 每个可点元素有 label；进度环提供 `4/7` 文本替代 |
| NFR-7 | 数据安全 | 无远端上传；删除全部前自动导出快照 |
| NFR-8 | 可维护 | 单工程内模块化：`store.ts` / `parse.ts` / `views/*`，纯函数解析器带 20+ 用例 |

---

## 9. 技术可行性（Scripting API 映射）

### 9.1 已验证可用（免费版）

| 需求 | API | 结论 |
|---|---|---|
| UI 主干 | `NavigationStack` `List` `Section` `ForEach` `TextField` `Button` `Toggle` `DatePicker` `Menu` `contextMenu` | ✅ |
| 状态 | `useState/useReducer/useMemo/useCallback/useContext` `Observable` | ✅ |
| 呈现 | `Navigation.present` + `Script.exit()`；`sheet` + `presentationDetents` | ✅ |
| **视图修饰符写法**（v0.3 新增） | 单层修饰符**就是普通 JSX prop**（`font` / `foregroundStyle` / `listStyle="insetGroup"` / `toast` / `contextMenu` / `sheet` / `searchable`）；只有同类多层或需显式顺序才 `modifiers={modifiers().x().y()}` | ✅ 文档 "Chaining View Modifiers" 原文；v0.2 假设的链式写法已修正 |
| 持久化 | `Storage.set/get/setData/getData/remove/contains/clear/keys`（**同步**，`get` 未命中返回 `null`、`set` 返回 `boolean`），`{shared:true}` 跨脚本共享 | ✅ 已按文档改正（v0.2 误记为异步） |
| 列表交互 | `onDelete` `onMove`（需 `EditButton`）、`selection`、`leading/trailingSwipeActions` + `allowsFullSwipe` | ✅ |
| 搜索 | `searchable` + `searchSuggestions` | ✅ |
| 反馈 | `toast` `Dialog` `Alert` `confirmationDialog` | ✅ |
| 通知 | `Notification.schedule`（时间/日历/位置触发、操作按钮、`notification.tsx` 自定义 UI） | ✅（**注意：不能自定义 identifier**，取消需按 `userInfo` 反查 pending，见 6.10） |
| 系统待办 | `Reminder`（title/notes/日期/警报/重复/优先级/完成态）+ `EventAlarm`（绝对 `fromAbsoluteDate` / 相对 `fromRelativeOffset`） | ✅（删警报的官方方法名是 **`removAlarm`**，非 typo） |
| 小组件 | `Widget.present` `Widget.reloadAll` `Widget.parameter` `WidgetReloadPolicy`；`widget.tsx`/`index.tsx` 分工 | ✅ |
| 小组件交互 | `AppIntentManager.register` + `<Button intent>`（iOS 17+） | ✅ |
| 实时活动 | `LiveActivity` `start/update/end`（非 PRO） | ✅ |
| 运行时 | `Script.env` `Script.queryParameters` `Script.metadata` `Script.run` `Script.exit` **`Script.createRunURLScheme(name, params)`**（通知/小组件按钮回跳的关键） | ✅ |
| 权限 | `Script.requestAccess`（逐脚本权限模型下对日历/提醒事项/定位等单独授权） | ✅ |
| 图表 | `BarChart` `DonutChart` 等 | ✅ |
| 文件 | `FileManager`（含 **`appGroupDocumentsDirectory`** 与同步的 `writeAsStringSync/readAsStringSync/existsSync`）`Path.join` `ShareSheet` `UUID.string()` `Data` `DateComponents` `DateFormatter` | ✅（v0.3：App Group 目录 = 小组件切片的首选通道） |

### 9.2 需要实测（文档未覆盖，全部列入第 11 章风险）

**v0.3 状态**：文档层面的可行性已经全部核完（官方 2.9MB 全文逐条比对 + 本地 `dev/scripting.d.ts` 垫片 + `tsc` 全绿 + 213 条 Node 单测）。剩下的是**只能在 iPhone 上验证的行为**，已整理成 [`todo-workbench/真机验证清单.md`](todo-workbench/真机验证清单.md)（V0–V7 共 38 项，每项带期望值与退路）。

未验证清单（对应真机清单编号）：R1 存储容量/写入耗时（V1.2）；R3 小组件刷新预算（V5.4）；R4 AppIntent 静默执行（V6.1/V6.2）；R5 冷启动时长（V0.3）；R6 系统提醒事项优先级档位与警报重建（V3.2/V3.3）；R10 `onDrag`/`onDrop` 跨容器投放（V4.3，本版退化为 contextMenu + 滑动，未实装投放区）；R13 单脚本可注册的控制中心控件数量（V6.3）；R2′ 小组件能否读 App Group 文件（V5.1，**新的头号待验证项**，不通则回退 `Widget.parameter`/进度环）。

**已因文档核实而关闭**：R2（原「扩展读不到 Storage」→ App Group 文件 + Storage 双通道）、R7（`Script.queryParameters` 与 `Spotlight.current.parameters` 两条深链路径均已实现）、R11（通知按钮 `Script.createRunURLScheme(scriptName, {act,id})` 官方给出，代码已写完，只剩 V2.2 真机确认）、R12（`Spotlight.delete/deleteItems/deleteAll` 存在）、R14（`CloudSharedData` 整体方案被替换，风险作废）、R8（PRO 触感，`HapticFeedback.*` 已封装 `haptic()`）。

### 9.3 PRO 能力（本版按已购 PRO 设计，均写入正式需求）

| PRO 能力 | 用在哪 | 收益 | 无 PRO / 不可用时的退路 |
|---|---|---|---|
| `Haptics`（`Haptics.transient(intensity, sharpness)`、`HapticEngine`，transient/continuous·impact/notify/success） | **FR-401** 勾选与归档反馈、FR-404 拖入投放区 | Things 3 级「手感」的关键，v0.1 只能降级 | 纯动效 + toast，`settings.haptics` 关闭 |
| `ControlWidget.present`（控制中心按钮/开关，关联 AppIntent 传参，iOS 18+ 部分能力） | **FR-704** 控制中心一步捕获 | 对标安卓悬浮球，**改变产品手感上限** | Siri + AppIntent（FR-702）+ 小组件「＋」 |
| `Spotlight.index` / `Spotlight.current`（含 `parameters` 回传） | **FR-602** 系统搜索直达任务详情 | 顺带解决深链参数问题（原 R7） | 不做系统索引，仅应用内 `searchable` |
| ~~`CloudSharedData`~~（CloudKit 支撑，小组件/扩展可读写） | ~~**5.2 双写规则 + FR-701** 当日切片~~ | **v0.3 弃用**：`FileManager.appGroupDocumentsDirectory` + 同步 `Storage` 双通道已足够，且切片不出设备 —— 少一条 PRO 依赖、少一处隐私摩擦、少一类 iCloud 离线故障面 | — |
| `SnippetIntent`（`Intent.snippetIntent()` 返回 TSX，快捷指令内渲染，**iOS 26+**） | **FR-705** 快捷指令/自动化内嵌捕获卡 | 可嵌入自动化（如收到特定邮件即弹捕获卡） | 隐藏入口，走 FR-704 |
| `SQLite`（连接/事务/Schema 管理与自省） | **D5** 退路 | 任务量 > 5000 或需复杂查询时替换整库 JSON | 维持单 JSON |
| `LanguageModelSession`（端侧模型） | **D6** 可选增强 | 解析口语化中文时间（「下下个周三早上」） | 自研规则解析器，明确不覆盖的表达原样留在标题 |
| `AppIntent.requestConfirmation` / `continueInForeground` | FR-702/704 | 捕获时二次确认、必要时拉起前台 | 直接落库不确认 |
| `Remote Push`、`WebScraper`、`HttpServer`、`MediaLibrary` | **不在本版范围** | 自用待办不需要，列此仅为避免重复评估 | — |

**实现约定**：即便已确认 PRO，代码里所有 PRO 调用仍写成能力探测 + 退路分支（`if (typeof Haptics !== "undefined") { ... } else { ... }`），避免换设备 / 订阅到期时整个脚本崩溃。

---

## 10. 里程碑

| 阶段 | 内容 | 完成定义（可交付判定） |
|---|---|---|
| **M0 骨架** | 数据层 + 收集箱 + 今日 + FR-101/201/301/401/501/502(P0) + 撤销 | 连续用 3 天不觉得别扭；关掉系统提醒事项也能活 |
| **M1 整理** | 项目/区域/标签/旗标/优先级 + FR-402（含滑动重映射）/403/601 + 详情全字段 | 100 条任务下能在 10 秒内定位并处理任意一条 |
| **M2 时间** | NL 完整语法 + 重复规则 + 本地通知（含四态按钮与 snooze）+ 系统同步与 reconcile（F4/F5）+ **重复必重排提醒** | 一条 19:00 的任务准点推送，系统里勾掉后本地对齐；连续 3 个周五的重复任务通知数 = 3 |
| **M3 外壳（PRO 全开）** | 小组件三尺寸 + 4 个 AppIntent + **控制中心控件（FR-704）** + **Spotlight 直达（FR-602）** + 归档/统计 + 导入导出；FR-705 SnippetIntent 视 iOS 版本而定 | 从任意 App 内到落库 = **1 步（控制中心）**；主屏下拉搜到任务点击可直达详情；JSON 能导出再导回 |

建议顺序背后的判断：**M0 先证明「快」，再证明「能整理」**。竞品失败模式多是先建结构后做手感。

---

## 11. 风险与未验证假设

| ID | 风险 | 影响 | 处置 |
|---|---|---|---|
| R1 | `Storage` 容量上限未知，整库 JSON 可能超限 | M0 阻塞 | M0 第 1 天实测 1000/5000 条读写；超限则改 `FileManager` 或 `SQLite`（✅ PRO） |
| ~~R2~~ | ~~小组件扩展读不到脚本 `Storage`~~ | ~~FR-701 核心~~ | **v0.3 关闭（换了方案）**：不走 `CloudSharedData`/iCloud，改用 `FileManager.appGroupDocumentsDirectory` 写本地切片文件 + `widget.slice.v1` 双通道（5.2 / 6.14）。残留待验证项转为 **R2′：小组件进程是否真的能看到同一 App Group 目录**（真机清单 V5.1）；不通则退回 `Widget.parameter` 传参或只显进度环 |
| R3 | 小组件刷新受系统预算限制，勾选后状态可能延迟数分钟 | 手感 | 主脚本每次写切片后主动 `reloadAll`；接受延迟并在小组件脚注显示更新时间 |
| R4 | AppIntent 能否无 UI 静默完成勾选 | FR-701/702/704 | **v0.3 已按静默实现**（`app_intents.tsx` 六个 intent 均不 present UI，改完 `Widget.reloadAll()`）；不通则改为「点击进 App 后自动完成并返回」，捕获仍可用 intent |
| R5 | JS 冷启动 + 全量解析的启动时长 | NFR-2 | 去抖写盘 + 首屏只渲染今日（懒加载其余索引） |
| R6 | 系统提醒事项无子任务/自定义列表，字段映射有损 | FR-502(P1) | 明确「只同步主任务」，子任务以 notes 副本呈现；映射表见 5.4 |
| ~~R7~~ | ~~深链到任务详情的参数传递未确认~~ | ~~F1/F3~~ | **已关闭**：`Spotlight.index({ parameters })` + `Spotlight.current`（✅ PRO）提供系统级参数回传路径；`Script.queryParameters` 作为并行方案 |
| ~~R8~~ | ~~免费版无触感~~ | ~~FR-401~~ | **已关闭**：PRO 下 `Haptics.transient` 可用，成为正式需求；保留能力探测以防换设备 |
| R9 | 单人自用 → 无用户验证，需求可能自嗨 | 全局 | 以「连续 3 天真实使用」作为 M0 唯一验收方式 |
| R10 | `onDrag`/`onDrop` 能否跨容器投放（拖到顶部投放区），文档有修饰符但未验证交互范围 | FR-404 | 不通则退化为「长按快捷菜单里选今日/以后」，功能不减、手感降级 |
| R11 | 通知动作按钮能否回调进脚本并写库 | FR-502 四态按钮 | **v0.3 代码已按文档写完**（`Script.createRunURLScheme` + `Script.queryParameters.act` 四态分流，走 `core.perform(undoable:false)`），只剩真机确认是否需前台；不通则按钮只做「打开并定位该任务」 |
| ~~R12~~ | ~~Spotlight 反索引/移除条目 API 名与索引配额未确认~~ | ~~FR-602~~ | **v0.3 关闭**：文档给出 `Spotlight.delete / deleteItems / deleteAll / getItems / indexItems`；`Spotlight.current` 仅在 `spotlight.tsx` 有值 → 改为跳板二次 `Script.run`。仅剩索引配额未确认，代码上限 500、只索引未完成项 |
| R13 | 单个脚本可注册的控制中心控件数量与刷新限制未确认 | FR-704 | 先只做 1 个「完成下一条 / 撤销（按 `ControlWidget.parameter` 切换）」，验证后再扩 |
| ~~R14~~ | ~~`CloudSharedData` 写入频率上限、iCloud 未登录/离线时的行为未确认~~ | ~~FR-701 数据链路~~ | **v0.3 作废**：切片不再经云端（App Group 本地文件 + `Storage` 兜底），且写入是同步 API，无去抖需求；小组件脚注仍显示「更新于」以暴露陈旧 |

---

## 12. 待你确认的决策点

| # | 问题 | 我的默认 |
|---|---|---|
| **D1** | 导航用顶部分段+滑动翻页，还是底部 `TabView`？ | 顶部分段 |
| **D2** | 「今日」每日重置时刻（0 点 vs 凌晨 4 点）要不要可配？ | 默认 04:00，可配 |
| **D3** | 要不要日历/月历视图？ | 不做，用「未来 7 天分组」替代 |
| **D4** | 区间任务（今天开始、周五结束）是否需要？ | v1 保留 `endDate` 字段但 UI 不做入口 |
| **D5** | 整库单 JSON vs 拆多 key vs SQLite(PRO)？ | 整库单 JSON；超限时优先 `FileManager` 写文件，只有需要复杂查询才上 `SQLite` |
| **D6** | 自然语言解析：自研规则 vs `LanguageModelSession`(PRO 端侧模型)？ | 自研规则为主路径（零延迟、可控、离线），端侧模型仅作为「规则解析失败时」的可选兜底，默认关 |
| **D7** | 子任务全完成后父任务自动勾掉吗？ | 不自动，只显示 `2/3` |
| **D8** | 实时活动（今日冲刺计时）值得做吗？ | 列为 P2，倾向砍掉 |
| **D9** | PRO 依赖深度：触感、控制中心捕获、小组件切片、Spotlight 直达都绑在 PRO 上，可接受吗？ | 可接受（你已订阅），但每条仍写能力探测退路 |
| **D10** | 要不要四象限视图？安卓滴答的「拖拽即改判」机制确实更顺手，但矩阵视图会引入两套心智。 | 不做视图，只做 FR-404 的拖拽投放（P2，可整条砍） |
| **D11** | 每日重置要不要**默认开启**？Microsoft To Do 因不可关闭被骂，但每天手动挑也有成本。 | 默认 `reset`（清零），提供 `keep` 开关；若你预判自己嫌麻烦，直接改成默认 `keep` |
| **D12** | 通知动作按钮（完成/15 分/1 小时/明天）要不要做进 P0？它依赖 R4 静默执行的验证结果。 | 排在 M2，验证不通过则退化为「点开即完成」 |
| **D13** | 控制中心放几个控件、哪几个？（iOS 上唯一的一步捕获入口） | 先只放 `捕获任务` 1 个跑通 R13，再决定加不加「打开今日」「完成下一条」 |
| **D14** | ~~隐私边界：当日切片要不要经 iCloud/CloudKit~~ | **v0.3 自动解决**：切片改走 **App Group 本地文件**（+ 同脚本 Storage 兜底），任务标题**不出设备**，本决策取消。若你后来想要「iPad/Watch 也能看小组件」，再评估是否重新引入 `CloudSharedData` |
| **D15** 🆕 | 只有日期、没有时刻的任务要不要推通知？几点推？（v0.2 未定义，实现时必须有答案） | **默认推**，当天 `allDayNotifyHour = 09:00` 整点一条；设置里 `allDayNotifyEnabled` 可整体关掉、小时可配。理由：借的是系统通知通道，宁可早上一次性摊开，也别在 19:00 突然冒出来 |
| **D16** 🆕 | snooze（稍后提醒）之后，任务在今日列表里**藏不藏**？ | **不藏** —— 只推迟提醒，行内标「稍后」（v0.3 已按此实现并写了单测）。竞品「稍后 = 消失」是抱怨集中点；真要改回藏起来，改 `logic.isLive()` 一处即可，但要同步改 3 条单测 |
| **D17** 🆕 | 撤销栈要不要持久化？后台入口（AppIntent / 通知按钮 / 每日重置）算不算一步？ | **持久化 40 条**落 `undo.v1`（脚本随时被系统杀掉）；后台入口 `undoable:false` **不入栈**，避免抢走用户的撤销目标 |

---

## 13. 附录

### 13.1 状态与空态

| 位置 | 空态 | 文案 |
|---|---|---|
| 今日 | 无任务 | 「今天还没有承诺」+ 按钮「从收集箱挑选」 |
| 今日 | 全部完成 | 进度环 100% + 「今日 7/7，剩下的明天再说」 |
| 收集箱 | 空 | 「清空了。这是要表扬的事。」 |
| 归档 | 空 | 「还没有完成记录」 |
| 通知被拒 | 详情页 | 「系统未授权提醒，改用应用内通知」+ 跳转设置 |
| reconcile 冲突 | 一次性横幅 | 「3 条在系统里被改过，点这里重新同步」 |

### 13.2 边界规则

时区变更以 `dueDate` 的本地日期字符串为准不重算；逾期定义 = `dueDate < 今天` 且未完成；~~`snoozedUntil > now` 的任务在今日与计划中折叠为「稍后」~~ **v0.3 改为：snooze 只推迟提醒、不改变可见性**，任务照常出现在今日/计划，行内加「稍后 HH:mm」标记（见 D16）；重复任务完成后立即生成下一次实例（**新 id、清空 `reminderIdentifier`/`alarmIds`、`reminderSync` 置 `pending`、重算 `scheduledAt`、子任务全部重置为未勾**，单测覆盖「连续 3 个周五」链路）；子任务上限 20，超出提示「转为项目」；项目/区域各限 1 层，删除项目时任务回收集装箱（不级联删除）；所有删除默认软删（回收站 30 天后 `purgeTrash` 清）。

**归档语义（v0.3）**：完成 ≠ 立即从库里消失，`done=true` 仍留在 `db.v1`，「回收站」视图 = 软删项（`trashedAt`），归档/Logbook（FR-801）统计从 `completedAt` 分组。M2 未做统计图表，只做了回收站与恢复。

### 13.3 命名

`index.tsx`（主 UI + 启动流程）、`widget.tsx`（小组件）、`app_intents.tsx`（6 个 AppIntent 注册，小组件按钮与控制中心共用）、`control_widget_button.tsx`（控制中心按钮，按 `ControlWidget.parameter` 切换撤销/完成下一条）、`spotlight.tsx`（Spotlight 落点跳板）、`notification.tsx`（自定义通知 UI，**本版未做**，用系统默认样式 + 动作按钮）、`types.ts`（模型 + 日期/重复纯函数）、`parse.ts`（NL 解析 + chips 预览）、`logic.ts`（**纯归约**：Action → DB + Effect[]，无 scripting 依赖）、`store.ts`（KV 抽象 + 撤销栈 + 规范化，无 scripting 依赖）、`reminders.ts`（系统提醒事项桥）、`runtime.ts`（Scripting 胶水层：Storage / App Group 切片 / 通知 / 触感 / 权限 / Spotlight）、`core.ts`（唯一写路径 `perform/undoLast/snapshot`）、`dev/scripting.d.ts` + `dev/jsx.d.ts`（桌面 `tsc` 自检用的类型垫片，**不参与真机运行**）、`tests/*.test.ts` + `tsconfig.test.json`（Node 单测 213 条）。

**v0.3 分层约定（原 `views/*.tsx` 拆分方案作废）**：`types / parse / logic / store` 四个模块**不得 import "scripting"**，因此能在 Node 里真跑单测；`runtime / reminders / core` 触碰真机 API，只能在 Xcode 侧验证；UI 入口文件保持薄（只有视图与事件绑定），所有写操作一律 `core.perform()`。这条边界是整个工程可测试的前提。

### 13.4 来源

**Scripting 官方文档**（技术结论均出自此处）：[Quick Start](https://scriptingapp.github.io/guide/Quick%20Start) · [Storage](https://scriptingapp.github.io/guide/Utilities/Storage) · [Widget Quick Start](https://scriptingapp.github.io/guide/Widget/Widget%20Quick%20Start) · [Widget API](https://scriptingapp.github.io/guide/Widget/Widget%20API) · [Interactive Widget and LiveActivity](https://scriptingapp.github.io/guide/Interactive%20Widget%20and%20LiveActivity) · [AppIntent](https://scriptingapp.github.io/guide/AppIntent) · [Reminder](https://scriptingapp.github.io/guide/Device%20Capabilities/Reminder) · [EventAlarm](https://scriptingapp.github.io/guide/Device%20Capabilities/EventAlarm) · [Notification](https://scriptingapp.github.io/guide/Device%20Capabilities/Notification/) · [Editable List](https://scriptingapp.github.io/guide/Views/List/Editable%20List/) · [Selectable List](https://scriptingapp.github.io/guide/Views/List/Selectable%20List) · [Swipe Actions](https://scriptingapp.github.io/guide/View%20Modifiers/Swipe%20Actions/) · [Search](https://scriptingapp.github.io/guide/Views/Search/) · [Toolbars](https://scriptingapp.github.io/guide/Views/Toolbars/) · [Toast](https://scriptingapp.github.io/guide/View%20Modifiers/Toast) · [Modal presentations](https://scriptingapp.github.io/guide/Views/Modal%20presentaions/) · [LiveActivity](https://scriptingapp.github.io/guide/LiveActivity) · [Per-Script Permissions](https://scriptingapp.github.io/guide/Script/Per-Script%20Permissions) · [Script](https://scriptingapp.github.io/guide/Script/Script)

**iOS 竞品**：[Apple 智能列表](https://support.apple.com/guide/iphone/use-smart-lists-iphe882772ed/ios) · [Apple 提醒事项字段](https://support.apple.com/en-us/102484) · [Things 3 默认视图](https://culturedcode.com/things/support/articles/4001304/) / [排程语义](https://culturedcode.com/things/support/articles/2803579/) / [完成动效拆解](https://60fps.design/apps/things-3) · [Todoist Quick Add](https://www.todoist.com/help/todoist/features/use-task-quick-add-in-todoist-va4Lhpzz) / [定价与配额](https://www.todoist.com/pricing) · [Microsoft To Do 概览](https://support.microsoft.com/en-us/todo/welcome-to-microsoft-to-do) · [滴答任务字段](https://help.dida365.com/articles/6950661731483910144) / [小组件](https://help.ticktick.com/articles/7055780404896202752) · [Due](https://www.dueapp.com/)

**Android 竞品**：[滴答悬浮球](https://help.dida365.com/tips/6427414725247631360/) / [通知与 snooze](https://help.ticktick.com/articles/7055782395743567872) / [Constant Reminder](https://help.ticktick.com/articles/7374017550633402368) / [四象限规则](https://help.dida365.com/articles/6950381682822217728) · [Todoist 底部导航](https://www.todoist.com/help/todoist/features/customize-the-todoist-navigation-bar-L4qpkI0xj) / [滑动动作自定义](https://www.todoist.com/help/todoist/features/how-to-change-your-swipe-actions-D5DQOQz6) / [免费配额收紧讨论](https://www.reddit.com/r/todoist/comments/1otieep/todoist_pricing_update_addressing_your_questions/) · [My Day 与建议](https://support.microsoft.com/en-us/todo/my-day-and-suggestions) / [逾期不进 My Day 的抱怨](https://superuser.com/questions/1829671/why-doesnt-the-my-day-view-show-overdue-tasks-in-microsoft-to-do) · [Tasks.org 离线与同步可选](https://tasks.org/) · [Simpletask Cloudless（todo.txt 本地存储）](https://f-droid.org/forums/topic/simpletask-cloudless/) · [滴答安卓通知延迟反馈](https://nothing.community/d/24469-notification-delay-in-ticktick-app)

**PRO 能力文档**（v0.2 新增依据）：[CloudSharedData](https://scriptingapp.github.io/guide/Changelog/3.2.0/CloudSharedData) · [Control Widget](https://scriptingapp.github.io/guide/Control%20Widget) · [Spotlight](https://scriptingapp.github.io/guide/Changelog/3.1.0/Spotlight) · [Haptics](https://scriptingapp.github.io/guide/Changelog/3.1.0/Haptics/) · [SnippetIntent](https://scriptingapp.github.io/guide/Intent/SnippetIntent) · [SQLite](https://scriptingapp.github.io/guide/Utilities/SQLite/Overview) · [LanguageModelSession](https://scriptingapp.github.io/guide/Changelog/2.4.8/LanguageModelSession) · [AppIntent 进阶（requestConfirmation / continueInForeground）](https://scriptingapp.github.io/guide/Intent/Quick%20Start)

---

*本文档由 Qoder 生成于 2026-10-20。技术可行性结论逐条核对自 Scripting 官方文档；标 ⚠️ 的项目文档未覆盖，需在 M0 首日实测。*
