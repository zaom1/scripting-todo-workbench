// 自然语言解析器（PRD FR-201）。纯函数、无外部依赖，可在 Node 里跑单测。
// 约定：解析失败的片段一律保留在标题里，绝不吞字（PRD 6.2 边界）。
import { Priority, RepeatRule, Segment, addDays, businessDay, isoWeekday, parseYmd, ymd } from "./types";

export interface ParseResult {
  title: string;
  segment?: Segment;
  dueDate?: string;
  dueTime?: string;
  projectName?: string;
  tags: string[];
  priority?: Priority;
  flagged: boolean;
  repeat?: RepeatRule;
  /** 提前 N 分钟提醒（「提前30分钟」） */
  remindOffsetMin?: number;
  subtasks: string[];
  /** 供 FR-202 预览条展示的 chip */
  chips: string[];
}

const WEEK_CHARS: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7,
};

const NUM: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
};

function toNum(s: string): number | undefined {
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  return NUM[s];
}

function hhmm(h: number, m: number): string {
  return `${`${Math.max(0, Math.min(23, h))}`.padStart(2, "0")}:${`${m}`.padStart(2, "0")}`;
}

/** 结构化标记：#项目 @标签 !优先级 ^旗标 /子任务 */
function extractStructural(raw: string, out: ParseResult): string {
  let s = raw;

  s = s.replace(/(?:^|\s)\/([^\s/]+)/g, (_m, t: string) => {
    out.subtasks.push(t.trim());
    return " ";
  });

  s = s.replace(/#([^\s!@#^]+)/g, (_m, t: string) => {
    out.projectName = t;
    return " ";
  });

  s = s.replace(/@([^\s!@#^]+)/g, (_m, t: string) => {
    if (!out.tags.includes(t)) out.tags.push(t);
    return " ";
  });

  s = s.replace(/(?:^|\s)!([1-4])(?=\s|$)/g, (_m, p: string) => {
    out.priority = parseInt(p, 10) as Priority;
    return " ";
  });

  s = s.replace(/(?:^|\s)\^(?=\s|$)/g, () => {
    out.flagged = true;
    return " ";
  });

  s = s.replace(/提前\s*(\d+|[一二两三四五六七八九十]+)\s*分钟(?:提醒)?/g, (_m, n: string) => {
    const v = toNum(n);
    if (v !== undefined) out.remindOffsetMin = v;
    return " ";
  });

  return s;
}

/** 重复规则（必须在「周X」之前匹配，否则「每周三」会被当成日期） */
function extractRepeat(s: string, out: ParseResult, today: string): string {
  let r = s;

  r = r.replace(/(?:^|\s)(每\s*(\d+|[一二两三四五六七八九十]+))\s*天/g, (_m, _t: string, n: string) => {
    const v = toNum(n) ?? 7;
    out.repeat = { freq: "interval", interval: v, mode: "fromDue" };
    out.chips.push(`每${v}天`);
    return " ";
  });

  r = r.replace(/(?:^|\s)(每个?工作日)(?=\s|$)/g, (_m, t: string) => {
    out.repeat = { freq: "weekday", mode: "fromDue" };
    out.chips.push("工作日");
    return " ";
  });

  r = r.replace(/(?:^|\s)(每天|每日)(?=\s|$)/g, (_m, t: string) => {
    out.repeat = { freq: "daily", mode: "fromDue" };
    out.chips.push("每天");
    return " ";
  });

  r = r.replace(/(?:^|\s)(每\s*月)(\d{1,2}|[一二两三四五六七八九十]+)?\s*(号|日)?(?=\s|$)/g, (_m, _t: string, d: string) => {
    const day = d ? toNum(d) : parseYmd(today).getDate();
    const base = parseYmd(today);
    const target = new Date(base.getFullYear(), day && day <= base.getDate() ? base.getMonth() + 1 : base.getMonth(), day ?? base.getDate());
    out.dueDate = ymd(target);
    out.segment = "date";
    out.repeat = { freq: "monthday", mode: "fromDue" };
    out.chips.push(`每月${day ?? base.getDate()}号`);
    return " ";
  });

  r = r.replace(/(?:^|\s)(每\s*(下{1,2})?周|每\s*星期|每\s*礼拜)\s*([一二三四五六日天])/g, (_m, _t: string, _x: string, w: string) => {
    const wd = WEEK_CHARS[w];
    out.repeat = { freq: "weekly", weekdays: [wd], mode: "fromDue" };
    out.dueDate = nextWeekday(today, wd);
    out.segment = "date";
    out.chips.push(`每周${w}`);
    return " ";
  });

  return r;
}

function nextWeekday(today: string, wd: number, offsetWeeks: number = 0): string {
  const cur = isoWeekday(parseYmd(today));
  let delta = (wd - cur + 7) % 7;
  if (delta === 0) delta = 7; // 「周三」在周三当天指下一周（PRD 6.2：取最近的未来日期，不含今天）
  return addDays(today, delta + offsetWeeks * 7);
}

/** 日期与时间 */
function extractDateTime(s: string, out: ParseResult, today: string): string {
  let r = s;

  // N 天后 / N 周后
  r = r.replace(/(\d+|[一二两三四五六七八九十]+)\s*(天|周|个?月)后/g, (_m, n: string, unit: string) => {
    const v = toNum(n) ?? 1;
    const step = unit.startsWith("周") ? v * 7 : unit.includes("月") ? v * 30 : v;
    out.dueDate = addDays(today, step);
    out.segment = "date";
    out.chips.push(`${v}${unit.startsWith("周") ? "周" : unit.includes("月") ? "个月" : "天"}后`);
    return " ";
  });

  // 大后天 / 后天 / 明天 / 今天
  r = r.replace(/(?:^|\s)(大后天|后天|明晚|明天|今晚|今天|今日)(?=\s|$)/g, (_m, t: string) => {
    if (t === "大后天") { out.dueDate = addDays(today, 3); out.segment = "date"; }
    else if (t === "后天") { out.dueDate = addDays(today, 2); out.segment = "date"; }
    else if (t === "明天") { out.dueDate = addDays(today, 1); out.segment = "date"; }
    else if (t === "明晚") { out.dueDate = addDays(today, 1); out.segment = "date"; out.dueTime = out.dueTime ?? "20:00"; }
    else if (t === "今晚") { out.dueDate = today; out.segment = "evening"; out.dueTime = out.dueTime ?? "20:00"; }
    else { out.dueDate = today; out.segment = "today"; }
    out.chips.push(t);
    return " ";
  });

  // 下下周三 / 下周三 / 这周三 / 周三 / 星期三 / 礼拜三
  r = r.replace(/(?:^|\s)(下下|下|这|本)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/g, (_m, pre: string, w: string) => {
    const weeks = pre === "下下" ? 2 : pre === "下" ? 1 : 0;
    out.dueDate = nextWeekday(today, WEEK_CHARS[w], weeks);
    out.segment = "date";
    out.chips.push(`${pre ?? ""}周${w}`);
    return " ";
  });

  // 10月25日 / 10-25 / 10/25
  r = r.replace(/(?:^|\s)(\d{1,2})\s*[月\-/\.]\s*(\d{1,2})\s*[日号]?(?=\s|$)/g, (_m, mm: string, dd: string) => {
    const m = parseInt(mm, 10), d = parseInt(dd, 10);
    if (m < 1 || m > 12 || d < 1 || d > 31) return _m;
    const base = parseYmd(today);
    let cand = new Date(base.getFullYear(), m - 1, d);
    if (cand.getTime() < base.getTime()) cand = new Date(base.getFullYear() + 1, m - 1, d);
    out.dueDate = ymd(cand);
    out.segment = "date";
    out.chips.push(`${m}月${d}日`);
    return " ";
  });

  // 冒号时刻：19:00 / 下午3:20 / 7：45
  r = r.replace(/(?:^|\s)(早上|上午|中午|下午|晚上|傍晚|晚|早)?\s*(\d{1,2})\s*[:：]\s*(\d{1,2})(?=\s|$)/g,
    (_m, meridiem: string, hh: string, mm: string) => {
      const h = parseInt(hh, 10), mnt = parseInt(mm, 10);
      if (mnt > 59) return _m;
      let hour = h;
      const md = (meridiem ?? "").trim();
      if ((md === "下午" || md === "晚上" || md === "晚" || md === "傍晚") && hour < 12) hour += 12;
      if (hour === 12 && (md === "早上" || md === "上午" || md === "早")) hour = 0;
      out.dueTime = hhmm(hour, mnt);
      if (!out.segment) out.segment = out.dueDate ? "date" : "today";
      out.chips.push(out.dueTime);
      return " ";
    });

  // 时间：19:00 / 7点 / 晚上7点半 / 下午3点20
  r = r.replace(
    /(?:^|\s)(早上|上午|中午|下午|晚上|傍晚|晚|早)?\s*(\d{1,2}|十一|十二|[一二两三四五六七八九十])\s*[点时](:|：)?(\d{1,2})?(半)?/g,
    (_m, meridiem: string, num: string, colon: string, minute: string, half: string) => {
      const h = toNum(num.trim());
      if (h === undefined) return _m;
      // 只有带冒号/分钟/时段词时才当时间，避免把「3个方法」这类吞掉
      const looksLikeTime = !!colon || !!minute || !!half || !!meridiem || h >= 13;
      if (!looksLikeTime) return _m;
      let hour = h;
      const md = (meridiem ?? "").trim();
      if ((md === "下午" || md === "晚上" || md === "晚" || md === "傍晚") && hour < 12) hour += 12;
      if (hour === 12 && (md === "早上" || md === "上午" || md === "早")) hour = 0;
      const mnt = half ? 30 : minute ? parseInt(minute, 10) : 0;
      out.dueTime = hhmm(hour, mnt);
      if (!out.segment) out.segment = out.dueDate ? "date" : "today";
      out.chips.push(out.dueTime);
      return " ";
    },
  );

  return r;
}

export function parse(rawInput: string, today: string = businessDay()): ParseResult {
  const out: ParseResult = {
    title: rawInput.trim(),
    tags: [],
    flagged: false,
    subtasks: [],
    chips: [],
  };

  let s = extractStructural(rawInput, out);
  s = extractRepeat(s, out, today);
  s = extractDateTime(s, out, today);

  // 「明天」只给日期不给 segment=today；有显式时间则保持 date
  if (out.dueDate === today && !out.dueTime && out.segment === "date") out.segment = "today";
  if (out.dueDate && out.dueDate > today) out.segment = "date";
  if (!out.dueDate && out.dueTime) { out.dueDate = today; out.segment = "today"; }

  out.title = s.replace(/\s+/g, " ").trim();
  return out;
}

/** 把解析结果渲染成 chip 文本（FR-202 预览条） */
export function chipsOf(r: ParseResult): string[] {
  const c: string[] = [];
  if (r.dueDate || r.segment === "someday") c.push(`📅${r.dueDate ?? "无日期"}`);
  if (r.dueTime) c.push(`⏰${r.dueTime}`);
  if (r.repeat) c.push(`🔁${r.repeat.freq}`);
  if (r.projectName) c.push(`#${r.projectName}`);
  r.tags.forEach((t) => c.push(`@${t}`));
  if (r.priority) c.push(`!${r.priority}`);
  if (r.flagged) c.push("⚑");
  if (r.remindOffsetMin) c.push(`提前${r.remindOffsetMin}分`);
  if (r.subtasks.length) c.push(`↳${r.subtasks.length} 子任务`);
  return c;
}
