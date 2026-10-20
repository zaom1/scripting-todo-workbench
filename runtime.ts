// Scripting 运行时胶水层：把 logic.ts 产出的副作用派发到真实 API。
// 除 UI 文件外，这里是唯一大量触碰 "scripting" 模块的地方，便于真机排查。
import {
  FileManager, HapticFeedback, Notification, Pasteboard, Path, Script, ShareSheet, Spotlight, Storage, UUID, Widget,
} from "scripting";
import { Ctx, Effect } from "./logic";
import { DB, Settings, Task, businessDay } from "./types";
import { KV, Store, parseJSON } from "./store";
import { deleteReminder, signatureOf, upsertReminder } from "./reminders";

// —— Storage 是同步 API，未命中返回 null ——
export const kv: KV = {
  get(key: string): string | null {
    try { const v = Storage.get<string>(key); return typeof v === "string" ? v : null; } catch { return null; }
  },
  set(key: string, value: string): void {
    try { Storage.set(key, value); } catch (e) { console.log("Storage.set 失败", String(e)); }
  },
  remove(key: string): void {
    try { Storage.remove(key); } catch { /* 忽略 */ }
  },
};

export function makeStore(settings: Settings): Store { return new Store(kv, settings); }

export function newId(): string {
  try { return UUID.string(); } catch { return `t${Date.now()}_${Math.floor(Math.random() * 1e6)}`; }
}

export function makeCtx(db: DB, settings: Settings): Ctx {
  return { today: businessDay(new Date(), settings.todayResetHour), now: Date.now(), newId, settings };
}

// —— App Group 切片：widget / 实时活动读这份，不读主库 ——
const SLICE_FILE = "todo-workbench.slice.json";

export function slicePath(): string | null {
  const dir = FileManager.appGroupDocumentsDirectory as string | null;
  if (!dir) return null;
  try { return Path.join(dir, SLICE_FILE); } catch { return `${dir}/${SLICE_FILE}`; }
}

export function writeSlice(slice: unknown): void {
  const text = JSON.stringify(slice);
  kv.set("widget.slice.v1", text);                     // 同脚本域，兜底通道
  const p = slicePath();
  if (!p) return;
  try { FileManager.writeAsStringSync(p, text); } catch (e) { console.log("切片写入失败", String(e)); }
}

export function readSlice<T>(): T | null {
  const p = slicePath();
  if (p) {
    try { if (FileManager.existsSync(p)) return parseJSON<T>(FileManager.readAsStringSync(p), null as unknown as T); } catch { /* 落到 Storage */ }
  }
  return parseJSON<T | null>(kv.get("widget.slice.v1"), null);
}

// —— 触感 ——
export function haptic(kind: "success" | "impact" | "selection" | "error", settings: Settings): void {
  if (settings.haptics === "off") return;
  try {
    if (kind === "success") HapticFeedback.notificationSuccess();
    else if (kind === "error") HapticFeedback.notificationError();
    else if (kind === "selection") HapticFeedback.selection();
    else HapticFeedback.lightImpact();
  } catch { /* 部分设备不支持 */ }
}

// —— 通知：schedule 不能自定义 identifier，故按 userInfo.taskId 反查 pending 再取消 ——
type Pending = { identifier?: string; content?: { userInfo?: Record<string, any> }; request?: { identifier?: string; content?: { userInfo?: Record<string, any> } } };

async function pendingsByTask(memo: Map<string, string[]>): Promise<void> {
  let pendings: Pending[] = [];
  try { pendings = (await Notification.getAllPendingsOfCurrentScript()) as Pending[]; } catch { pendings = []; }
  memo.clear();
  for (const p of pendings) {
    const info = (p.content ?? p.request?.content ?? {}) as { userInfo?: Record<string, any> };
    const tid = info.userInfo && info.userInfo.taskId;
    const ident = p.identifier ?? p.request?.identifier;
    if (typeof tid === "string" && typeof ident === "string") memo.set(tid, [...(memo.get(tid) ?? []), ident]);
  }
}

async function cancelAlarmsOf(taskIds: string[], memo: Map<string, string[]>): Promise<void> {
  if (!taskIds.length) return;
  if (memo.size === 0) await pendingsByTask(memo);
  const ids = taskIds.flatMap((id) => memo.get(id) ?? []);
  if (ids.length) { try { await Notification.removePendings(ids); } catch { /* 忽略 */ } }
  for (const id of taskIds) memo.delete(id);
}

function actionsFor(t: Task, settings: Settings) {
  const url = (q: Record<string, any>) => {
    try { return Script.createRunURLScheme(settings.scriptName, q); } catch { return ""; }
  };
  return [
    { title: "完成", icon: "checkmark.circle", url: url({ act: "complete", id: t.id }) },
    { title: "稍后 1 小时", icon: "clock", url: url({ act: "snooze", id: t.id, minutes: 60 }) },
    { title: "改到明天", icon: "calendar", url: url({ act: "tomorrow", id: t.id }) },
    { title: "放弃", icon: "xmark", url: url({ act: "drop", id: t.id }), destructive: true },
  ];
}

export async function scheduleAlarm(t: Task, settings: Settings): Promise<boolean> {
  if (!t.scheduledAt || t.done || t.trashedAt) return false;
  const seconds = Math.round((t.scheduledAt - Date.now()) / 1000);
  if (seconds < 5) return false;              // 过期不补发，交给冷启动补排
  const line = [t.dueTime, ...t.tags.map((x) => "@" + x)].filter(Boolean).join(" ");
  try {
    const mod: any = await import("scripting");
    await Notification.schedule({
      title: t.title,
      body: line || "待办提醒",
      userInfo: { taskId: t.id, at: t.scheduledAt },
      threadIdentifier: `task-${t.id}`,
      interruptionLevel: t.priority === 1 ? "timeSensitive" : "active",
      trigger: new mod.TimeIntervalNotificationTrigger({ timeInterval: seconds, repeats: false }),
      actions: actionsFor(t, settings),
    });
    return true;
  } catch (e) { console.log("通知排期失败", String(e)); return false; }
}

// —— 副作用派发 ——
export async function dispatch(effects: Effect[], db: DB, settings: Settings): Promise<string[]> {
  const memo = new Map<string, string[]>();
  const byId = new Map(db.tasks.map((t) => [t.id, t] as const));
  const syncFailures: string[] = [];

  for (const e of effects) {
    switch (e.kind) {
      case "alarm.cancel":
        await cancelAlarmsOf(e.taskIds, memo);
        break;
      case "alarm.schedule": {
        const t = byId.get(e.taskId);
        if (!t) break;
        await cancelAlarmsOf([t.id], memo);
        await scheduleAlarm(t, settings);
        break;
      }
      case "reminder.push": {
        const t = byId.get(e.taskId);
        if (!t || t.reminderSync === "off") break;
        const r = await upsertReminder(t);
        t.reminderSignature = signatureOf(t);
        t.reminderSync = r.ok ? "up" : "pending";
        if (!r.ok) { syncFailures.push(t.id); console.log("提醒事项推送失败", t.id, r.error); }
        break;
      }
      case "reminder.remove":
        await deleteReminder(e.identifier);
        break;
      case "spotlight.index": {
        const t = byId.get(e.taskId);
        if (!t || t.done || t.trashedAt) break;
        try {
          await Spotlight.index({
            id: t.id,
            title: t.title,
            contentDescription: [t.notes, t.tags.map((x) => "@" + x).join(" ")].filter(Boolean).join(" · "),
            keywords: t.tags,
            parameters: { openTask: t.id },
          });
        } catch { /* 未授权时静默 */ }
        break;
      }
      case "spotlight.remove":
        try { await Spotlight.delete(e.taskId); } catch { /* 忽略 */ }
        break;
      case "widget.refresh":
        try { Widget.reloadAll(); } catch { /* 忽略 */ }
        break;
    }
  }
  return syncFailures;
}

/** 全量重排通知：冷启动补排、撤销后重建、设置变更后调用 */
export async function rescheduleAll(db: DB, settings: Settings): Promise<number> {
  try { await Notification.removeAllPendingsOfCurrentScript(); } catch { /* 忽略 */ }
  let n = 0;
  const now = Date.now();
  for (const t of db.tasks) {
    if (t.done || t.trashedAt) continue;
    if (t.snoozedUntil && t.snoozedUntil > now) {
      if (await scheduleAlarm({ ...t, scheduledAt: t.snoozedUntil } as Task, settings)) n++;
      continue;
    }
    if (t.scheduledAt && t.scheduledAt > now) { if (await scheduleAlarm(t, settings)) n++; continue; }
    if (t.dueDate && !t.scheduledAt && settings.allDayNotifyEnabled) {
      const d = new Date(t.dueDate + "T00:00:00");
      d.setHours(settings.allDayNotifyHour, 0, 0, 0);
      if (d.getTime() > now && await scheduleAlarm({ ...t, scheduledAt: d.getTime() } as Task, settings)) n++;
    }
  }
  const today = businessDay(new Date(), settings.todayResetHour);
  const badge = db.tasks.filter((t) => !t.done && !t.trashedAt && t.dueDate && t.dueDate <= today).length;
  try { await Notification.setBadgeCount(badge); } catch { /* 忽略 */ }
  return n;
}

/** 逐脚本权限模型：一次性申请用到的能力（PRD 9.1） */
export async function requestPermissions(): Promise<string[]> {
  try {
    const denied = await Script.requestAccess(["notifications", "reminders", "spotlight"]);
    return Array.isArray(denied) ? denied : [];
  } catch (e) { console.log("权限申请异常", String(e)); return []; }
}

// —— 数据自助（FR-901）：导出走本地文件 + ShareSheet，导入走剪贴板粘贴 ——
export function writeBackupFile(json: string, day: string): string | null {
  try {
    const p = Path.join(FileManager.documentsDirectory, `todo-workbench-${day}.json`);
    FileManager.writeAsStringSync(p, json);
    return p;
  } catch (e) { console.log("导出写文件失败", String(e)); return null; }
}

export async function shareFile(path: string): Promise<boolean> {
  try { return await ShareSheet.present([path]); } catch (e) { console.log("ShareSheet 失败", String(e)); return false; }
}

/** 从剪贴板找一段 JSON 文本（Scripting 没有确认过的系统文件选择器，粘贴最稳） */
export async function pasteboardJSON(): Promise<string | null> {
  try {
    const items = await Pasteboard.contents();
    const hit = (items ?? []).find((s) => typeof s === "string" && s.trim().startsWith("{") && s.includes("\"db\""));
    return typeof hit === "string" ? hit : null;
  } catch (e) { console.log("剪贴板读取失败", String(e)); return null; }
}
