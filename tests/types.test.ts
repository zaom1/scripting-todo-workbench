// 数据层纯函数单测：重复排期是 PRD FR-502 的硬性验收点（连续 3 次必须落在 3 个不同日子）。
import { addDays, businessDay, isOverdue, nextOccurrence, parseYmd, subtaskProgress, ymd, isoWeekday, type Task } from "../types";

let pass = 0;
const fails: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name}\n     期望 ${e}\n     实际 ${a}`);
}

const T = (over: Partial<Task> = {}): Task => ({
  id: "x", title: "t", tags: [], subtasks: [], done: false, flagged: false, order: 0, createdAt: 0, ...over,
} as Task);

// —— 日期工具 ——
eq("ymd 补零", ymd(new Date(2026, 0, 5)), "2026-01-05");
eq("parseYmd 不回跳时区", parseYmd("2026-10-20").getDate(), 20);
eq("addDays 跨月", addDays("2026-10-31", 1), "2026-11-01");
eq("addDays 跨年", addDays("2026-12-31", 1), "2027-01-01");
eq("addDays 负数", addDays("2026-01-01", -1), "2025-12-31");
eq("isoWeekday 周日=7", isoWeekday(parseYmd("2026-10-25")), 7);
eq("isoWeekday 周一=1", isoWeekday(parseYmd("2026-10-20")), 2);

// —— 重复规则：每周三，从 10-21(周三) 起应得 10-28 ——
eq("weekly 下一个周三",
  nextOccurrence({ freq: "weekly", weekdays: [3], mode: "fromDue" }, T({ dueDate: "2026-10-21" }), "2026-10-21"),
  "2026-10-28");

// FR-502：连续 3 次落在 3 个不同的日子，且都是周三
{
  const seen: string[] = [];
  let cur = T({ dueDate: "2026-10-21" });
  for (let i = 0; i < 3; i++) {
    const next = nextOccurrence({ freq: "weekly", weekdays: [3], mode: "fromDue" }, cur, seen.length ? seen[seen.length - 1] : "2026-10-21")!;
    seen.push(next);
    cur = { ...cur, dueDate: next };
  }
  eq("weekly 三连不重复", new Set(seen).size, 3);
  eq("weekly 三连全是周三", seen.map((d) => isoWeekday(parseYmd(d))), [3, 3, 3]);
  eq("weekly 三连间隔 7 天", [addDays(seen[0], 7), addDays(seen[1], 7)], [seen[1], seen[2]]);
}

eq("daily", nextOccurrence({ freq: "daily", mode: "fromDue" }, T({ dueDate: "2026-10-20" }), "2026-10-20"), "2026-10-21");
eq("daily interval 3", nextOccurrence({ freq: "daily", interval: 3, mode: "fromDue" }, T({ dueDate: "2026-10-20" }), "2026-10-20"), "2026-10-23");
eq("interval 每7天", nextOccurrence({ freq: "interval", interval: 7, mode: "fromDue" }, T({ dueDate: "2026-10-20" }), "2026-10-20"), "2026-10-27");

// 工作日：周五完成 → 下周一
eq("weekday 周五跳过周末", nextOccurrence({ freq: "weekday", mode: "fromDue" }, T({ dueDate: "2026-10-23" }), "2026-10-23"), "2026-10-26");
eq("weekday 周四→周五", nextOccurrence({ freq: "weekday", mode: "fromDue" }, T({ dueDate: "2026-10-22" }), "2026-10-22"), "2026-10-23");

// 每月：10-15 → 11-15
eq("monthday 下月同日", nextOccurrence({ freq: "monthday", mode: "fromDue" }, T({ dueDate: "2026-10-15" }), "2026-10-15"), "2026-11-15");
// 1-31 → 2 月没有 31 号，退到月末，不能溢到 3 月
eq("monthday 月末钳制", nextOccurrence({ freq: "monthday", mode: "fromDue" }, T({ dueDate: "2026-01-31" }), "2026-01-31"), "2026-02-28");

// fromCompletion：起算点用「今天（完成日）」而不是 dueDate
eq("fromCompletion 以完成日起算",
  nextOccurrence({ freq: "daily", mode: "fromCompletion" }, T({ dueDate: "2026-10-01" }), "2026-10-20"),
  "2026-10-21");

// —— 视图谓词 ——
eq("isOverdue 昨天未完成", isOverdue(T({ dueDate: "2026-10-19" }), "2026-10-20"), true);
eq("isOverdue 今天不算过期", isOverdue(T({ dueDate: "2026-10-20" }), "2026-10-20"), false);
eq("isOverdue 已完成不算", isOverdue(T({ dueDate: "2026-10-19", done: true }), "2026-10-20"), false);
eq("isOverdue 无日期不算", isOverdue(T({}), "2026-10-20"), false);
eq("子任务进度", subtaskProgress(T({ subtasks: [{ id: "a", title: "x", done: true, order: 0 }, { id: "b", title: "y", done: false, order: 1 }] })), "1/2");
eq("无子任务返回空串", subtaskProgress(T({})), "");

eq("businessDay 默认 4 点界", businessDay(new Date(2026, 9, 20, 0, 30), 4), "2026-10-19");
eq("businessDay 自定义 6 点界", businessDay(new Date(2026, 9, 20, 5, 0), 6), "2026-10-19");

console.log(`\ntypes: ${pass} 通过 / ${pass + fails.length} 断言`);
if (fails.length) {
  console.log("失败：\n - " + fails.join("\n - ") + "\n");
  process.exit(1);
}
