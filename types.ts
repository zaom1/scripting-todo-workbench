// 数据模型。本文件不 import "scripting"，可在 Node 里直接跑单测。

export type Priority = 1 | 2 | 3 | 4; // 1 最高；undefined 表示未设优先级

/** Things 3 式四段时间语义 */
export type Segment = "today" | "evening" | "date" | "someday";

export type ViewKey =
  | "today" | "inbox" | "planned" | "projects" | "flagged" | "archive" | "settings";

export interface Subtask {
  id: string;
  title: string;
  done: boolean;
  order: number;
}

export interface RepeatRule {
  freq: "daily" | "weekly" | "weekday" | "monthday" | "interval";
  /** 1=周一 … 7=周日，weekly 时使用 */
  weekdays?: number[];
  interval?: number;
  /** 每月第 N 个 weekday（bySetPos），暂未在 UI 暴露 */
  bySetPos?: number;
  /** fromCompletion: 完成之日起算；fromDue: 按日历排（竞品差异点，见 PRD 5.1） */
  mode: "fromCompletion" | "fromDue";
}

export interface Task {
  id: string;
  title: string;
  notes?: string;

  projectId?: string;
  /** 由 project 派生，冗余存储换取过滤性能 */
  areaId?: string;
  tags: string[];
  priority?: Priority;
  flagged: boolean;

  segment?: Segment;
  /** 本地日期字符串 YYYY-MM-DD，不做 UTC 转换（单设备自用，见 PRD 5.3） */
  dueDate?: string;
  /** HH:mm */
  dueTime?: string;
  /** 区间任务，字段保留、v1 无 UI 入口（D4） */
  endDate?: string;
  /** 提醒时间戳 ms（绝对时刻，早于 due） */
  scheduledAt?: number;
  repeat?: RepeatRule;

  subtasks: Subtask[];
  /** 被挑进「今日」的业务日期；每日重置的实现锚点 */
  inTodayOn?: string;
  /** 拾取来源，便于「退回原处」 */
  pickedFrom?: ViewKey;
  /** 稍后提醒（snooze）到期时间戳 */
  snoozedUntil?: number;
  /** 等待中：有值则不参与今日推荐 */
  waitingFor?: string;

  createdAt: number;
  completedAt?: number;
  done: boolean;
  /** 视图内手动排序 */
  order: number;

  // —— 与系统提醒事项的同步（PRD 5.4 状态机）——
  reminderIdentifier?: string;
  reminderSync?: "off" | "up" | "pending";
  reminderSignature?: string;
  /** 已排期的本地通知 identifier，改期时先取消再重排（对应竞品坑 A8） */
  alarmIds?: string[];

  /** 软删除标记：进归档 30 天后才真删（PRD 13.2） */
  trashedAt?: number;
}

export interface Project {
  id: string;
  name: string;
  areaId?: string;
  symbol?: string;
  color?: string;
  archived?: boolean;
  order: number;
}

export interface Area {
  id: string;
  name: string;
  order: number;
}

export interface DB {
  tasks: Task[];
  projects: Project[];
  areas: Area[];
}

export interface Settings {
  schemaVersion: number;
  firstDayOfWeek: 1 | 0;
  defaultView: ViewKey;
  /** 业务日切换时刻，默认 04:00（D2） */
  todayResetHour: number;
  /** reset: 每日清零；keep: 保留（D11，微软方案的硬伤修补） */
  todayResetMode: "reset" | "keep";
  /** 滑动动作重映射（安卓 A2） */
  swipeActions: { leading: string[]; trailing: string[]; fullSwipe: string };
  /** 循环催办总开关，默认关（PRD 6.11） */
  nagRepeat: boolean;
  /** 只有日期没有时刻的任务，也在该整点推一条通知（补 PRD 未定义处，见 D15） */
  allDayNotifyEnabled: boolean;
  allDayNotifyHour: number;
  haptics: "auto" | "on" | "off";
  /** 本脚本在 Scripting 里的名字，用于通知动作按钮回跳（PRD 6.10） */
  scriptName: string;
  widgetFamily: "systemSmall" | "systemMedium" | "systemLarge";
  /** 是否把当日切片写入 App Group 供小组件读取（D14 的本地优先方案） */
  widgetSliceEnabled: boolean;
  /** 完成数保留用于归档的天数 */
  archiveKeepDays: number;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: 1,
  firstDayOfWeek: 1,
  defaultView: "today",
  todayResetHour: 4,
  todayResetMode: "reset",
  swipeActions: { leading: ["today", "flag"], trailing: ["complete", "tomorrow"], fullSwipe: "complete" },
  nagRepeat: false,
  allDayNotifyEnabled: true,
  allDayNotifyHour: 9,
  haptics: "auto",
  scriptName: "待办工作台",
  widgetFamily: "systemMedium",
  widgetSliceEnabled: true,
  archiveKeepDays: 30,
};

export const ACTION_POOL: Record<string, string> = {
  complete: "完成",
  today: "加入今日",
  flag: "旗标",
  tomorrow: "改期到明天",
  priority: "改优先级",
  sync: "同步提醒事项",
  inbox: "移到收集箱",
  drop: "放弃",
  delete: "删除",
};

/** 业务日：以 todayResetHour 为界，凌晨 4 点前算昨天 */
export function businessDay(now: Date = new Date(), resetHour: number = DEFAULT_SETTINGS.todayResetHour): string {
  const d = new Date(now.getTime());
  if (d.getHours() < resetHour) d.setDate(d.getDate() - 1);
  return ymd(d);
}

export function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split("-").map((n) => parseInt(n, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

export function addDays(s: string, n: number): string {
  const d = parseYmd(s);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** 1=周一…7=周日 */
export function isoWeekday(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

export function isOverdue(t: Task, today: string): boolean {
  return !t.done && !!t.dueDate && t.dueDate < today;
}

export function subtaskProgress(t: Task): string {
  if (!t.subtasks.length) return "";
  const done = t.subtasks.filter((s) => s.done).length;
  return `${done}/${t.subtasks.length}`;
}

export function priorityLabel(p?: Priority): string {
  return p === 1 ? "!1 最高" : p === 2 ? "!2 高" : p === 3 ? "!3 中" : p === 4 ? "!4 低" : "";
}

/** 重复规则的下一次到期日（PRD 13.2 幂等要求） */
export function nextOccurrence(rule: RepeatRule, from: Task, today: string): string | undefined {
  const base = rule.mode === "fromCompletion" ? today : from.dueDate ?? today;
  switch (rule.freq) {
    case "daily":
      return addDays(base, rule.interval && rule.interval > 1 ? rule.interval : 1);
    case "interval":
      return addDays(base, rule.interval ?? 7);
    case "weekday": {
      let d = addDays(base, 1);
      for (let i = 0; i < 7; i++) {
        const wd = isoWeekday(parseYmd(d));
        if (wd <= 5) return d;
        d = addDays(d, 1);
      }
      return d;
    }
    case "weekly": {
      const wanted = rule.weekdays && rule.weekdays.length ? rule.weekdays : [isoWeekday(parseYmd(base))];
      // 逐日步进，找第一个匹配目标 weekday 的日子；interval>1 时跨度按 N 周放宽
      const span = 7 * (rule.interval && rule.interval > 1 ? rule.interval : 1) + 7;
      for (let i = 1; i <= span; i++) {
        const cand = addDays(base, i);
        if (wanted.includes(isoWeekday(parseYmd(cand)))) return cand;
      }
      return addDays(base, 7);
    }
    case "monthday": {
      const d = parseYmd(base);
      const target = rule.interval && rule.interval > 1 ? rule.interval : 1;
      const dom = parseYmd(from.dueDate ?? base).getDate();
      // 目标月没有这一天（如 31 号遇 2 月）时向后退到月末，避免溢出到下个月
      const lastDay = new Date(d.getFullYear(), d.getMonth() + target + 1, 0).getDate();
      return ymd(new Date(d.getFullYear(), d.getMonth() + target, Math.min(dom, lastDay)));
    }
  }
}

export const REPEAT_TEXT: Record<string, string> = {
  none: "不重复",
  daily: "每天",
  weekday: "每个工作日",
  weekly: "每周",
  monthday: "每月",
};

export function repeatText(r?: RepeatRule): string {
  if (!r) return "";
  const base = REPEAT_TEXT[r.freq] ?? r.freq;
  return r.freq === "weekly" && r.weekdays && r.weekdays.length ? `${base}·周${r.weekdays.join("/")}` : base;
}

export function emptyDB(): DB {
  return { tasks: [], projects: [], areas: [] };
}
