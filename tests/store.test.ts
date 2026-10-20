// 持久化与撤销栈单测（PRD FR-901、NFR-6 存档兼容）。
import { K, MemoryKV, Store, UndoStack, beforeImage, normalizeDB, parseJSON } from "../store";
import { Action, Ctx, reduce, taskFromDraft } from "../logic";
import { DB, DEFAULT_SETTINGS, Task, emptyDB } from "../types";

let pass = 0;
const fails: string[] = [];
function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name}\n     期望 ${e}\n     实际 ${a}`);
}
function ok(name: string, cond: boolean) { eq(name, !!cond, true); }

const TODAY = "2026-10-20";
const NOW = new Date(2026, 9, 20, 9, 0).getTime();
let seq = 0;
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ today: TODAY, now: NOW, newId: () => `id${++seq}`, settings: { ...DEFAULT_SETTINGS }, ...over });
const T = (id: string, over: Partial<Task> = {}): Task => ({ id, title: id, tags: [], subtasks: [], done: false, flagged: false, order: 0, createdAt: NOW, ...over } as Task);
const R = (db: DB, a: Action, c: Ctx = ctx()) => reduce(db, a, c).db;

// —— JSON 容错 ——
eq("parseJSON null 回落", parseJSON<string>(null, "fb"), "fb");
eq("parseJSON 坏数据回落", parseJSON<number>("{坏 JSON", 7), 7);
eq("parseJSON 正常解析", parseJSON<number>("3", 7), 3);

// —— normalizeDB：旧存档缺字段补齐 ——
{
  const legacy = { tasks: [{ id: "a", title: "老任务" }, null, { id: "b" }, { title: "无 id" }] } as unknown as Partial<DB>;
  const db = normalizeDB(legacy, emptyDB());
  eq("只保留合法条目", db.tasks.map((t) => t.id), ["a"]);
  eq("补齐数组字段", [db.tasks[0].tags, db.tasks[0].subtasks], [[], []]);
  eq("补齐布尔字段", [db.tasks[0].done, db.tasks[0].flagged], [false, false]);
  eq("补齐同步状态", db.tasks[0].reminderSync, "off");
  eq("补齐项目/领域", [db.projects.length, db.areas.length], [0, 0]);
  const empty = normalizeDB(null, emptyDB());
  eq("null 回落空库", empty.tasks.length, 0);
}

// —— MemoryKV ——
{
  const kv = new MemoryKV();
  kv.set("a", "1");
  eq("KV 读回", kv.get("a"), "1");
  eq("未命中返回 null 而非 undefined", kv.get("nope"), null);
  kv.remove("a");
  eq("删除后为 null", kv.get("a"), null);
}

// —— Store 读写与缓存 ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  let db = emptyDB();
  db.tasks.push(T("a", { title: "写周报" }));
  s.saveDB(db);
  ok("落盘有内容", (kv.get(K.db) ?? "").includes("写周报"));
  const s2 = new Store(kv, DEFAULT_SETTINGS);
  eq("重新实例可读回", s2.loadDB().tasks.map((t) => t.title), ["写周报"]);
  eq("缓存命中同一引用", s2.loadDB() === s2.loadDB(), true);
  s2.reload();
  ok("reload 后重新解析", s2.loadDB().tasks.length === 1);
}

// —— Settings 向后兼容合并 ——
{
  const kv = new MemoryKV();
  kv.set(K.settings, JSON.stringify({ defaultView: "planned" }));
  const s = new Store(kv, DEFAULT_SETTINGS);
  const got = s.loadSettings();
  eq("读回已存字段", got.defaultView, "planned");
  eq("缺失字段回落默认", got.todayResetHour, DEFAULT_SETTINGS.todayResetHour);
  eq("滑动配置缺失时回落", got.swipeActions.fullSwipe, DEFAULT_SETTINGS.swipeActions.fullSwipe);
  const kv2 = new MemoryKV();
  eq("无存档时给默认", new Store(kv2, DEFAULT_SETTINGS).loadSettings().schemaVersion, DEFAULT_SETTINGS.schemaVersion);
}

// —— Meta / 切片 ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  eq("meta 初值", s.loadMeta(), { lastBusinessDay: "", lastLaunchAt: 0 });
  s.saveMeta({ lastBusinessDay: TODAY, lastLaunchAt: NOW });
  eq("meta 读回", new Store(kv, DEFAULT_SETTINGS).loadMeta().lastBusinessDay, TODAY);
  s.writeSlice({ day: TODAY, items: [1, 2] });
  eq("切片读回", (s.readSlice<{ items: number[] }>() ?? { items: [] }).items, [1, 2]);
  s.saveDB(emptyDB());
  s.clearCaches();
  ok("清缓存删掉切片", kv.get(K.slice) === null);
  ok("清缓存不动主库", kv.get(K.db) !== null);
}

// —— 撤销栈：前镜像语义 ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  const c = ctx();
  let db = emptyDB();
  db.tasks.push(T("t1"), T("t2"), T("t3"));
  s.saveDB(db);

  const e1 = beforeImage(db, ["t1"]);
  const db2 = R(db, { type: "toggleFlag", id: "t1" }, c);
  s.undo.push({ label: "旗标 写周报", before: e1, addedIds: [], at: NOW });
  s.saveDB(db2);
  eq("改动生效", db2.tasks[0].flagged, true);
  ok("可撤销", s.undo.canUndo);
  eq("栈顶说明", s.undo.topLabel, "旗标 写周报");

  const u = s.undo.undo(db2)!;
  eq("撤销恢复旗标", u.db.tasks[0].flagged, false);
  eq("撤销不影响其他条目", u.db.tasks.length, 3);
  eq("撤销消费一条", s.undo.size, 0);
}

// —— 撤销：新增任务要整条消失（addedIds） ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  const c = ctx();
  const db = emptyDB();
  db.tasks.push(T("keep"));
  const draft = taskFromDraft({ title: "买猫粮" }, db, c);
  const db2 = R(db, { type: "add", task: draft }, c);
  s.undo.push({ label: "新增 买猫粮", before: [], addedIds: [draft.id], at: NOW });
  eq("新增后可见", db2.tasks.map((t) => t.title), ["keep", "买猫粮"]);
  const u = s.undo.undo(db2)!;
  eq("撤销删除新任务", u.db.tasks.map((t) => t.title), ["keep"]);
  ok("保留原有任务", u.db.tasks.some((t) => t.id === "keep"));
}

// —— 撤销只回滚受影响任务，不误删他人新增（并发安全） ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  let db = emptyDB();
  db.tasks.push(T("t1"));
  const before = beforeImage(db, ["t1"]);
  const db2 = R(db, { type: "toggleFlag", id: "t1" });
  s.undo.push({ label: "旗标", before, addedIds: [], at: NOW });
  // 期间另一个入口（快捷指令/AppIntent）新增了任务
  const db3 = R(db2, { type: "add", task: T("t9", { title: "外部新增" }) });
  const u = s.undo.undo(db3)!;
  eq("外部新增不被吞掉", u.db.tasks.map((t) => t.id).sort(), ["t1", "t9"]);
  eq("受影响任务被回滚", u.db.tasks.find((t) => t.id === "t1")!.flagged, false);
}

// —— 撤销栈上限与持久化 ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  for (let i = 0; i < 45; i++) s.undo.push({ label: `a${i}`, before: [], addedIds: [], at: NOW });
  eq("默认上限 40", s.undo.size, 40);
  eq("丢弃最旧", s.undo.labels[0], "a5");
  eq("最新在栈顶", s.undo.topLabel, "a44");
  const reloaded = new Store(kv, DEFAULT_SETTINGS);
  eq("跨实例恢复栈长", reloaded.undo.size, 40);
  eq("跨实例恢复 id 序号", reloaded.undo.pop()!.id > 0, true);
  s.undo.push({ label: "x", before: [], addedIds: [], at: NOW });
  eq("撤销栈落盘", JSON.parse(kv.get(K.undo) ?? "[]").length, 40);
  s.undo.clear();
  eq("清空后长度 0", s.undo.size, 0);
  eq("清空也持久化", JSON.parse(kv.get(K.undo) ?? "[]").length, 0);
}

// —— 自定义上限（内存栈） ——
{
  const kv = new MemoryKV();
  const st = new UndoStack(kv, 2);
  st.push({ label: "1", before: [], addedIds: [], at: 0 });
  st.push({ label: "2", before: [], addedIds: [], at: 0 });
  st.push({ label: "3", before: [], addedIds: [], at: 0 });
  eq("自定义上限生效", st.labels, ["2", "3"]);
}

// —— 导出 / 导入 round-trip ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  let db = emptyDB();
  db.tasks.push(T("a", { title: "带子任务", subtasks: [{ id: "s", title: "x", done: false, order: 0 }] }));
  db.projects.push({ id: "p1", name: "家庭", order: 1 });
  s.saveDB(db);
  s.saveSettings({ ...DEFAULT_SETTINGS, defaultView: "planned" });
  const text = s.exportJSON();
  ok("导出含 schema 标记", text.includes('"schema":1'));

  const kv2 = new MemoryKV();
  const s2 = new Store(kv2, DEFAULT_SETTINGS);
  const bad = s2.importJSON("不是json");
  eq("坏输入拒绝", [bad.ok, bad.error ? true : false], [false, true]);
  eq("缺 db 拒绝", s2.importJSON('{"settings":{}}').ok, false);

  const r = s2.importJSON(text);
  eq("导入成功", r.ok, true);
  eq("导入任务", s2.loadDB().tasks.map((t) => t.title), ["带子任务"]);
  eq("导入子任务", s2.loadDB().tasks[0].subtasks.map((x) => x.title), ["x"]);
  eq("导入项目", s2.loadDB().projects.map((p) => p.name), ["家庭"]);
  eq("导入设置", s2.loadSettings().defaultView, "planned");

  // 整库被替换后旧撤销条目必须失效，否则「撤销」会把新库改回旧前镜像
  s2.undo.push({ label: "假动作", before: [T("ghost")], addedIds: [], at: Date.now() });
  eq("导入前有 1 条撤销", s2.undo.size, 1);
  s2.importJSON(text);
  eq("导入后清栈", s2.undo.size, 0);
  eq("导入后撤销不可用", s2.undo.undo(s2.loadDB()), undefined);
}

// —— 版本号 ——
{
  const kv = new MemoryKV();
  const s = new Store(kv, DEFAULT_SETTINGS);
  const v0 = s.dbVersion;
  s.saveDB(emptyDB());
  s.saveDB(emptyDB());
  eq("每次写库自增", s.dbVersion, v0 + 2);
}

console.log(`\nstore: ${pass} 通过 / ${pass + fails.length} 断言`);
if (fails.length) {
  console.log("失败：\n - " + fails.join("\n - ") + "\n");
  process.exit(1);
}
