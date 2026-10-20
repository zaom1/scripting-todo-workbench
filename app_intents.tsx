// app_intents.tsx —— 所有 AppIntent 必须在这里注册（PRD FR-701/FR-703/FR-704）。
// 该环境是后台静默执行：不弹 UI、不做长耗时工作，只改数据 + 刷新小组件/控制中心。
import { AppIntentManager, AppIntentProtocol, ControlWidget, Script, Widget } from "scripting";
import { perform, snapshot } from "./core";
import { parse } from "./parse";
import { taskFromDraft } from "./logic";
import { businessDay } from "./types";

/** 快捷指令 / Siri：一句话建档（FR-201 的入口复用同一个解析器） */
export const QuickAddIntent = AppIntentManager.register({
  name: "QuickAddIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async ({ text }: { text: string }) => {
    const { db, settings, ctx } = snapshot();
    const raw = (text ?? "").trim();
    if (!raw) return;
    const r = parse(raw, ctx.today);
    if (!r.title.trim()) return;
    let working = db;
    let projectId: string | undefined;
    if (r.projectName) {
      const ensured = await perform({ type: "ensureProject", name: r.projectName }, { db, settings, undoable: false });
      working = ensured.db;
      projectId = (working.projects.find((p) => p.name === r.projectName) || { id: undefined } as any).id;
    }
    const task = taskFromDraft({
      title: r.title, dueDate: r.dueDate, dueTime: r.dueTime, segment: r.segment,
      priority: r.priority, flagged: r.flagged, repeat: r.repeat, tags: r.tags,
      subtasks: r.subtasks, remindOffsetMin: r.remindOffsetMin,
    }, working, ctx, projectId);
    await perform({ type: "add", task }, { db: working, settings, undoable: false });
    Widget.reloadAll();
    ControlWidget.reloadButtons();
  },
});

/** 小组件上的单条完成按钮 */
export const CompleteTaskIntent = AppIntentManager.register({
  name: "CompleteTaskIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async ({ id }: { id: string }) => {
    if (!id) return;
    await perform({ type: "complete", id }, { undoable: false });
    Widget.reloadAll();
  },
});

/** 小组件「完成下一条」：取今日切片第一项 */
export const CompleteNextIntent = AppIntentManager.register({
  name: "CompleteNextIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    const { db, ctx } = snapshot();
    const { todayView } = await import("./logic");
    const next = todayView(db, ctx).scheduled[0] ?? todayView(db, ctx).pinned[0] ?? todayView(db, ctx).overdue[0];
    if (!next) return;
    await perform({ type: "complete", id: next.id }, { undoable: false });
    Widget.reloadAll();
    ControlWidget.reloadButtons();
  },
});

/** 小组件/控制中心：把第一条挑进今日 */
export const PickNextTodayIntent = AppIntentManager.register({
  name: "PickNextTodayIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    const { db, ctx } = snapshot();
    const { inboxOf } = await import("./logic");
    const next = inboxOf(db, ctx)[0];
    if (!next) return;
    await perform({ type: "pickToday", id: next.id }, { undoable: false });
    Widget.reloadAll();
  },
});

/** 撤销上一步（控制中心按钮） */
export const UndoLastIntent = AppIntentManager.register({
  name: "UndoLastIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async () => {
    const { undoLast } = await import("./core");
    await undoLast();
    Widget.reloadAll();
    ControlWidget.reloadButtons();
  },
});

/** 打开工作台某个视图（快捷指令、Spotlight、控制中心共用） */
export const OpenWorkbenchIntent = AppIntentManager.register({
  name: "OpenWorkbenchIntent",
  protocol: AppIntentProtocol.AppIntent,
  perform: async ({ view }: { view?: string }) => {
    try { await Script.run({ name: snapshot().settings.scriptName, queryParameters: { view: view ?? "today" }, singleMode: true }); } catch { /* 忽略 */ }
  },
});
