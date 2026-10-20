// 核心业务逻辑（PRD 第 5、6、7 章）。纯函数：不 import "scripting"，可在 Node 里跑单测。
// reduce() 返回新 DB + 副作用清单，副作用由 store.ts 派发给通知/提醒事项/小组件。
import {
  Priority, RepeatRule, Segment, Task, DB, Settings, addDays, isOverdue, nextOccurrence, parseYmd, isoWeekday, ymd,
} from "./types";

export type Effect =
  | { kind: "alarm.cancel"; taskIds: string[] }
  | { kind: "alarm.schedule"; taskId: string }
  | { kind: "reminder.push"; taskId: string }
  | { kind: "reminder.remove"; identifier: string }
  | { kind: "widget.refresh" }
  | { kind: "spotlight.index"; taskId: string }
  | { kind: "spotlight.remove"; taskId: string };

export type Action =
  | { type: "add"; task: Task }
  | { type: "update"; id: string; patch: Partial<Task> }
  | { type: "complete"; id: string }
  | { type: "reopen"; id: string }
  | { type: "pickToday"; id: string }
  | { type: "unpick"; id: string }
  | { type: "moveTomorrow"; id: string }
  | { type: "setSegment"; id: string; segment: Segment }
  | { type: "setDue"; id: string; dueDate?: string; dueTime?: string }
  | { type: "clearDue"; id: string }
  | { type: "setPriority"; id: string; priority?: Priority }
  | { type: "toggleFlag"; id: string }
  | { type: "setProject"; id: string; projectId?: string }
  | { type: "setRepeat"; id: string; repeat?: RepeatRule }
  | { type: "snooze"; id: string; minutes: number }
  | { type: "addSubtask"; id: string; title: string }
  | { type: "toggleSubtask"; id: string; subId: string }
  | { type: "removeSubtask"; id: string; subId: string }
  | { type: "reorder"; ids: string[] }
  | { type: "trash"; id: string }
  | { type: "restore"; id: string }
  | { type: "bulk"; ids: string[]; action: Action }
  | { type: "rollover" }
  | { type: "purgeTrash" }
  | { type: "upsertProject"; project: DB["projects"][number] }
  | { type: "ensureProject"; name: string };

export interface Ctx {
  today: string;
  now: number;
  newId: () => string;
  settings: Settings;
}

// —— 小工具 ——————————————————————————————————————————————

function clone(db: DB): DB {
  return JSON.parse(JSON.stringify(db)) as DB;
}

function find(db: DB, id: string): Task | undefined {
  return db.tasks.find((t) => t.id === id);
}

/** 活任务：未完成且不在回收站 */
function isLive(t: Task, _now: number): boolean {
  return !t.done && !t.trashedAt;
}

/** snooze 只压「提醒」不压「可见性」——与 iOS 系统提醒事项、Due 的语义一致 */
export function isSnoozed(t: Task, now: number): boolean {
  return !!t.snoozedUntil && t.snoozedUntil > now;
}

/** 重算提醒时刻：有时刻用时刻，只有日期则用整点默认（D15） */
function recomputeAlarm(t: Task, ctx: Ctx): void {
  if (!t.dueDate) { t.scheduledAt = undefined; return; }
  const d = parseYmd(t.dueDate);
  if (t.dueTime) {
    const [h, m] = t.dueTime.split(":").map((n) => parseInt(n, 10));
    d.setHours(h || 0, m || 0, 0, 0);
  } else if (ctx.settings.allDayNotifyEnabled) {
    d.setHours(ctx.settings.allDayNotifyHour || 9, 0, 0, 0);
  } else { t.scheduledAt = undefined; return; }
  t.scheduledAt = d.getTime();
}

/** 任务是否属于「今日」列表（含逾期与手动拾取） */
export function inTodayList(t: Task, ctx: Ctx): boolean {
  if (!isLive(t, ctx.now)) return false;
  if (t.inTodayOn === ctx.today) return true;
  if (t.segment === "today") return true;
  if (t.dueDate && t.dueDate <= ctx.today) return true;
  return false;
}

export type Bucket = "overdue" | "today" | "tomorrow" | "week" | "later" | "someday";

export function bucketOf(t: Task, ctx: Ctx): Bucket {
  if (!t.dueDate) return "someday";
  if (t.dueDate < ctx.today) return "overdue";
  if (t.dueDate === ctx.today) return "today";
  if (t.dueDate === addDays(ctx.today, 1)) return "tomorrow";
  const daysToWeekEnd = ((7 - isoWeekday(parseYmd(ctx.today))) % 7) + 1;
  if (t.dueDate <= addDays(ctx.today, daysToWeekEnd)) return "week";
  return "later";
}

export const BUCKET_LABEL: Record<Bucket, string> = {
  overdue: "已逾期", today: "今天", tomorrow: "明天", week: "本周", later: "以后", someday: "某天",
};

/** 列表排序：旗标 > 优先级 > 到期 > 手动 order */
export function compareTasks(a: Task, b: Task): number {
  const byOrder = (a.order ?? 0) - (b.order ?? 0);
  if (byOrder !== 0) return byOrder;
  return a.title.localeCompare(b.title, "zh-Hans-CN");
}

export function sortList(list: Task[]): Task[] {
  return [...list].sort((a, b) => {
    if (!!b.flagged !== !!a.flagged) return a.flagged ? -1 : 1;
    const pa = a.priority ?? 9, pb = b.priority ?? 9;
    if (pa !== pb) return pa - pb;
    const da = a.dueDate ?? "9999-99-99", dbb = b.dueDate ?? "9999-99-99";
    if (da !== dbb) return da < dbb ? -1 : 1;
    return compareTasks(a, b);
  });
}

export interface TodayView {
  pinned: Task[]; overdue: Task[]; scheduled: Task[]; evening: Task[];
}

/** 今日视图分节（PRD 6.4）：旗标置顶 / 逾期 / 计划 / 晚上 */
export function todayView(db: DB, ctx: Ctx): TodayView {
  const list = sortList(db.tasks.filter((t) => inTodayList(t, ctx) && t.segment !== "evening"));
  const pinned = list.filter((t) => t.flagged);
  const rest = list.filter((t) => !t.flagged);
  return {
    pinned,
    overdue: rest.filter((t) => isOverdue(t, ctx.today)),
    scheduled: rest.filter((t) => !isOverdue(t, ctx.today) && t.segment !== "evening"),
    evening: sortList(db.tasks.filter((t) => isLive(t, ctx.now) && t.segment === "evening" && (!t.dueDate || t.dueDate <= ctx.today))),
  };
}

export function plannedGroups(db: DB, ctx: Ctx): { bucket: Bucket; items: Task[] }[] {
  const live = db.tasks.filter((t) => isLive(t, ctx.now) && t.dueDate && t.segment !== "today");
  const order: Bucket[] = ["overdue", "today", "tomorrow", "week", "later"];
  return order
    .map((bucket) => ({ bucket, items: sortList(live.filter((t) => bucketOf(t, ctx) === bucket)) }))
    .filter((g) => g.items.length > 0);
}

export function inboxOf(db: DB, ctx: Ctx): Task[] {
  return sortList(db.tasks.filter((t) => isLive(t, ctx.now) && !t.projectId && !t.dueDate && !t.inTodayOn && t.segment !== "today"));
}

export function somedayOf(db: DB, ctx: Ctx): Task[] {
  return sortList(db.tasks.filter((t) => isLive(t, ctx.now) && t.segment === "someday"));
}

export function flaggedOf(db: DB, ctx: Ctx): Task[] {
  return sortList(db.tasks.filter((t) => isLive(t, ctx.now) && t.flagged));
}

export function trashOf(db: DB): Task[] {
  return db.tasks.filter((t) => !!t.trashedAt).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
}

export function counts(db: DB, ctx: Ctx): Record<string, number> {
  const out: Record<string, number> = {
    today: db.tasks.filter((t) => inTodayList(t, ctx)).length,
    inbox: inboxOf(db, ctx).length,
    planned: db.tasks.filter((t) => isLive(t, ctx.now) && t.dueDate).length,
    flagged: flaggedOf(db, ctx).length,
    overdue: db.tasks.filter((t) => isLive(t, ctx.now) && isOverdue(t, ctx.today)).length,
  };
  for (const p of db.projects) out[`project:${p.id}`] = db.tasks.filter((t) => isLive(t, ctx.now) && t.projectId === p.id).length;
  return out;
}

// —— reducer ——————————————————————————————————————————————

export function reduce(db: DB, action: Action, ctx: Ctx): { db: DB; effects: Effect[] } {
  const next = clone(db);
  const effects: Effect[] = [];

  const touch = () => { effects.push({ kind: "widget.refresh" }); };
  const dropReminders = (t: Task) => {
    if (t.reminderIdentifier) effects.push({ kind: "reminder.remove", identifier: t.reminderIdentifier });
    if (t.alarmIds?.length || t.scheduledAt) effects.push({ kind: "alarm.cancel", taskIds: [t.id] });
  };
  const pushReminder = (t: Task) => {
    if (t.reminderSync && t.reminderSync !== "off") {
      t.reminderSync = "pending";
      effects.push({ kind: "reminder.push", taskId: t.id });
    }
  };
  const rescheduleAlarms = (t: Task) => {
    if (t.alarmIds?.length || t.scheduledAt) effects.push({ kind: "alarm.cancel", taskIds: [t.id] });
    t.alarmIds = [];
    // FR-503 循环催办（1/5/10/15/30/60 递进）本版**未实现**：nagRepeat 只是设置项，
    // 这里不能拿它当「没有 scheduledAt 也照样排」的替代条件，否则会排出立即过期的通知。
    if (t.scheduledAt) effects.push({ kind: "alarm.schedule", taskId: t.id });
  };

  // 完成 + 重复 → 立刻生成下一实例（PRD FR-502：通知必须跟着重排）
  const spawnRepeatInstance = (t: Task): Task | undefined => {
    if (!t.repeat) return undefined;
    const nd = nextOccurrence(t.repeat, t, ctx.today);
    if (!nd) return undefined;
    const fresh: Task = {
      ...JSON.parse(JSON.stringify(t)),
      id: ctx.newId(),
      done: false, completedAt: undefined, trashedAt: undefined,
      createdAt: ctx.now, order: t.order,
      dueDate: nd, segment: t.segment === "today" ? "date" : t.segment,
      inTodayOn: t.inTodayOn === ctx.today ? ctx.today : t.inTodayOn,
      reminderIdentifier: undefined, reminderSignature: undefined,
      reminderSync: t.reminderSync === "off" ? "off" : t.reminderSync ? "pending" : undefined,
      alarmIds: [], snoozedUntil: undefined,
    };
    fresh.subtasks = (t.subtasks ?? []).map((s) => ({ ...s, id: ctx.newId(), done: false }));
    recomputeAlarm(fresh, ctx);
    next.tasks.push(fresh);
    effects.push({ kind: "spotlight.index", taskId: fresh.id });
    if (fresh.reminderSync === "pending") effects.push({ kind: "reminder.push", taskId: fresh.id });
    if (fresh.scheduledAt) effects.push({ kind: "alarm.schedule", taskId: fresh.id });
    return fresh;
  };

  const applyOne = (a: Action): void => {
    switch (a.type) {
      case "add": {
        const t = a.task;
        recomputeAlarm(t, ctx);
        next.tasks.push(JSON.parse(JSON.stringify(t)));
        if (t.scheduledAt) effects.push({ kind: "alarm.schedule", taskId: t.id });
        if (t.reminderSync && t.reminderSync !== "off") effects.push({ kind: "reminder.push", taskId: t.id });
        effects.push({ kind: "spotlight.index", taskId: t.id });
        touch();
        break;
      }
      case "update": {
        const t = find(next, a.id); if (!t) return;
        Object.assign(t, a.patch);
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        effects.push({ kind: "spotlight.index", taskId: t.id });
        touch();
        break;
      }
      case "complete": {
        const t = find(next, a.id); if (!t || t.done) return;
        t.done = true; t.completedAt = ctx.now; t.snoozedUntil = undefined;
        dropReminders(t);
        effects.push({ kind: "spotlight.remove", taskId: t.id });
        spawnRepeatInstance(t);
        touch();
        break;
      }
      case "reopen": {
        const t = find(next, a.id); if (!t) return;
        t.done = false; t.completedAt = undefined;
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        effects.push({ kind: "spotlight.index", taskId: t.id });
        touch();
        break;
      }
      case "pickToday": {
        const t = find(next, a.id); if (!t) return;
        if (!t.pickedFrom) t.pickedFrom = t.projectId ? "projects" : t.dueDate ? "planned" : "inbox";
        // Things 式拾取：只打 inTodayOn 锚点，不改 dueDate，避免计划视图重复出现
        t.inTodayOn = ctx.today;
        t.snoozedUntil = undefined;
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        touch();
        break;
      }
      case "unpick": {
        const t = find(next, a.id); if (!t) return;
        t.inTodayOn = undefined;
        if (t.segment === "today") t.segment = "someday";
        touch();
        break;
      }
      case "moveTomorrow": {
        const t = find(next, a.id); if (!t) return;
        t.dueDate = addDays(ctx.today, 1); t.segment = "date";
        if (t.inTodayOn === ctx.today) t.inTodayOn = undefined;
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        touch();
        break;
      }
      case "setSegment": {
        const t = find(next, a.id); if (!t) return;
        t.segment = a.segment;
        if (a.segment === "today") t.inTodayOn = ctx.today;
        else if (a.segment === "someday") { t.dueDate = undefined; t.inTodayOn = undefined; }
        else if (a.segment === "evening" && !t.dueDate) t.dueDate = ctx.today;
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        touch();
        break;
      }
      case "setDue": {
        const t = find(next, a.id); if (!t) return;
        t.dueDate = a.dueDate; t.dueTime = a.dueTime;
        if (t.dueDate) t.segment = t.dueDate <= ctx.today ? "today" : "date";
        else if (t.segment !== "someday" && t.segment !== "evening") t.segment = undefined;
        if (t.dueDate && t.dueDate < ctx.today && t.inTodayOn !== ctx.today) t.inTodayOn = ctx.today;
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        effects.push({ kind: "spotlight.index", taskId: t.id });
        touch();
        break;
      }
      case "clearDue": {
        const t = find(next, a.id); if (!t) return;
        t.dueDate = undefined; t.dueTime = undefined; t.inTodayOn = undefined; t.segment = undefined;
        dropReminders(t); t.reminderSync = "off"; t.scheduledAt = undefined;
        if (t.reminderIdentifier) { t.reminderIdentifier = undefined; }
        touch();
        break;
      }
      case "setPriority": {
        const t = find(next, a.id); if (!t) return;
        t.priority = a.priority; pushReminder(t);
        touch();
        break;
      }
      case "toggleFlag": {
        const t = find(next, a.id); if (!t) return;
        t.flagged = !t.flagged; pushReminder(t);
        touch();
        break;
      }
      case "setProject": {
        const t = find(next, a.id); if (!t) return;
        t.projectId = a.projectId;
        const p = a.projectId ? next.projects.find((x) => x.id === a.projectId) : undefined;
        t.areaId = p?.areaId;
        pushReminder(t); touch();
        break;
      }
      case "setRepeat": {
        const t = find(next, a.id); if (!t) return;
        t.repeat = a.repeat; pushReminder(t);
        touch();
        break;
      }
      case "snooze": {
        const t = find(next, a.id); if (!t) return;
        t.snoozedUntil = ctx.now + a.minutes * 60_000;
        // snooze 期间先取消已排通知，到期由 store 重新排期
        if (t.alarmIds?.length) effects.push({ kind: "alarm.cancel", taskIds: [t.id] });
        t.alarmIds = [];
        touch();
        break;
      }
      case "addSubtask": {
        const t = find(next, a.id); if (!t) return;
        t.subtasks.push({ id: ctx.newId(), title: a.title.trim(), done: false, order: t.subtasks.length });
        pushReminder(t); touch();
        break;
      }
      case "toggleSubtask": {
        const t = find(next, a.id); if (!t) return;
        const s = t.subtasks.find((x) => x.id === a.subId); if (!s) return;
        s.done = !s.done;
        pushReminder(t); touch();
        break;
      }
      case "removeSubtask": {
        const t = find(next, a.id); if (!t) return;
        t.subtasks = t.subtasks.filter((x) => x.id !== a.subId).map((s, i) => ({ ...s, order: i }));
        pushReminder(t); touch();
        break;
      }
      case "reorder": {
        a.ids.forEach((id, i) => { const t = find(next, id); if (t) t.order = i + 1; });
        touch();
        break;
      }
      case "trash": {
        const t = find(next, a.id); if (!t) return;
        t.trashedAt = ctx.now; t.done = false;
        dropReminders(t); t.reminderIdentifier = undefined; t.reminderSync = "off";
        effects.push({ kind: "spotlight.remove", taskId: t.id });
        touch();
        break;
      }
      case "restore": {
        const t = find(next, a.id); if (!t) return;
        t.trashedAt = undefined;
        if (t.dueDate) t.segment = t.dueDate <= ctx.today ? "today" : "date";
        recomputeAlarm(t, ctx); pushReminder(t); rescheduleAlarms(t);
        effects.push({ kind: "spotlight.index", taskId: t.id });
        touch();
        break;
      }
      case "bulk": {
        for (const id of a.ids) applyOne({ ...a.action, id } as Action);
        break;
      }
      case "rollover": {
        // 今日清零：只清「昨天被挑进来但已无日期」的锚点，逾期任务保留可见（PRD FR-101 / D11）
        if (ctx.settings.todayResetMode !== "reset") break;
        for (const t of next.tasks) {
          if (t.inTodayOn && t.inTodayOn !== ctx.today && !isOverdue(t, ctx.today)) t.inTodayOn = undefined;
        }
        touch();
        break;
      }
      case "purgeTrash": {
        const keepMs = ctx.settings.archiveKeepDays * 86_400_000;
        const doomed = next.tasks.filter((t) => t.trashedAt && ctx.now - t.trashedAt > keepMs);
        for (const t of doomed) {
          if (t.reminderIdentifier) effects.push({ kind: "reminder.remove", identifier: t.reminderIdentifier });
          if (t.alarmIds?.length) effects.push({ kind: "alarm.cancel", taskIds: [t.id] });
          effects.push({ kind: "spotlight.remove", taskId: t.id });
        }
        next.tasks = next.tasks.filter((t) => !(t.trashedAt && ctx.now - t.trashedAt > keepMs));
        touch();
        break;
      }
      case "upsertProject": {
        const i = next.projects.findIndex((p) => p.id === a.project.id);
        if (i >= 0) next.projects[i] = a.project; else next.projects.push(a.project);
        touch();
        break;
      }
      case "ensureProject": {
        const hit = next.projects.find((p) => p.name === a.name);
        if (hit) break;
        next.projects.push({ id: ctx.newId(), name: a.name, order: next.projects.length + 1 });
        touch();
        break;
      }
    }
  };

  applyOne(action);
  return { db: next, effects };
}

/** 从解析结果 + 上下文造一个新任务（PRD FR-201/FR-203） */
export function taskFromDraft(
  draft: { title: string; dueDate?: string; dueTime?: string; segment?: Segment; priority?: Priority; flagged?: boolean; repeat?: RepeatRule; tags?: string[]; subtasks?: string[]; remindOffsetMin?: number },
  db: DB, ctx: Ctx, projectId?: string,
): Task {
  const t: Task = {
    id: ctx.newId(),
    title: draft.title,
    projectId,
    areaId: db.projects.find((p) => p.id === projectId)?.areaId,
    tags: draft.tags ?? [],
    priority: draft.priority,
    flagged: !!draft.flagged,
    segment: draft.segment,
    dueDate: draft.dueDate,
    dueTime: draft.dueTime,
    repeat: draft.repeat,
    subtasks: (draft.subtasks ?? []).map((s, i) => ({ id: ctx.newId(), title: s, done: false, order: i })),
    inTodayOn: draft.segment === "today" ? ctx.today : undefined,
    createdAt: ctx.now,
    done: false,
    order: db.tasks.filter((x) => x.inTodayOn === ctx.today).length + 1,
    reminderSync: "off",
  };
  if (t.dueDate && t.dueTime) {
    recomputeAlarm(t, ctx);
    if (draft.remindOffsetMin && t.scheduledAt) t.scheduledAt = t.scheduledAt - draft.remindOffsetMin * 60_000;
  }
  if (!t.dueDate && t.segment !== "someday" && t.segment !== "evening") t.segment = undefined;
  return t;
}

/** 快照导出给小组件/备份用的精简切片（PRD 6.14、D14） */
export function widgetSlice(db: DB, ctx: Ctx, limit = 6) {
  const list = sortList(db.tasks.filter((t) => inTodayList(t, ctx))).slice(0, limit);
  return {
    day: ymd(parseYmd(ctx.today)),
    total: db.tasks.filter((t) => inTodayList(t, ctx)).length,
    done: db.tasks.filter((t) => t.done && t.completedAt && ctx.now - t.completedAt < 86_400_000).length,
    items: list.map((t) => ({ id: t.id, title: t.title, done: t.done, priority: t.priority, flagged: t.flagged })),
    generatedAt: ctx.now,
  };
}
