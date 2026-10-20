// 系统提醒事项桥（PRD 5.4 同步状态机、FR-301、F5 对齐）。
// 只有 reminderSync !== "off" 的任务写进 iOS 提醒事项，用来借系统通知与 Siri。
// 重复任务不在系统里建 RRULE：每个实例是新的本地任务 → 新推一条提醒，保证 FR-502「必重排」。
import { Calendar, DateComponents, EventAlarm, Reminder } from "scripting";
import { Task } from "./types";

/** 参与同步的字段指纹：变了就要重新 upsert */
export function signatureOf(t: Task): string {
  return [
    t.title,
    t.notes ?? "",
    t.dueDate ?? "",
    t.dueTime ?? "",
    t.priority ?? "",
    t.flagged ? "1" : "0",
    (t.subtasks ?? []).map((s) => `${s.done ? "x" : "o"}${s.title}`).join("|"),
    t.done ? "done" : "open",
  ].join("\u0001");
}

function dueComponents(t: Task): any | undefined {
  if (!t.dueDate) return undefined;
  const [y, m, d] = t.dueDate.split("-").map((n) => parseInt(n, 10));
  const o: Record<string, number> = { year: y, month: m, day: d };
  if (t.dueTime) {
    const [h, mi] = t.dueTime.split(":").map((n) => parseInt(n, 10));
    o.hour = h || 0; o.minute = mi || 0;
  }
  return new DateComponents(o);
}

/** 本地任务 → 系统提醒（新建或就地更新），回写 identifier/signature */
export async function upsertReminder(t: Task): Promise<{ ok: boolean; identifier?: string; error?: string }> {
  try {
    let rem: InstanceType<typeof Reminder> | null = null;
    if (t.reminderIdentifier) rem = await Reminder.get(t.reminderIdentifier);
    if (!rem) {
      rem = new Reminder();
      const cal = await Calendar.defaultForReminders();
      if (cal) rem.calendar = cal as any;
    }
    rem.title = t.title || "（无标题）";
    const notes = [
      t.notes ?? "",
      (t.subtasks ?? []).map((s) => `[${s.done ? "x" : " "}] ${s.title}`).join("\n"),
      `工作台 · ${t.tags.map((x) => "@" + x).join(" ")}`.trim(),
    ].filter((s) => s.length).join("\n");
    rem.notes = notes || null;
    rem.priority = t.priority ? (5 - t.priority) : 0;   // 提醒事项里数字越小越优先
    rem.dueDateComponents = dueComponents(t) ?? null;
    rem.isCompleted = !!t.done;

    // 重建警报：绝对时刻 = scheduledAt（含「提前 N 分钟」已折算在内）
    for (const a of (rem.alarms ?? [])) rem.removAlarm(a);
    if (t.scheduledAt && !t.done) rem.addAlarm(EventAlarm.fromAbsoluteDate(new Date(t.scheduledAt)));

    await rem.save();
    t.reminderIdentifier = rem.identifier;
    t.reminderSignature = signatureOf(t);
    t.reminderSync = "up";
    return { ok: true, identifier: rem.identifier };
  } catch (e) {
    t.reminderSync = "pending";
    return { ok: false, error: String(e) };
  }
}

export async function deleteReminder(identifier: string): Promise<boolean> {
  try {
    const rem = await Reminder.get(identifier);
    if (rem) await rem.remove();
    return true;
  } catch { return false; }
}

export interface ReconcileResult {
  /** 系统里勾掉了 → 本地也跟着完成 */
  completedLocally: string[];
  /** 本地勾掉了 → 回写系统 */
  completedInSystem: string[];
  /** 系统里已被手删/找不到 → 本地降级为不同步 */
  detached: string[];
  /** 字段有变或上次没推成功 → 需要重新推送 */
  needPush: string[];
  scanned: number;
}

/**
 * 打开脚本时对齐（PRD F5）。
 * 冲突策略：以「更新时间」不确定的场景一律让系统赢（用户在 Siri/小组件里改的概率更高）。
 */
export async function reconcile(tasks: Task[]): Promise<ReconcileResult> {
  const res: ReconcileResult = { completedLocally: [], completedInSystem: [], detached: [], needPush: [], scanned: 0 };
  const synced = tasks.filter((t) => t.reminderSync && t.reminderSync !== "off" && !t.trashedAt);
  if (!synced.length) return res;

  let all: InstanceType<typeof Reminder>[] = [];
  try { all = await Reminder.getAll(); } catch { return res; }
  const byId = new Map(all.map((r) => [r.identifier, r] as const));
  res.scanned = synced.length;

  for (const t of synced) {
    const rem = t.reminderIdentifier ? byId.get(t.reminderIdentifier) : undefined;
    if (!rem) {
      if (t.reminderIdentifier) { t.reminderIdentifier = undefined; t.reminderSync = "pending"; res.detached.push(t.id); res.needPush.push(t.id); }
      else { t.reminderSync = "pending"; res.needPush.push(t.id); }
      continue;
    }
    if (rem.isCompleted && !t.done) {
      t.done = true;
      t.completedAt = rem.completionDate ? new Date(rem.completionDate as any).getTime() : Date.now();
      res.completedLocally.push(t.id);
    } else if (!rem.isCompleted && t.done) {
      try { rem.isCompleted = true; await rem.save(); res.completedInSystem.push(t.id); } catch { /* 下次再试 */ }
    }
    if (signatureOf(t) !== t.reminderSignature) { res.needPush.push(t.id); }
  }
  return res;
}
