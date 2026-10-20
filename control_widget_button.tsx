// control_widget_button.tsx —— 控制中心 / 锁屏按钮（PRD FR-704）。
// 规则：该文件只能渲染一个 ControlWidgetButton，且不能弹 UI。
// 长按控制中心控件 → 编辑 → 参数填 undo 可切换成「撤销上一步」。
import { ControlWidget, ControlWidgetButton, Script } from "scripting";
import { CompleteNextIntent, UndoLastIntent } from "./app_intents";
import { readSlice } from "./runtime";

interface Slice { total: number; done: number; day: string }
const slice = readSlice<Slice>() ?? { total: 0, done: 0, day: "" };
const mode = (ControlWidget.parameter ?? "").trim().toLowerCase();
const wantUndo = mode === "undo" || mode === "撤销";

ControlWidget.present(
  <ControlWidgetButton
    label={{
      title: wantUndo ? "撤销上一步" : slice.total > 0 ? `完成下一条（剩 ${slice.total}）` : "今日已清空",
      systemImage: wantUndo ? "arrow.uturn.backward" : "checkmark.circle",
    }}
    intent={wantUndo ? UndoLastIntent() : CompleteNextIntent()}
  />
);
Script.exit();
