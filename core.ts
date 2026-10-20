// 唯一的写路径（PRD 6.16）：UI、AppIntent、小组件、通知按钮全部走这里，
// 保证「撤销栈 + 落盘 + 副作用 + 切片」不会因为入口不同而漏掉某一步。
import { Action, Effect, reduce } from "./logic";
import { DB, DEFAULT_SETTINGS, Settings, Task, businessDay } from "./types";
import { Store, beforeImage } from "./store";
import { dispatch, makeCtx, makeStore, writeSlice } from "./runtime";
import { widgetSlice } from "./logic";

let handle: Store | null = null;
export function store(settings: Settings = DEFAULT_SETTINGS): Store {
  if (!handle) handle = makeStore(settings);
  return handle;
}

export type EffectResult = {
  db: DB;
  effects: Effect[];
  label: string;
  added: string[];
  /** 同步到系统提醒事项失败的 id */
  failures: string[];
};

export const TYPE_LABEL: Record<string, string> = {
  add: "新增", complete: "完成", reopen: "重新打开", pickToday: "加入今日", unpick: "移出今日",
  moveTomorrow: "改到明天", setSegment: "改时间段", setDue: "改日期", clearDue: "清除日期",
  setPriority: "改优先级", toggleFlag: "旗标", setProject: "改项目", setRepeat: "改重复",
  snooze: "稍后提醒", addSubtask: "加子任务", toggleSubtask: "改子任务", removeSubtask: "删子任务",
  reorder: "排序", trash: "删除", restore: "恢复", bulk: "批量", rollover: "每日重置",
  purgeTrash: "清空回收站", upsertProject: "改项目", ensureProject: "建项目", update: "编辑",
};

export function touchedIds(db: DB, a: Action): string[] {
  if (a.type === "bulk") return a.ids.slice();
  if (a.type === "reorder") return a.ids.slice();
  if (a.type === "add") return [];
  const id = (a as any).id;
  if (typeof id === "string" && db.tasks.some((t) => t.id === id)) return [id];
  return [];
}

export function labelOf(db: DB, a: Action): string {
  if (a.type === "add") return `新增 ${(((a as any).task as Task) || { title: "" }).title}`;
  if (a.type === "bulk") return `${TYPE_LABEL[a.action.type] ?? a.action.type} ${a.ids.length} 条`;
  if (a.type === "ensureProject") return `建项目 ${a.name}`;
  if (a.type === "upsertProject") return `改项目 ${a.project.name}`;
  if (a.type === "rollover") return "每日重置";
  if (a.type === "purgeTrash") return "清空回收站";
  const id = (a as any).id as string | undefined;
  const t = id ? db.tasks.find((x) => x.id === id) : undefined;
  return `${TYPE_LABEL[a.type] ?? a.type} ${t ? t.title : ""}`.trim();
}

/**
 * 依次执行多条动作。
 * 一次 perform 只压一条撤销条目：before = 本次起点库里所有被改动任务的前镜像，
 * addedIds = 本次新增的 id。这样「新增并归类」这类组合动作撤销一次就干净回滚。
 */
export async function perform(
  input: Action | Action[],
  opts: { settings?: Settings; db?: DB; undoable?: boolean } = {},
): Promise<EffectResult> {
  const s = store(opts.settings ?? DEFAULT_SETTINGS);
  const settings = opts.settings ?? s.loadSettings();
  const start = opts.db ?? s.loadDB();
  const ctx = makeCtx(start, settings);
  const actions = Array.isArray(input) ? input : [input];

  let db = start;
  let effects: Effect[] = [];
  const labels: string[] = [];
  const added: string[] = [];
  const touched = new Set<string>();

  for (const a of actions) {
    const res = reduce(db, a, makeCtx(db, settings));
    touchedIds(db, a).forEach((id) => touched.add(id));
    res.db.tasks.filter((t) => !db.tasks.some((o) => o.id === t.id)).forEach((t) => added.push(t.id));
    labels.push(labelOf(db, a));
    effects = effects.concat(res.effects);
    db = res.db;
  }

  if (opts.undoable !== false && (touched.size || added.length)) {
    s.undo.push({
      label: labels.length === 1 ? labels[0] : labels.join(" + "),
      before: beforeImage(start, [...touched]),
      addedIds: added,
      at: Date.now(),
    });
  }

  s.saveDB(db);
  if (settings.widgetSliceEnabled) writeSlice(widgetSlice(db, ctx));
  const failures = await dispatch(effects, db, settings);
  return { db, effects, label: labels.join(" + "), added, failures };
}

/** 撤销最近一步 */
export async function undoLast(settings?: Settings): Promise<{ label: string; db: DB } | undefined> {
  const s = store(settings ?? DEFAULT_SETTINGS);
  const cfg = settings ?? s.loadSettings();
  const u = s.undo.undo(s.loadDB());
  if (!u) return undefined;
  s.saveDB(u.db);
  writeSlice(widgetSlice(u.db, makeCtx(u.db, cfg)));
  return { label: u.label, db: u.db };
}

/** 只读快照：给小组件、Spotlight、控制中心控件用，绝不写库 */
export function snapshot(settings?: Settings) {
  const s = store(settings ?? DEFAULT_SETTINGS);
  const cfg = settings ?? s.loadSettings();
  const db = s.loadDB();
  const today = businessDay(new Date(), cfg.todayResetHour);
  return { db, settings: cfg, today, ctx: makeCtx(db, cfg) };
}
