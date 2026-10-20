// 解析器单测：tsc 编译后在 Node 里跑。失败即非零退出。
import { parse } from "../parse";
import { businessDay } from "../types";

let pass = 0;
const fails: string[] = [];

function eq(name: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; return; }
  fails.push(`${name}\n     期望 ${e}\n     实际 ${a}`);
}

// 固定「今天」= 2026-10-20（周二），避免用例随日期漂移
const TODAY = "2026-10-20";
const P = (s: string) => parse(s, TODAY);

eq("纯文本不吞字", P("买猫粮").title, "买猫粮");
eq("纯文本无副作用", [P("买猫粮").dueDate, P("买猫粮").priority, P("买猫粮").tags], [undefined, undefined, []]);

eq("完整语法-标题剥离", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").title, "给妈妈打电话");
eq("完整语法-日期", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").dueDate, "2026-10-23");
eq("完整语法-时间", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").dueTime, "19:00");
eq("完整语法-项目", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").projectName, "家庭");
eq("完整语法-标签", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").tags, ["重要"]);
eq("完整语法-优先级", P("周五 19:00 给妈妈打电话 #家庭 @重要 !1").priority, 1);

eq("明天", P("明天 交报销").dueDate, "2026-10-21");
eq("后天", P("后天 体检").dueDate, "2026-10-22");
eq("大后天", P("大后天 出差").dueDate, "2026-10-23");
eq("今天→segment today", [P("今天 写周报").dueDate, P("今天 写周报").segment], ["2026-10-20", "today"]);
eq("今晚", [P("今晚 看电影").dueDate, P("今晚 看电影").segment], ["2026-10-20", "evening"]);
eq("明晚", [P("明晚 打电话").dueDate, P("明晚 打电话").dueTime], ["2026-10-21", "20:00"]);

// 10-20 是周二：「周三」= 10-21（不含今天）
eq("周三轮回", P("周三 例会").dueDate, "2026-10-21");
eq("下周三", P("下周三 评审").dueDate, "2026-10-28");
eq("下下周三", P("下下周三 复盘").dueDate, "2026-11-04");
eq("星期天", P("星期天 大扫除").dueDate, "2026-10-25");
eq("星期日等价", P("星期日 大扫除").dueDate, "2026-10-25");

eq("月日格式", P("11-05 交税").dueDate, "2026-11-05");
eq("月日中文", P("11月5日 交税").dueDate, "2026-11-05");
eq("已过月份进明年", P("3月1日 春游").dueDate, "2027-03-01");
eq("N天后", P("3天后 复诊").dueDate, "2026-10-23");
eq("两周后", P("两周后 汇报").dueDate, "2026-11-03");

eq("24小时制", P("19:30 直播").dueTime, "19:30");
eq("中文时段-晚上", P("晚上7点半 瑜伽").dueTime, "19:30");
eq("中文时段-下午", P("下午3点 面谈").dueTime, "15:00");
eq("中午", P("中午12点 订餐").dueTime, "12:00");
eq("裸小时只给日期不吞", P("晚上8点 跑步").title, "跑步");
eq("只有时间补今天", [P("21:00 收快递").dueDate, P("21:00 收快递").segment], ["2026-10-20", "today"]);

eq("旗标", P("^ 重要客户回访").flagged, true);
eq("旗标不吞字", P("^ 重要客户回访").title, "重要客户回访");
eq("优先级4", P("!4 整理旧照片").priority, 4);
eq("提前提醒", P("提前30分钟 开会").remindOffsetMin, 30);
eq("多标签去重", P("@家 @家 @急 修水龙头").tags, ["家", "急"]);

eq("斜杠子任务", P("搬家 /租箱 /断电 /换地址").subtasks, ["租箱", "断电", "换地址"]);
eq("斜杠子任务-标题", P("搬家 /租箱 /断电 /换地址").title, "搬家");

eq("重复-每天", P("每天 背单词").repeat?.freq, "daily");
eq("重复-工作日", P("每个工作日 打卡").repeat?.freq, "weekday");
eq("重复-每周三不被当日期", P("每周三 周会").repeat?.weekdays, [3]);
eq("重复-每3天", P("每3天 换药").repeat?.interval, 3);
eq("重复-每月", P("每月15号 交房租").repeat?.freq, "monthday");
eq("重复-每月带日期", P("每月15号 交房租").dueDate, "2026-11-15");
eq("重复-不吞标题", P("每周三 周会").title, "周会");

eq("无日期不编造", P("买猫粮").segment, undefined);
eq("数字不误判为时间", P("读 30 页书").dueTime, undefined);
eq("数字不误吞标题", P("读 30 页书").title, "读 30 页书");
eq("项目名不含空格", P("#工作 周报").projectName, "工作");

// businessDay 边界
eq("凌晨4点前算昨天", businessDay(new Date(2026, 9, 20, 3, 59), 4), "2026-10-19");
eq("凌晨4点后算今天", businessDay(new Date(2026, 9, 20, 4, 0), 4), "2026-10-20");

console.log(`\nparse: ${pass} 通过 / ${pass + fails.length} 断言`);
if (fails.length) {
  console.log("失败：\n - " + fails.join("\n - ") + "\n");
  process.exit(1);
}
