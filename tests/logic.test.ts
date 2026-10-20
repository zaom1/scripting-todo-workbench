// 核心逻辑单测：覆盖 PRD 的验收硬点（重复任务重排、今日清零、不可变归约、回收站保留期）。
import {
  Action, Ctx, bucketOf, counts, inTodayList, isSnoozed, reduce, taskFromDraft, todayView, trashOf, widgetSlice, plannedGroups,
} from "../logic";
import { DEFAULT_SETTINGS, DB, Task, emptyDB } from "../types";

let pass = 0;
const fails: string[] = [];
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name}\n     期望 ${e}\n     实际 ${a}`);
}
function ok(name: string, cond: boolean) { eq(name, !!cond, true); }

const TODAY = "2026-10-20";           // 周二
const NOW = new Date(2026, 9, 20, 9, 0).getTime();
let seq = 0;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ today: TODAY, now: NOW, newId: () => `id${++seq}`, settings: { ...DEFAULT_SETTINGS }, ...over });

const T = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, tags: [], subtasks: [], done: false, flagged: false, order: 0, createdAt: NOW, ...over,
} as Task);

const run = (db: DB, a: Action, c: Ctx = ctx()) => reduce(db, a, c);
const R = (db: DB, a: Action, c: Ctx = ctx()) => run(db, a, c).db;
const ids = (db: DB) => db.tasks.map((t) => t.id).sort();

// —— 不可变归约（撤销栈依赖）——
{
  const db = emptyDB(); db.tasks.push(T("a"));
  const before = JSON.stringify(db);
  const out = R(db, { type: "toggleFlag", id: "a" });
  eq("归约不改原 DB", JSON.stringify(db), before);
  eq("归约返回新对象", out.tasks[0].flagged, true);
  ok("归约非同一引用", out !== db);
}

// —— add + taskFromDraft ——
{
  const c = ctx();
  const db = emptyDB();
  const t = taskFromDraft({ title: "给妈妈打电话", dueDate: "2026-10-23", dueTime: "19:00", tags: ["重要"], priority: 1, subtasks: ["充电", "查路线"] }, db, c, undefined);
  const d2 = R(db, { type: "add", task: t }, c);
  eq("add 落库", d2.tasks.length, 1);
  eq("草稿算出提醒时刻", d2.tasks[0].scheduledAt, new Date(2026, 9, 23, 19, 0).getTime());
  eq("草稿子任务", d2.tasks[0].subtasks.map((s) => s.title), ["充电", "查路线"]);
  const eff = run(db, { type: "add", task: t }, c).effects;
  ok("add 排通知", eff.some((e) => e.kind === "alarm.schedule"));
  ok("add 进 Spotlight", eff.some((e) => e.kind === "spotlight.index"));
}

// —— 提前 N 分钟 ——
{
  const c = ctx();
  const t = taskFromDraft({ title: "面谈", dueDate: TODAY, dueTime: "15:00", remindOffsetMin: 30 }, emptyDB(), c);
  eq("提前 30 分钟", t.scheduledAt, new Date(2026, 9, 20, 14, 30).getTime());
}

// —— FR-502 重复任务完成后重排，并跟着重排通知/提醒事项 ——
{
  const c = ctx();
  let db = emptyDB();
  db.tasks.push(T("w", { dueDate: "2026-10-21", segment: "date", repeat: { freq: "weekly", weekdays: [3], mode: "fromDue" }, reminderSync: "up", reminderIdentifier: "sys-1", alarmIds: ["al-1"], scheduledAt: new Date(2026, 9, 21, 9, 0).getTime(), tags: ["周会"] }));
  const res = run(db, { type: "complete", id: "w" }, c);
  const doneOld = res.db.tasks.find((t) => t.id === "w")!;
  const fresh = res.db.tasks.find((t) => t.id !== "w")!;
  eq("完成标记", doneOld.done, true);
  ok("生成下一实例", !!fresh);
  eq("新实例到期日=下周三", fresh.dueDate, "2026-10-28");
  eq("新实例未完成", fresh.done, false);
  eq("新实例继承标签", fresh.tags, ["周会"]);
  eq("新实例不共享系统提醒 id", fresh.reminderIdentifier, undefined);
  eq("新实例待推送", fresh.reminderSync, "pending");
  ok("取消旧通知", res.effects.some((e) => e.kind === "alarm.cancel" && e.taskIds.includes("w")));
  ok("删除旧系统提醒", res.effects.some((e) => e.kind === "reminder.remove" && e.identifier === "sys-1"));
  ok("为新实例排通知", res.effects.some((e) => e.kind === "alarm.schedule" && e.taskId === fresh.id));
  ok("为新实例推提醒", res.effects.some((e) => e.kind === "reminder.push" && e.taskId === fresh.id));
  eq("实例数=2", res.db.tasks.length, 2);

  // 连做三次，通知排期必须落在三个不同周三（竞品坑 A8 的验收）
  let cur = res.db, curId = fresh.id;
  const allDays = [fresh.dueDate!];
  for (let i = 0; i < 2; i++) {
    const before = new Set(cur.tasks.map((t) => t.id));
    const due = cur.tasks.find((t) => t.id === curId)!.dueDate!;
    const r2 = run(cur, { type: "complete", id: curId }, ctx({ today: due }));
    const nid = r2.db.tasks.find((t) => !before.has(t.id))!.id;
    allDays.push(r2.db.tasks.find((t) => t.id === nid)!.dueDate!);
    ok(`第 ${i + 2} 次完成重排通知`, r2.effects.some((e) => e.kind === "alarm.schedule" && e.taskId === nid));
    cur = r2.db; curId = nid;
  }
  eq("三连日期互不相同", new Set(allDays).size, 3);
  eq("三连日期依次 7 天", allDays, ["2026-10-28", "2026-11-04", "2026-11-11"]);
}

// —— 完成「每天」任务：今日锚点保留 ——
{
  const c = ctx();
  let db = emptyDB();
  db.tasks.push(T("d", { dueDate: TODAY, segment: "today", inTodayOn: TODAY, repeat: { freq: "daily", mode: "fromDue" } }));
  const d2 = R(db, { type: "complete", id: "d" }, c);
  const fresh = d2.tasks.find((t) => !t.done)!;
  eq("每天任务次日到期", fresh.dueDate, "2026-10-21");
  eq("每天任务仍在今日", fresh.inTodayOn, TODAY);
  eq("每天任务分段不再 today", fresh.segment, "date");
}

// —— fromCompletion 模式：从完成日算 ——
{
  const c = ctx({ today: "2026-10-20" });
  let db = emptyDB();
  db.tasks.push(T("f", { dueDate: "2026-10-01", repeat: { freq: "interval", interval: 7, mode: "fromCompletion" } }));
  const d2 = R(db, { type: "complete", id: "f" }, c);
  eq("fromCompletion 以今天起算", d2.tasks.find((t) => !t.done)!.dueDate, "2026-10-27");
}

// —— 今日视图分节 ——
{
  const c = ctx();
  const db = emptyDB();
  db.tasks.push(T("od", { dueDate: "2026-10-18" }));
  db.tasks.push(T("td", { dueDate: TODAY }));
  db.tasks.push(T("pick", { inTodayOn: TODAY }));
  db.tasks.push(T("fl", { inTodayOn: TODAY, flagged: true }));
  db.tasks.push(T("eve", { segment: "evening", dueDate: TODAY }));
  db.tasks.push(T("done", { dueDate: TODAY, done: true }));
  db.tasks.push(T("trash", { dueDate: TODAY, trashedAt: NOW }));
  db.tasks.push(T("snooze", { dueDate: TODAY, snoozedUntil: NOW + 3600_000 }));
  const v = todayView(db, c);
  eq("旗标置顶", v.pinned.map((t) => t.id), ["fl"]);
  eq("逾期分节", v.overdue.map((t) => t.id), ["od"]);
  eq("今日/拾取分节不含置顶", v.scheduled.map((t) => t.id).sort(), ["pick", "snooze", "td"]);
  eq("晚上分节", v.evening.map((t) => t.id), ["eve"]);
  ok("已完成不在今日", !v.pinned.concat(v.overdue, v.scheduled, v.evening).some((t) => t.done));
  ok("回收站不在今日", !v.pinned.concat(v.overdue, v.scheduled, v.evening).some((t) => t.id === "trash"));
}

// —— 每日重置（D11：逾期不清，keep 模式全不清）——
{
  const c = ctx({ today: "2026-10-21" });
  let db = emptyDB();
  db.tasks.push(T("y", { inTodayOn: TODAY }));
  db.tasks.push(T("od", { inTodayOn: TODAY, dueDate: TODAY }));
  db.tasks.push(T("today", { inTodayOn: "2026-10-21" }));
  const reset = R(db, { type: "rollover" }, c);
  eq("清零昨日锚点", reset.tasks.find((t) => t.id === "y")!.inTodayOn, undefined);
  eq("逾期锚点保留", reset.tasks.find((t) => t.id === "od")!.inTodayOn, TODAY);
  eq("今日锚点保留", reset.tasks.find((t) => t.id === "today")!.inTodayOn, "2026-10-21");
  const keep = R(db, { type: "rollover" }, ctx({ today: "2026-10-21", settings: { ...DEFAULT_SETTINGS, todayResetMode: "keep" } }));
  eq("keep 模式不清零", keep.tasks.find((t) => t.id === "y")!.inTodayOn, TODAY);
}

// —— 移出今日 / 改期到明天 ——
{
  let db = emptyDB();
  db.tasks.push(T("p", { inTodayOn: TODAY, segment: "today", pickedFrom: "inbox" }));
  const u = R(db, { type: "unpick", id: "p" });
  eq("移出今日清锚点", u.tasks[0].inTodayOn, undefined);
  eq("移出今日转某天", u.tasks[0].segment, "someday");
  db = emptyDB(); db.tasks.push(T("m", { inTodayOn: TODAY, dueDate: TODAY }));
  const tm = R(db, { type: "moveTomorrow", id: "m" });
  eq("改期到明天", tm.tasks[0].dueDate, "2026-10-21");
  eq("改期后离开今日", tm.tasks[0].inTodayOn, undefined);
}

// —— setDue 逾期自动进今日 ——
{
  let db = emptyDB(); db.tasks.push(T("s", { title: "x" }));
  const d2 = R(db, { type: "setDue", id: "s", dueDate: "2026-10-19", dueTime: "09:00" });
  eq("回溯日期进今日", d2.tasks[0].inTodayOn, TODAY);
  eq("回溯日期分段", d2.tasks[0].segment, "today");
  eq("回溯后重算提醒", d2.tasks[0].scheduledAt, new Date(2026, 9, 19, 9, 0).getTime());
}

// —— 子任务 ——
{
  let db = emptyDB(); db.tasks.push(T("t1", { subtasks: [{ id: "s1", title: "a", done: false, order: 0 }] }));
  db = R(db, { type: "toggleSubtask", id: "t1", subId: "s1" });
  eq("勾选子任务", db.tasks[0].subtasks[0].done, true);
  db = R(db, { type: "addSubtask", id: "t1", title: "b" });
  eq("追加子任务", db.tasks[0].subtasks.map((s) => s.title), ["a", "b"]);
  db = R(db, { type: "removeSubtask", id: "t1", subId: "s1" });
  eq("删除子任务并重排", db.tasks[0].subtasks.map((s) => [s.title, s.order]), [["b", 0]]);
}

// —— bulk ——
{
  let db = emptyDB();
  db.tasks.push(T("b1"), T("b2"), T("b3", { done: true }));
  const d2 = R(db, { type: "bulk", ids: ["b1", "b2", "b3"], action: { type: "toggleFlag", id: "" } });
  eq("批量旗标 1", d2.tasks[0].flagged, true);
  eq("批量旗标 2", d2.tasks[1].flagged, true);
  eq("批量旗标 3", d2.tasks[2].flagged, true);
}

// —— 回收站：软删除 → 30 天后真删 ——
{
  const settings = { ...DEFAULT_SETTINGS, archiveKeepDays: 30 };
  let db = emptyDB();
  db.tasks.push(T("g", { reminderIdentifier: "sys-g", alarmIds: ["al-g"], reminderSync: "up" }));
  const res = run(db, { type: "trash", id: "g" }, ctx({ settings }));
  db = res.db;
  eq("软删除打标记", !!db.tasks[0].trashedAt, true);
  eq("软删除仍在库", db.tasks.length, 1);
  ok("删除时清系统提醒", res.effects.some((e) => e.kind === "reminder.remove" && e.identifier === "sys-g"));
  ok("删除时清通知", res.effects.some((e) => e.kind === "alarm.cancel"));
  eq("回收站可见", trashOf(db).map((t) => t.id), ["g"]);
  ok("回收站不在今日", !inTodayList(db.tasks[0], ctx({ settings })));

  const restored = R(db, { type: "restore", id: "g" }, ctx({ settings }));
  eq("恢复清标记", restored.tasks[0].trashedAt, undefined);

  const old = JSON.parse(JSON.stringify(db)) as DB;
  old.tasks[0].trashedAt = NOW - 31 * 86_400_000;
  const purged = R(old, { type: "purgeTrash" }, ctx({ settings }));
  eq("超期真删", purged.tasks.length, 0);
  const fresh = JSON.parse(JSON.stringify(db)) as DB;
  fresh.tasks[0].trashedAt = NOW - 29 * 86_400_000;
  eq("未满 30 天不删", R(fresh, { type: "purgeTrash" }, ctx({ settings })).tasks.length, 1);
}

// —— 项目：ensureProject 幂等 ——
{
  let db = emptyDB();
  db = R(db, { type: "ensureProject", name: "家庭" });
  const n1 = db.projects.length;
  db = R(db, { type: "ensureProject", name: "家庭" });
  eq("同名项目不重复建", db.projects.length, n1);
  const pid = db.projects[0].id;
  db = R(db, { type: "add", task: T("pj", { title: "x" }) });
  db = R(db, { type: "setProject", id: "pj", projectId: pid });
  eq("任务归入项目", db.tasks.find((t) => t.id === "pj")!.projectId, pid);
  eq("计数含项目", counts(db, ctx())[`project:${pid}`], 1);
}

// —— 计划视图分组 ——
{
  const c = ctx();
  const db = emptyDB();
  db.tasks.push(T("o", { dueDate: "2026-10-18" }));
  db.tasks.push(T("tm", { dueDate: "2026-10-21" }));
  db.tasks.push(T("wk", { dueDate: "2026-10-25" }));
  db.tasks.push(T("lt", { dueDate: "2026-12-01" }));
  db.tasks.push(T("none", {}));
  eq("bucket 逾期", bucketOf(db.tasks[0], c), "overdue");
  eq("bucket 明天", bucketOf(db.tasks[1], c), "tomorrow");
  eq("bucket 本周(周日结束)", bucketOf(db.tasks[2], c), "week");
  eq("bucket 以后", bucketOf(db.tasks[3], c), "later");
  const gs = plannedGroups(db, c).map((g) => g.bucket);
  eq("分组不含无日期", gs.includes("someday"), false);
  ok("分组含逾期", gs.includes("overdue"));
}

// —— 小组件切片 ——
{
  const c = ctx();
  const db = emptyDB();
  db.tasks.push(T("k1", { inTodayOn: TODAY, title: "第一个" }));
  db.tasks.push(T("k2", { dueDate: TODAY, title: "第二个" }));
  db.tasks.push(T("k3", { dueDate: TODAY, done: true, completedAt: NOW }));
  const slice = widgetSlice(db, c, 2);
  eq("切片限量", slice.items.length, 2);
  eq("切片总数", slice.total, 2);
  eq("切片今日完成数", slice.done, 1);
  ok("切片有日期", typeof slice.day === "string" && slice.day === TODAY);
}

// —— snooze：只压提醒不压可见性 ——
{
  const c = ctx();
  let db = emptyDB();
  db.tasks.push(T("sn", { dueDate: TODAY, dueTime: "09:00", alarmIds: ["al-sn"] }));
  const res = run(db, { type: "snooze", id: "sn", minutes: 30 }, c);
  eq("snooze 到期时刻", res.db.tasks[0].snoozedUntil, NOW + 30 * 60_000);
  ok("snooze 取消已排通知", res.effects.some((e) => e.kind === "alarm.cancel" && e.taskIds.includes("sn")));
  ok("snooze 后仍在今日可见", todayView(res.db, c).scheduled.some((t) => t.id === "sn"));
  eq("30 分钟内算被压住", isSnoozed(res.db.tasks[0], NOW + 1000), true);
  eq("到期后不再压住", isSnoozed(res.db.tasks[0], NOW + 31 * 60_000), false);
}

console.log(`\nlogic: ${pass} 通过 / ${pass + fails.length} 断言`);
if (fails.length) {
  console.log("失败：\n - " + fails.join("\n - ") + "\n");
  process.exit(1);
}
