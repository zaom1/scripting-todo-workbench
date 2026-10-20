// 待办工作台 · 主入口（PRD M0+M1）
// 视图：今日 / 收集箱 / 计划 / 项目 / 旗标 / 回收站 / 设置
// 交互：自然语言快捕（带 chip 预览）、滑动动作、长按菜单、多选批量、详情 sheet、撤销 toast
import {
  Button, Divider, DisclosureGroup, EditButton, Group, HStack, Image, Label, List, Menu, Navigation,
  NavigationStack, ProgressView, Section, Spacer, Text, TextField, Toggle, UUID, VStack,
  Script, Spotlight, useState, useObservable, useMemo, useEffect, useCallback,
} from "scripting";
import { chipsOf, parse } from "./parse";
import {
  Action, Ctx, Effect, counts, inboxOf, plannedGroups, reduce, sortList, taskFromDraft, todayView,
  trashOf, widgetSlice, BUCKET_LABEL,
} from "./logic";
import {
  ACTION_POOL, Area, DB, DEFAULT_SETTINGS, Priority, Project, Settings, Task, ViewKey,
  businessDay, isOverdue, repeatText, subtaskProgress,
} from "./types";
import { Store, beforeImage } from "./store";
import {
  dispatch, haptic, makeStore, makeCtx, pasteboardJSON, readSlice, requestPermissions, rescheduleAll,
  shareFile, writeBackupFile, writeSlice,
} from "./runtime";
import { reconcile } from "./reminders";
import { TYPE_LABEL, labelOf, perform, snapshot, store as coreStore, touchedIds, undoLast } from "./core";

const VIEW_TITLE: Record<ViewKey, string> = {
  today: "今日", inbox: "收集箱", planned: "计划", projects: "项目", flagged: "旗标", archive: "回收站", settings: "设置",
};
const VIEW_ICON: Record<ViewKey, string> = {
  today: "sun.max", inbox: "tray.full", planned: "calendar", projects: "square.grid.2x2",
  flagged: "flag.fill", archive: "trash", settings: "gearshape",
};

// 存储句柄统一由 core 持有，保证 UI 与 AppIntent 看到的是同一份
const getStore = (settings: Settings): Store => coreStore(settings);

function priorityTint(p?: Priority): string | undefined {
  return p === 1 ? "systemRed" : p === 2 ? "systemOrange" : p === 3 ? "systemYellow" : undefined;
}

function addOne(d: string): string {
  const dt = new Date(d + "T00:00:00");
  dt.setDate(dt.getDate() + 1);
  return `${dt.getFullYear()}-${`${dt.getMonth() + 1}`.padStart(2, "0")}-${`${dt.getDate()}`.padStart(2, "0")}`;
}

function dueText(t: Task, today: string): string {
  if (!t.dueDate) return "";
  if (t.dueDate === today) return t.dueTime ? `今天 ${t.dueTime}` : "今天";
  if (t.dueDate < today) return `逾期 ${t.dueDate.slice(5).replace("-", "/")}`;
  if (t.dueDate === addOne(today)) return t.dueTime ? `明天 ${t.dueTime}` : "明天";
  return `${t.dueDate.slice(5).replace("-", "/")}${t.dueTime ? " " + t.dueTime : ""}`;
}

const mkCtx = (d: DB, s: Settings): Ctx => makeCtx(d, s);

export function App(props: { key?: string | number; initialView?: ViewKey }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [db, setDb] = useState<DB | null>(null);
  const [view, setView] = useState<ViewKey>(props.initialView ?? DEFAULT_SETTINGS.defaultView);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [showToast, setShowToast] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const selection = useObservable<string[]>([]);

  const today = businessDay(new Date(), settings.todayResetHour);
  const ctx = useMemo(() => (db ? mkCtx(db, settings) : null), [db, settings, today]);

  const flash = useCallback((msg: string) => { setToastMsg(msg); setShowToast(true); }, []);

  /** 所有写路径都走 core.perform：撤销入栈 → 归约 → 落盘 → 副作用 → 切片 */
  const apply = useCallback((action: Action) => {
    if (!db) return;
    perform(action, { db, settings }).then((res) => {
      setDb(res.db);
      if (res.failures.length) flash(`${res.failures.length} 条同步到提醒事项失败，下次打开自动重试`);
      haptic(action.type === "complete" ? "success" : action.type === "trash" ? "error" : "impact", settings);
    });
  }, [db, settings, flash]);

  const undo = useCallback(() => {
    if (!db) return;
    const s = getStore(settings);
    const u = s.undo.undo(db);
    if (!u) { flash("没有可撤销的操作"); return; }
    s.saveDB(u.db);
    setDb(u.db);
    if (ctx) {
      writeSlice(widgetSlice(u.db, ctx));
      rescheduleAll(u.db, settings).then(() => {});
    }
    flash(`已撤销：${u.label}`);
  }, [db, ctx, settings, flash]);

  /** FR-901 导出：整库 JSON → Documents 目录 → ShareSheet */
  const exportBackup = useCallback(() => {
    const s = getStore(settings);
    const p = writeBackupFile(s.exportJSON(), today);
    if (!p) { flash("导出失败：写不出文件（检查脚本的文件权限）"); return; }
    shareFile(p).then((ok: boolean) => flash(ok ? `备份已生成：${p}` : `备份已写到 ${p}，分享面板没弹出来`));
  }, [settings, today, flash]);

  /** FR-901 导入：剪贴板里整份备份 JSON → normalizeDB → 落盘 → 重排通知 → 刷切片 */
  const importBackup = useCallback(() => {
    pasteboardJSON().then((text) => {
      if (!text) { flash("剪贴板里没有工作台备份 JSON（先把备份内容复制进去）"); return; }
      const s = getStore(settings);
      const r = s.importJSON(text);
      if (!r.ok || !r.db) { flash(`导入失败：${r.error ?? "结构不认识"}`); return; }
      const nextSettings = r.settings ?? settings;
      const nc = makeCtx(r.db, nextSettings);
      setSettings(nextSettings);
      setDb(r.db);
      writeSlice(widgetSlice(r.db, nc));
      rescheduleAll(r.db, nextSettings).then(() => {});
      flash(`已导入：${r.db.tasks.length} 条任务（原数据已被覆盖，撤销栈已重置）`);
    });
  }, [settings, flash]);

  /** 快捕：#项目 建档 + 任务入库合成一条撤销条目（perform 内已合并） */
  const submitDraft = useCallback(() => {
    if (!db || !ctx) return;
    const raw = draft.trim();
    if (!raw) return;
    const r = parse(raw, ctx.today);
    if (!r.title.trim()) { flash("标题被标记吃光了，请把文字写清楚一点"); return; }
    let working = db;
    let projectId: string | undefined;
    if (r.projectName) {
      working = reduce(working, { type: "ensureProject", name: r.projectName }, ctx).db;
      projectId = (working.projects.find((p) => p.name === r.projectName) || { id: undefined } as any).id;
    }
    const task = taskFromDraft({
      title: r.title, dueDate: r.dueDate, dueTime: r.dueTime, segment: r.segment, priority: r.priority,
      flagged: r.flagged, repeat: r.repeat, tags: r.tags, subtasks: r.subtasks, remindOffsetMin: r.remindOffsetMin,
    }, working, ctx, projectId);
    setDb(working);
    perform({ type: "add", task }, { db: working, settings }).then((res) => {
      setDb(res.db);
      if (res.failures.length) flash(`已添加，但 ${res.failures.length} 条同步提醒事项失败`);
    });
    haptic("success", settings);
    setDraft("");
    flash(`已添加：${task.title}`);
  }, [db, ctx, draft, settings, flash]);

  // —— 启动：读档 → 通知按钮回跳 → 每日重置 → 补排通知 → 权限 → 切片 ——
  useEffect(() => {
    (async () => {
      const s = getStore(DEFAULT_SETTINGS);
      const loaded = s.loadSettings();
      const loadedDB = s.loadDB();
      const c = mkCtx(loadedDB, loaded);
      setSettings(loaded);

      const q = (Script.queryParameters ?? {}) as Record<string, any>;
      const spotId = Spotlight.current && (Spotlight.current.parameters as any) && (Spotlight.current.parameters as any).openTask;
      const openId: string | undefined = (q.id as string) || (spotId as string) || undefined;

      const meta = s.loadMeta();
      const stepped = meta.lastBusinessDay !== c.today;
      const rolled = reduce(loadedDB, { type: "rollover" }, c);
      let working = rolled.db;
      const purged = reduce(working, { type: "purgeTrash" }, c);
      working = purged.db;
      s.saveDB(working);
      s.saveMeta({ lastBusinessDay: c.today, lastLaunchAt: c.now, lastReconcileAt: meta.lastReconcileAt });
      setDb(working);

      if (stepped) flash(`新的一天，今日已${loaded.todayResetMode === "reset" ? "清零" : "保留"}。${working.tasks.filter((t) => !t.done && t.dueDate && t.dueDate < c.today).length} 条逾期`);
      requestPermissions().then(() => {});
      rescheduleAll(working, loaded).then((n: number) => { if (stepped) writeSlice(widgetSlice(working, c)); void n; });

      // F5 reconcile：与系统提醒事项双向对齐（异步、不阻塞首屏；冲突时系统赢）
      if (working.tasks.some((t) => t.reminderSync && t.reminderSync !== "off")) {
        reconcile(working.tasks).then((r) => {
          const moved = r.completedLocally.length + r.completedInSystem.length + r.detached.length;
          s.saveDB(working);
          s.saveMeta({ lastBusinessDay: c.today, lastLaunchAt: c.now, lastReconcileAt: Date.now() });
          writeSlice(widgetSlice(working, c));
          // reconcile 是就地改 Task 对象，换新数组引用才能触发重渲染
          setDb({ ...working, tasks: working.tasks.slice() });
          if (moved) flash(`系统提醒事项有变动：${r.completedLocally.length} 条在系统里已勾掉，${r.detached.length} 条需重新同步`);
          // 需要重推的走副作用通道（reminder.push 内部 upsert 并回写 signature）
          if (r.needPush.length) {
            dispatch(r.needPush.map((id) => ({ kind: "reminder.push" as const, taskId: id })), working, loaded)
              .then(() => setDb({ ...working, tasks: working.tasks.slice() }));
          }
        }).catch(() => {});
      }

      // 通知按钮四态回跳（PRD FR-402）
      if (openId && working.tasks.some((t) => t.id === openId)) {
        const act = q.act;
        const map: Record<string, { action: Action; msg: string }> = {
          complete: { action: { type: "complete", id: openId }, msg: "已从通知完成" },
          tomorrow: { action: { type: "moveTomorrow", id: openId }, msg: "已改到明天" },
          snooze: { action: { type: "snooze", id: openId, minutes: Number(q.minutes) || 60 }, msg: `${Number(q.minutes) || 60} 分钟后再提醒` },
          drop: { action: { type: "trash", id: openId }, msg: "已放弃这条" },
        };
        const hit = map[act as string];
        if (hit) {
          perform(hit.action, { db: working, settings: loaded }).then((r) => { setDb(r.db); flash(hit.msg); });
        } else {
          setDetailId(openId);
        }
      }
    })();
  }, []);

  if (!db || !ctx) {
    return <VStack spacing={20}><Spacer /><Text foregroundStyle="secondaryLabel">正在载入工作台…</Text><Spacer /></VStack>;
  }

  const c = counts(db, ctx);
  const cAny = c as Record<string, number>;
  const filtered = (list: Task[]) => {
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((t) => t.title.toLowerCase().includes(q)
      || (t.notes ?? "").toLowerCase().includes(q)
      || t.tags.some((x) => x.toLowerCase().includes(q)));
  };
  const sel = (): string[] => {
    const v: any = (selection as any).value;
    return Array.isArray(v) ? v : v ? [v] : [];
  };
  const bulk = (kind: Action) => {
    const ids = sel();
    if (!ids.length) { flash("先点右上角编辑，勾选要批量处理的任务"); return; }
    apply({ type: "bulk", ids, action: kind });
    (selection as any).setValue([]);
    flash(`已对 ${ids.length} 条执行「${TYPE_LABEL[(kind as any).type] ?? (kind as any).type}」`);
  };
  const detail = detailId ? db.tasks.find((t) => t.id === detailId) : undefined;
  const viewKeys = Object.keys(VIEW_TITLE) as ViewKey[];

  return (
    <NavigationStack>
      <List
        listStyle="insetGroup"
        navigationTitle={VIEW_TITLE[view]}
        navigationBarTitleDisplayMode="inline"
        selection={selection as any}
        searchable={{ value: query, onChanged: setQuery, placement: "navigationBarDrawer", prompt: "搜标题、备注、#标签" }}
        toast={{ isPresented: showToast, onChanged: setShowToast, message: toastMsg, position: "bottom", duration: 2.5 }}
        sheet={detail ? {
          isPresented: true,
          onChanged: (v: boolean) => { if (!v) setDetailId(null); },
          content: <DetailView task={detail} db={db} ctx={ctx} apply={apply} onClose={() => setDetailId(null)} />,
        } : undefined}
        toolbar={{
          topBarLeading: <Menu title="视图" systemImage={VIEW_ICON[view]} primaryAction={() => setView("today")}>
            {viewKeys.map((k) => (
              <Button key={k} title={`${VIEW_TITLE[k]}${cAny[k] !== undefined ? ` · ${cAny[k]}` : ""}`} action={() => { setView(k); setQuery(""); }} />
            ))}
          </Menu>,
          topBarTrailing: [
            <Button key="undo" systemImage="arrow.uturn.backward" labelStyle="iconOnly" action={undo} />,
            <EditButton key="edit" />,
          ],
          bottomBar: <QuickCapture draft={draft} setDraft={setDraft} submit={submitDraft} chips={previewChips(draft, today)} />,
        }}
      >
        {sel().length > 0 && (
          <Section header={<Text>已选 {sel().length} 条</Text>}>
            <HStack spacing={6}>
              <Button title="完成" action={() => bulk({ type: "complete", id: "" })} />
              <Button title="今日" action={() => bulk({ type: "pickToday", id: "" })} />
              <Button title="旗标" action={() => bulk({ type: "toggleFlag", id: "" })} />
              <Button title="明天" action={() => bulk({ type: "moveTomorrow", id: "" })} />
              <Button title="删除" role="destructive" action={() => bulk({ type: "trash", id: "" })} />
            </HStack>
          </Section>
        )}

        {view === "today" && <TodaySection db={db} ctx={ctx} apply={apply} filtered={filtered} setDetail={setDetailId} />}
        {view === "inbox" && <TaskSection title={`收集箱 ${cAny.inbox ?? 0}`} items={filtered(inboxOf(db, ctx))} empty="收集箱已清空，去快捕记一条" db={db} ctx={ctx} apply={apply} setDetail={setDetailId} />}
        {view === "planned" && <PlannedSection db={db} ctx={ctx} apply={apply} filtered={filtered} setDetail={setDetailId} />}
        {view === "flagged" && <TaskSection title={`旗标 ${cAny.flagged ?? 0}`} items={filtered(sortList(db.tasks.filter((t) => !t.done && !t.trashedAt && t.flagged)))} empty="没有旗标任务" db={db} ctx={ctx} apply={apply} setDetail={setDetailId} />}
        {view === "projects" && <ProjectsSection db={db} ctx={ctx} apply={apply} filtered={filtered} setDetail={setDetailId} />}
        {view === "archive" && <ArchiveSection db={db} ctx={ctx} apply={apply} settings={settings} />}
        {view === "settings" && (
          <SettingsSection
            settings={settings}
            db={db}
            undoCount={getStore(settings).undo.size}
            onChange={(next) => { setSettings(next); getStore(next).saveSettings(next); rescheduleAll(db, next).then(() => {}); }}
            onClearCaches={() => { getStore(settings).clearCaches(); flash("缓存与撤销栈已清空"); }}
            onExport={exportBackup}
            onImport={importBackup}
          />
        )}
      </List>
    </NavigationStack>
  );
}

function previewChips(draft: string, today: string): string[] {
  const raw = draft.trim();
  if (!raw) return [];
  try { return chipsOf(parse(raw, today)); } catch { return []; }
}

// —— 快捕条（FR-201 / FR-202）——
function QuickCapture(props: { key?: string | number; draft: string; setDraft: (s: string) => void; submit: () => void; chips: string[] }) {
  return (
    <VStack alignment="leading" spacing={4}>
      {props.chips.length > 0 && (
        <HStack spacing={8}>
          {props.chips.map((chip, i) => <Text key={i} font="caption" foregroundStyle="systemBlue">{chip}</Text>)}
        </HStack>
      )}
      <HStack spacing={8}>
        <TextField
          title=""
          value={props.draft}
          prompt="记点什么… 支持 周五 19:00 #项目 @标签 !1 ^ /子任务"
          onChanged={props.setDraft}
          onSubmit={props.submit}
          axis="vertical"
        />
        <Button title="添加" buttonStyle="borderedProminent" action={props.submit} />
      </HStack>
      <Text font="caption2" foregroundStyle="tertiaryLabel">#项目 @标签 !1-4 ^旗标 /子任务 · 周三 19:00 · 提前30分钟 · 每天</Text>
    </VStack>
  );
}

// —— 任务行：左滑加入今日 / 旗标，右滑完成（整滑）/ 明天 / 删除 ——
function TaskRow(props: { key?: string | number; task: Task; ctx: Ctx; apply: (a: Action) => void; open: (id: string) => void; inTrash?: boolean }) {
  const t = props.task;
  const done = !!t.done;
  const inToday = t.inTodayOn === props.ctx.today;

  if (props.inTrash) {
    return (
      <HStack spacing={8}>
        <Image systemName="trash" foregroundStyle="tertiaryLabel" />
        <VStack alignment="leading" spacing={2}>
          <Text foregroundStyle="secondaryLabel">{t.title}</Text>
          <Text font="caption2" foregroundStyle="tertiaryLabel">{new Date(t.trashedAt ?? 0).toLocaleDateString()} 删除 · 30 天后自动清除</Text>
        </VStack>
        <Spacer />
        <Button title="恢复" action={() => props.apply({ type: "restore", id: t.id })} />
      </HStack>
    );
  }

  return (
    <HStack
      spacing={8}
      leadingSwipeActions={{
        allowsFullSwipe: false,
        actions: [
          <Button tint="systemBlue" action={() => props.apply({ type: inToday ? "unpick" : "pickToday", id: t.id } as Action)}>
            <Label title={inToday ? "退出今日" : "加入今日"} systemImage={inToday ? "sun.min" : "sun.max"} />
          </Button>,
          <Button tint="systemOrange" action={() => props.apply({ type: "toggleFlag", id: t.id })}>
            <Label title={t.flagged ? "取消旗标" : "旗标"} systemImage="flag" />
          </Button>,
        ],
      }}
      trailingSwipeActions={{
        allowsFullSwipe: true,
        actions: [
          <Button role="destructive" action={() => props.apply({ type: "trash", id: t.id })}>
            <Label title="删除" systemImage="trash" />
          </Button>,
          <Button tint="systemYellow" action={() => props.apply({ type: "moveTomorrow", id: t.id })}>
            <Label title="明天" systemImage="calendar" />
          </Button>,
          <Button tint="systemGreen" action={() => props.apply({ type: done ? "reopen" : "complete", id: t.id } as Action)}>
            <Label title={done ? "重开" : "完成"} systemImage="checkmark" />
          </Button>,
        ],
      }}
      contextMenu={{
        menuItems: <Group>
          <Button title="打开详情" action={() => props.open(t.id)} />
          <Button title={done ? "重新打开" : "完成"} action={() => props.apply({ type: done ? "reopen" : "complete", id: t.id } as Action)} />
          <Button title="加入今日" action={() => props.apply({ type: "pickToday", id: t.id })} />
          <Button title="稍后 1 小时" action={() => props.apply({ type: "snooze", id: t.id, minutes: 60 })} />
          <Button title="10 分钟后再提醒" action={() => props.apply({ type: "snooze", id: t.id, minutes: 10 })} />
          <Button title="移到收集箱" action={() => props.apply({ type: "setProject", id: t.id, projectId: undefined })} />
          <Button title="同步到提醒事项" action={() => props.apply({ type: "update", id: t.id, patch: { reminderSync: "pending" } })} />
          <Divider />
          <Button title="删除" role="destructive" action={() => props.apply({ type: "trash", id: t.id })} />
        </Group>,
      }}
    >
      <Button
        title=""
        systemImage={done ? "checkmark.circle.fill" : "circle"}
        tint={done ? "systemGreen" : priorityTint(t.priority) ?? "secondaryLabel"}
        labelStyle="iconOnly"
        action={() => props.apply({ type: done ? "reopen" : "complete", id: t.id } as Action)}
      />
      <VStack alignment="leading" spacing={2}>
        <HStack spacing={4}>
          {t.flagged && <Image systemName="flag.fill" foregroundStyle="systemOrange" />}
          <Text strikethrough={done} foregroundStyle={done ? "tertiaryLabel" : "label"}>{t.title}</Text>
        </HStack>
        <HStack spacing={6}>
          {!!t.priority && <Text font="caption2" foregroundStyle={priorityTint(t.priority)}>!{t.priority}</Text>}
          {!!dueText(t, props.ctx.today) && (
            <Text font="caption2" foregroundStyle={isOverdue(t, props.ctx.today) ? "systemRed" : "secondaryLabel"}>{dueText(t, props.ctx.today)}</Text>
          )}
          {!!t.repeat && <Text font="caption2" foregroundStyle="secondaryLabel">{repeatText(t.repeat)}</Text>}
          {!!subtaskProgress(t) && <Text font="caption2" foregroundStyle="secondaryLabel">✓{subtaskProgress(t)}</Text>}
          {t.reminderSync === "up" && <Image systemName="arrow.triangle.2.circlepath" foregroundStyle="tertiaryLabel" />}
          {t.reminderSync === "pending" && <Image systemName="exclamationmark.arrow.circlepath" foregroundStyle="systemYellow" />}
          {!!t.waitingFor && <Text font="caption2" foregroundStyle="systemPurple">等待 {t.waitingFor}</Text>}
        </HStack>
      </VStack>
      <Spacer />
      <Button title="" systemImage="ellipsis.circle" labelStyle="iconOnly" tint="tertiaryLabel" action={() => props.open(t.id)} />
    </HStack>
  );
}

type RowProps = { key?: string | number; db: DB; ctx: Ctx; apply: (a: Action) => void; setDetail: (id: string) => void };

function TaskSection(props: { title: string; items: Task[]; empty?: string; inTrash?: boolean; filtered?: (l: Task[]) => Task[] } & RowProps) {
  return (
    <Section header={<Text>{props.title}</Text>} footer={props.items.length > 0 ? <Text>左滑加入今日 · 右滑完成 · 长按看更多</Text> : undefined}>
      {props.items.length === 0 && <Text foregroundStyle="tertiaryLabel">{props.empty ?? "这里很干净"}</Text>}
      {props.items.map((t) => (
        <TaskRow key={t.id} task={t} ctx={props.ctx} apply={props.apply} open={props.setDetail} inTrash={props.inTrash} />
      ))}
    </Section>
  );
}

function TodaySection(props: { filtered: (l: Task[]) => Task[] } & RowProps) {
  const v = todayView(props.db, props.ctx);
  const common = { db: props.db, ctx: props.ctx, apply: props.apply, setDetail: props.setDetail };
  const pinned = props.filtered(v.pinned);
  const overdue = props.filtered(v.overdue);
  const scheduled = props.filtered(v.scheduled.filter((t) => !t.flagged));
  const evening = props.filtered(v.evening);
  const total = pinned.length + overdue.length + scheduled.length;
  return (
    <>
      {pinned.length > 0 && <TaskSection title={`旗标置顶 ${pinned.length}`} items={pinned} {...common} />}
      {overdue.length > 0 && <TaskSection title={`已逾期 ${overdue.length}`} items={overdue} {...common} />}
      <TaskSection title={`今日 ${total - pinned.length - overdue.length + overdue.length}`} items={scheduled} empty="今天没有待办，去收集箱挑几条" {...common} />
      {evening.length > 0 && <TaskSection title={`晚上 ${evening.length}`} items={evening} {...common} />}
    </>
  );
}

function PlannedSection(props: { filtered: (l: Task[]) => Task[] } & RowProps) {
  const groups = plannedGroups(props.db, props.ctx).map((g) => ({ ...g, items: props.filtered(g.items) })).filter((g) => g.items.length > 0);
  const someday = props.filtered(somedayList(props.db, props.ctx));
  if (!groups.length && !someday.length) {
    return <Section header={<Text>计划</Text>}><Text foregroundStyle="tertiaryLabel">没有安排日期的任务</Text></Section>;
  }
  return (
    <>
      {groups.map((g) => <TaskSection key={g.bucket} title={`${BUCKET_LABEL[g.bucket]} ${g.items.length}`} items={g.items} {...props} />)}
      {someday.length > 0 && <TaskSection title={`某天 ${someday.length}`} items={someday} {...props} />}
    </>
  );
}

function somedayList(db: DB, ctx: Ctx): Task[] {
  return sortList(db.tasks.filter((t) => !t.done && !t.trashedAt && !t.dueDate && t.segment === "someday" && t.inTodayOn !== ctx.today));
}

function ProjectsSection(props: { filtered: (l: Task[]) => Task[] } & RowProps) {
  const projects = [...props.db.projects].sort((a, b) => a.order - b.order);
  return (
    <>
      <Section header={<Text>项目</Text>} footer={<Text>快捕里写 #新项目名 即可自动建档</Text>}>
        {projects.length === 0 && <Text foregroundStyle="tertiaryLabel">还没有项目</Text>}
        {projects.map((p: Project) => {
          const items = props.filtered(props.db.tasks.filter((t) => t.projectId === p.id && !t.done && !t.trashedAt));
          const doneCount = props.db.tasks.filter((t) => t.projectId === p.id && t.done).length;
          return (
            <DisclosureGroup key={p.id} header={<Text>{p.name} · {items.length} 待办 / {doneCount} 完成</Text>}>
              {items.map((t) => <TaskRow task={t} ctx={props.ctx} apply={props.apply} open={props.setDetail} />)}
              {items.length === 0 && <Text foregroundStyle="tertiaryLabel">空项目</Text>}
            </DisclosureGroup>
          );
        })}
      </Section>
      <Section header={<Text>领域</Text>}>
        {props.db.areas.length === 0 && <Text foregroundStyle="tertiaryLabel">未使用领域</Text>}
        {props.db.areas.map((a: Area) => (
          <Text key={a.id}>{a.name} · {props.db.projects.filter((p) => p.areaId === a.id).length} 个项目</Text>
        ))}
      </Section>
    </>
  );
}

function ArchiveSection(props: { db: DB; ctx: Ctx; apply: (a: Action) => void; settings: Settings }) {
  const items = trashOf(props.db);
  const recentDone = props.db.tasks.filter((t) => t.done && t.completedAt && props.ctx.now - t.completedAt < 3 * 86400000).slice(-10).reverse();
  return (
    <>
      <Section header={<Text>回收站</Text>} footer={<Text>保留 {props.settings.archiveKeepDays} 天，之后自动清除</Text>}>
        {items.length === 0 && <Text foregroundStyle="tertiaryLabel">回收站是空的</Text>}
        {items.map((t) => <TaskRow key={t.id} task={t} ctx={props.ctx} apply={props.apply} open={() => {}} inTrash />)}
        {items.length > 0 && <Button title="立即清空回收站" role="destructive" action={() => props.apply({ type: "purgeTrash" })} />}
      </Section>
      <Section header={<Text>最近完成</Text>}>
        {recentDone.length === 0 && <Text foregroundStyle="tertiaryLabel">近 3 天没有完成记录</Text>}
        {recentDone.map((t) => (
          <HStack key={t.id} spacing={8}>
            <Image systemName="checkmark.circle.fill" foregroundStyle="systemGreen" />
            <Text foregroundStyle="secondaryLabel">{t.title}</Text>
            <Spacer />
            <Text font="caption2" foregroundStyle="tertiaryLabel">{new Date(t.completedAt ?? 0).toLocaleString()}</Text>
            <Button title="重开" action={() => props.apply({ type: "reopen", id: t.id })} />
          </HStack>
        ))}
      </Section>
    </>
  );
}

// —— 详情（sheet 内容，FR-401）——
function DetailView(props: { key?: string | number; task: Task; db: DB; ctx: Ctx; apply: (a: Action) => void; onClose: () => void }) {
  const t = props.task;
  const [note, setNote] = useState(t.notes ?? "");
  const [sub, setSub] = useState("");
  const segText: Record<string, string> = { today: "今天", evening: "晚上", date: "有日期", someday: "某天" };
  const addSub = () => {
    const v = sub.trim();
    if (!v) return;
    props.apply({ type: "addSubtask", id: t.id, title: v });
    setSub("");
  };
  return (
    <VStack
      alignment="leading"
      spacing={10}
      presentationDragIndicator="visible"
      presentationDetents={["medium", "large"]}
    >
      <HStack spacing={8}>
        <Button title="" systemImage={t.flagged ? "flag.fill" : "flag"} tint="systemOrange" labelStyle="iconOnly" action={() => props.apply({ type: "toggleFlag", id: t.id })} />
        <Text font="headline">{t.title}</Text>
      </HStack>

      <HStack spacing={6}>
        <Button title={t.done ? "重新打开" : "完成"} buttonStyle="borderedProminent" action={() => props.apply({ type: t.done ? "reopen" : "complete", id: t.id } as Action)} />
        <Button title="加入今日" action={() => props.apply({ type: "pickToday", id: t.id })} />
        <Button title="明天" action={() => props.apply({ type: "moveTomorrow", id: t.id })} />
        <Button title="稍后 1 小时" action={() => props.apply({ type: "snooze", id: t.id, minutes: 60 })} />
        <Button title="完成并关闭" role="confirm" action={() => { props.apply({ type: "complete", id: t.id }); props.onClose(); }} />
      </HStack>

      <Divider />

      <HStack spacing={6}>
        {([1, 2, 3, 4] as Priority[]).map((p) => (
          <Button key={p} title={`!${p}`} tint={priorityTint(p)} action={() => props.apply({ type: "setPriority", id: t.id, priority: p })} />
        ))}
        <Button title="无" action={() => props.apply({ type: "setPriority", id: t.id, priority: undefined })} />
      </HStack>

      <Menu title={`时间段：${t.segment ? segText[t.segment] ?? t.segment : "未定"}`} systemImage="clock" primaryAction={() => {}}>
        {(["today", "evening", "someday"] as const).map((sg) => (
          <Button key={sg} title={segText[sg]} action={() => props.apply({ type: "setSegment", id: t.id, segment: sg })} />
        ))}
        <Button title="清除日期" action={() => props.apply({ type: "clearDue", id: t.id })} />
      </Menu>

      <Menu title={`重复：${repeatText(t.repeat) || "不重复"}`} systemImage="arrow.2.circlepath" primaryAction={() => {}}>
        <Button title="不重复" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: undefined })} />
        <Button title="每天" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: { freq: "daily", mode: "fromDue" } })} />
        <Button title="每个工作日" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: { freq: "weekday", mode: "fromDue" } })} />
        <Button title="每周一" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: { freq: "weekly", weekdays: [1], mode: "fromDue" } })} />
        <Button title="每周五" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: { freq: "weekly", weekdays: [5], mode: "fromDue" } })} />
        <Button title="每月" action={() => props.apply({ type: "setRepeat", id: t.id, repeat: { freq: "monthday", mode: "fromDue" } })} />
      </Menu>

      <Menu title={`项目：${props.db.projects.find((p) => p.id === t.projectId)?.name ?? "收集箱"}`} systemImage="square.grid.2x2" primaryAction={() => {}}>
        <Button title="收集箱（无项目）" action={() => props.apply({ type: "setProject", id: t.id, projectId: undefined })} />
        {props.db.projects.map((p) => <Button key={p.id} title={p.name} action={() => props.apply({ type: "setProject", id: t.id, projectId: p.id })} />)}
      </Menu>

      <HStack spacing={8}>
        <Toggle
          title="同步到系统提醒事项"
          value={t.reminderSync !== "off"}
          onChanged={(v: boolean) => props.apply({ type: "update", id: t.id, patch: { reminderSync: v ? "pending" : "off" } })}
        />
        <Text font="caption2" foregroundStyle="tertiaryLabel">{{ off: "不同步", up: "已同步", pending: "待同步" }[t.reminderSync ?? "off"]}</Text>
      </HStack>

      <Divider />

      {t.subtasks.map((s) => (
        <HStack key={s.id} spacing={8}>
          <Button title="" systemImage={s.done ? "checkmark.circle.fill" : "circle"} labelStyle="iconOnly" tint={s.done ? "systemGreen" : "tertiaryLabel"} action={() => props.apply({ type: "toggleSubtask", id: t.id, subId: s.id })} />
          <Text strikethrough={s.done} foregroundStyle={s.done ? "tertiaryLabel" : "label"}>{s.title}</Text>
          <Spacer />
          <Button title="" systemImage="minus.circle" labelStyle="iconOnly" tint="tertiaryLabel" action={() => props.apply({ type: "removeSubtask", id: t.id, subId: s.id })} />
        </HStack>
      ))}
      <HStack spacing={8}>
        <TextField title="" value={sub} prompt="新子任务" onChanged={setSub} onSubmit={addSub} />
        <Button title="加" action={addSub} />
      </HStack>
      {t.subtasks.length > 0 && <ProgressView value={t.subtasks.filter((s) => s.done).length} total={t.subtasks.length} />}

      <TextField title="备注" value={note} axis="vertical" onChanged={setNote} onSubmit={() => props.apply({ type: "update", id: t.id, patch: { notes: note } })} />

      <Text font="caption2" foregroundStyle="tertiaryLabel">
        创建 {new Date(t.createdAt).toLocaleString()}
        {t.scheduledAt ? ` · 提醒 ${new Date(t.scheduledAt).toLocaleString()}` : ""}
        {t.tags.length ? ` · ${t.tags.map((x) => "@" + x).join(" ")}` : ""}
      </Text>

      <HStack spacing={8}>
        <Button title="关闭" action={props.onClose} />
        <Button title="删除" role="destructive" action={() => { props.apply({ type: "trash", id: t.id }); props.onClose(); }} />
      </HStack>
    </VStack>
  );
}

function SettingsSection(props: {
  key?: string | number;
  settings: Settings; db: DB; undoCount: number;
  onChange: (s: Settings) => void; onClearCaches: () => void;
  onExport: () => void; onImport: () => void;
}) {
  const s = props.settings;
  const set = (patch: Partial<Settings>) => props.onChange({ ...s, ...patch });
  const slice = readSlice<any>();
  const synced = props.db.tasks.filter((t) => t.reminderSync === "up").length;
  const waiting = props.db.tasks.filter((t) => t.reminderSync === "pending").length;
  return (
    <>
      <Section header={<Text>时间与视图</Text>}>
        <Menu title={`默认视图：${VIEW_TITLE[s.defaultView]}`} systemImage="rectangle.grid.1x2" primaryAction={() => {}}>
          {(["today", "inbox", "planned", "projects", "flagged"] as ViewKey[]).map((k) => (
            <Button key={k} title={VIEW_TITLE[k]} action={() => set({ defaultView: k })} />
          ))}
        </Menu>
        <Menu title={`每日重置：${s.todayResetMode === "reset" ? "清零" : "保留"}`} systemImage="sun.min" primaryAction={() => {}}>
          <Button title="清零（Things 式）" action={() => set({ todayResetMode: "reset" })} />
          <Button title="保留（滴答式）" action={() => set({ todayResetMode: "keep" })} />
        </Menu>
        <HStack spacing={6}>
          <Text foregroundStyle="secondaryLabel">业务日切换：</Text>
          {[2, 3, 4, 5].map((h) => <Button key={h} title={`${h}:00`} tint={s.todayResetHour === h ? "accentColor" : "secondaryLabel"} action={() => set({ todayResetHour: h })} />)}
        </HStack>
        <Toggle title="全天任务也在 9 点提醒" value={s.allDayNotifyEnabled} onChanged={(v: boolean) => set({ allDayNotifyEnabled: v })} />
      </Section>

      <Section header={<Text>触感与滑动</Text>}>
        <Menu title={`触感：${{ auto: "自动", on: "总是", off: "关闭" }[s.haptics]}`} systemImage="iphone.radiowaves.left.and.right" primaryAction={() => {}}>
          <Button title="自动" action={() => set({ haptics: "auto" })} />
          <Button title="总是" action={() => set({ haptics: "on" })} />
          <Button title="关闭" action={() => set({ haptics: "off" })} />
        </Menu>
        <Text foregroundStyle="secondaryLabel">左滑：{s.swipeActions.leading.map((k) => ACTION_POOL[k]).join(" / ")}</Text>
        <Text foregroundStyle="secondaryLabel">右滑：{s.swipeActions.trailing.map((k) => ACTION_POOL[k]).join(" / ")}（整滑 = {ACTION_POOL[s.swipeActions.fullSwipe]}）</Text>
        <Toggle title="循环催办（未处理的任务反复提醒）" value={s.nagRepeat} onChanged={(v: boolean) => set({ nagRepeat: v })} />
      </Section>

      <Section header={<Text>小组件与系统入口</Text>}>
        <Menu title={`小组件尺寸：${s.widgetFamily}`} systemImage="square.on.square" primaryAction={() => {}}>
          {(["systemSmall", "systemMedium", "systemLarge"] as const).map((f) => <Button key={f} title={f} action={() => set({ widgetFamily: f })} />)}
        </Menu>
        <Toggle title="写入当日切片供小组件读取" value={s.widgetSliceEnabled} onChanged={(v: boolean) => set({ widgetSliceEnabled: v })} />
        <Text foregroundStyle="tertiaryLabel">切片：{slice ? `${slice.total ?? 0} 条 / 已完成 ${slice.done ?? 0}` : "尚未生成"}</Text>
        <Text foregroundStyle="tertiaryLabel">长按主屏 → 添加小组件 → 搜索「{s.scriptName}」</Text>
      </Section>

      <Section header={<Text>系统同步</Text>} footer={<Text>只有打开同步开关的任务才会写进 iOS 提醒事项</Text>}>
        <Text>已同步 {synced} 条{waiting ? ` · 待推送 ${waiting} 条` : ""}</Text>
        <Button title="立即重排全部通知" action={() => { rescheduleAll(props.db, s).then((n: number) => props.onChange({ ...s })); void 0; }} />
      </Section>

      <Section header={<Text>数据</Text>} footer={<Text>备份只写本地文件，不上传任何远端（NFR-4）。导入用「先复制备份 JSON，再点下面的按钮」这种方式，因为系统文件选择器在脚本环境里不可靠。</Text>}>
        <Text>任务 {props.db.tasks.length} 条 · 撤销栈 {props.undoCount} 步</Text>
        <Button title="导出备份 JSON（ShareSheet）" action={props.onExport} />
        <Button title="从剪贴板导入（覆盖当前数据）" action={props.onImport} />
        <Button title="清空缓存与撤销栈" action={props.onClearCaches} />
      </Section>
    </>
  );
}

// —— 入口 ——
const qp = (Script.queryParameters ?? {}) as Record<string, any>;
const startView: ViewKey = qp.view === "inbox" ? "inbox" : DEFAULT_SETTINGS.defaultView;
Navigation.present({ element: <App initialView={startView} /> });
Script.exit();
