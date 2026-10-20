// 持久化与撤销栈（PRD 6.16 / FR-901）。
// 这里只依赖一个极简 KV 接口，因此可以在 Node 里用 Map 假存储跑单测；
// 真机上由 runtime.ts 用 Scripting 的同步 Storage 实现该接口。
import { DB, Settings, Task, emptyDB } from "./types";

export interface KV {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const K = {
  db: "db.v1",
  settings: "settings.v1",
  meta: "meta.v1",
  undo: "undo.v1",
  slice: "widget.slice.v1",
} as const;

export interface Meta {
  lastBusinessDay: string;
  lastLaunchAt: number;
  /** 上次 reconcile（与系统提醒事项对齐）时间 */
  lastReconcileAt?: number;
}

export interface UndoEntry {
  id: number;
  label: string;
  /** 只存被改动任务的前镜像 + 当时的整个 DB 长度，控制体积 */
  before: Task[];
  addedIds: string[];
  at: number;
}

export function parseJSON<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

/** 内存 KV，测试与开发期使用 */
export class MemoryKV implements KV {
  private m = new Map<string, string>();
  get(key: string) { return this.m.has(key) ? this.m.get(key)! : null; }
  set(key: string, value: string) { this.m.set(key, value); }
  remove(key: string) { this.m.delete(key); }
  size() { return this.m.size; }
  keys() { return [...this.m.keys()]; }
}

/**
 * 撤销栈：前镜像快照式。
 * 每条动作记录「改之前的受影响任务」与「新增的 id」，undo 时反向覆盖/删除。
 * 这样即便期间别人新增了任务也不会被整库回滚吞掉（竞品常见坑）。
 */
export class UndoStack {
  private entries: UndoEntry[] = [];
  private seq = 0;

  constructor(private kv: KV, private limit = 40) {
    this.entries = parseJSON<UndoEntry[]>(kv.get(K.undo), []);
    this.seq = this.entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  }

  get size(): number { return this.entries.length; }
  get canUndo(): boolean { return this.entries.length > 0; }
  get topLabel(): string | undefined { return this.entries[this.entries.length - 1]?.label; }
  get labels(): string[] { return this.entries.map((e) => e.label); }

  push(entry: Omit<UndoEntry, "id">): UndoEntry {
    const e: UndoEntry = { ...entry, id: this.seq++ };
    this.entries.push(e);
    while (this.entries.length > this.limit) this.entries.shift();
    this.persist();
    return e;
  }

  pop(): UndoEntry | undefined {
    const e = this.entries.pop();
    this.persist();
    return e;
  }

  clear(): void { this.entries = []; this.persist(); }

  persist(): void { this.kv.set(K.undo, JSON.stringify(this.entries)); }

  /** 把栈恢复进 db（不消费条目） */
  private apply(entry: UndoEntry, db: DB): DB {
    const map = new Map(db.tasks.map((t) => [t.id, t] as const));
    for (const b of entry.before) map.set(b.id, JSON.parse(JSON.stringify(b)) as Task);
    for (const id of entry.addedIds) map.delete(id);
    return { ...db, tasks: [...map.values()] };
  }

  /** 撤销一条：返回新 DB 与被撤销的说明 */
  undo(db: DB): { db: DB; label: string } | undefined {
    const e = this.entries.pop();
    if (!e) return undefined;
    this.persist();
    return { db: this.apply(e, db), label: e.label };
  }
}

/** 取任务在 db 中的前镜像（用于 push 撤销条目） */
export function beforeImage(db: DB, ids: string[]): Task[] {
  const set = new Set(ids);
  return db.tasks.filter((t) => set.has(t.id)).map((t) => JSON.parse(JSON.stringify(t)) as Task);
}

export class Store {
  readonly undo: UndoStack;
  private cache: DB | null = null;
  private version = 0;
  private settingsDefaults: Settings;

  constructor(private kv: KV, settingsDefaults: Settings) {
    this.undo = new UndoStack(kv);
    this.settingsDefaults = settingsDefaults;
  }

  loadDB(): DB {
    if (this.cache) return this.cache;
    const raw = parseJSON<Partial<DB> | null>(this.kv.get(K.db), null);
    const db = normalizeDB(raw, emptyDB());
    this.cache = db;
    return db;
  }

  /** 写库；调用方负责先 push 撤销条目 */
  saveDB(db: DB): void {
    this.cache = db;
    this.version++;
    this.kv.set(K.db, JSON.stringify(db));
  }

  loadSettings(): Settings {
    const raw = parseJSON<Partial<Settings> | null>(this.kv.get(K.settings), null);
    // 浅合并 + 缺字段回落，保证升级后旧存档可用（NFR-6）
    const s = { ...this.settingsDefaults, ...(raw ?? {}) };
    if (!s.swipeActions || !Array.isArray(s.swipeActions.leading)) s.swipeActions = this.settingsDefaults.swipeActions;
    return s;
  }

  saveSettings(s: Settings): void { this.kv.set(K.settings, JSON.stringify(s)); }

  loadMeta(): Meta {
    return parseJSON<Meta>(this.kv.get(K.meta), { lastBusinessDay: "", lastLaunchAt: 0 });
  }
  saveMeta(m: Meta): void { this.kv.set(K.meta, JSON.stringify(m)); }

  writeSlice(slice: unknown): void { this.kv.set(K.slice, JSON.stringify(slice)); }
  readSlice<T>(): T | null { return parseJSON<T | null>(this.kv.get(K.slice), null); }

  /** 危险区：只清缓存派生数据，不动主库 */
  clearCaches(): void { this.cache = null; this.undo.clear(); this.kv.remove(K.slice); }

  /** 全量导出（本地文件备份用，PRD NFR-4：不做远端上传） */
  exportJSON(): string {
    return JSON.stringify({ app: "todo-workbench", schema: 1, exportedAt: Date.now(), db: this.loadDB(), settings: this.loadSettings() });
  }

  importJSON(text: string): { ok: boolean; error?: string; db?: DB; settings?: Settings } {
    let input: unknown;
    try { input = JSON.parse(text); } catch { return { ok: false, error: "不是合法 JSON" }; }
    const obj = input as { db?: unknown; settings?: unknown };
    if (!obj || typeof obj !== "object" || !obj.db) return { ok: false, error: "缺少 db 字段" };
    const db = normalizeDB(obj.db as Partial<DB>, null as unknown as DB);
    if (!db) return { ok: false, error: "db 结构无法识别" };
    // 整库被替换：旧撤销条目指向的前镜像已失效，必须清栈（否则「撤销」会写出鬼数据）
    this.undo.clear();
    this.saveDB(db);
    if (obj.settings && typeof obj.settings === "object") {
      const s = { ...this.settingsDefaults, ...(obj.settings as Partial<Settings>) };
      this.saveSettings(s);
      return { ok: true, db, settings: s };
    }
    return { ok: true, db, settings: this.loadSettings() };
  }

  get dbVersion(): number { return this.version; }
  reload(): void { this.cache = null; }
}

/** 存档兼容层：补齐缺失字段、丢弃非法条目 */
export function normalizeDB(raw: Partial<DB> | null | undefined, fallback: DB): DB {
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.tasks)) {
    return fallback ? JSON.parse(JSON.stringify(fallback)) as DB : (raw as DB);
  }
  const tasks: Task[] = [];
  for (const t of raw.tasks as Partial<Task>[]) {
    if (!t || typeof t.id !== "string" || typeof t.title !== "string") continue;
    tasks.push({
      ...(t as Task),
      tags: Array.isArray(t.tags) ? t.tags : [],
      subtasks: Array.isArray(t.subtasks) ? t.subtasks : [],
      done: !!t.done,
      flagged: !!t.flagged,
      order: typeof t.order === "number" ? t.order : 0,
      createdAt: typeof t.createdAt === "number" ? t.createdAt : 0,
      reminderSync: t.reminderSync === "up" || t.reminderSync === "pending" ? t.reminderSync : "off",
    });
  }
  return {
    tasks,
    projects: Array.isArray(raw.projects) ? raw.projects.filter((p) => p && typeof p.id === "string" && typeof p.name === "string") : [],
    areas: Array.isArray(raw.areas) ? raw.areas.filter((a) => a && typeof a.id === "string" && typeof a.name === "string") : [],
  };
}
