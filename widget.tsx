// widget.tsx —— 桌面小组件（PRD FR-701/FR-702）。
// 约束：widgets 里 hooks 不生效、present 之后代码不执行、约 30MB 内存上限，
// 所以数据必须在 present 之前一次性准备好，读的是 App Group 切片而不是主库。
import { Button, HStack, Image, Script, Spacer, Text, VStack, Widget } from "scripting";
import { CompleteTaskIntent, OpenWorkbenchIntent, PickNextTodayIntent } from "./app_intents";
import { readSlice } from "./runtime";

interface SliceItem { id: string; title: string; done: boolean; priority?: number; flagged?: boolean }
interface Slice { day: string; total: number; done: number; items: SliceItem[]; generatedAt: number }

const slice = readSlice<Slice>() ?? { day: "", total: 0, done: 0, items: [], generatedAt: 0 };
const family = Widget.family;                       // 'small' | 'medium' | 'large'
const maxRows = family === "small" ? 3 : family === "medium" ? 4 : 8;
const rows = slice.items.slice(0, maxRows);
const param = (Widget.parameter ?? "").trim();      // 用户长按小组件→编辑→参数
const title = param || "今日";
const remaining = Math.max(0, slice.total);

const openURL = (() => { try { return Script.createRunURLScheme("待办工作台", { view: "today" }); } catch { return undefined; } })();

const tintFor = (p?: number) => p === 1 ? "systemRed" : p === 2 ? "systemOrange" : p === 3 ? "systemYellow" : "systemGray";

function Row(props: { key?: string | number; item: SliceItem }) {
  const it = props.item;
  return (
    <HStack spacing={6}>
      <Button
        title=""
        systemImage={it.done ? "checkmark.circle.fill" : "circle"}
        labelStyle="iconOnly"
        intent={CompleteTaskIntent({ id: it.id })}
      />
      {it.flagged && <Image systemName="flag.fill" foregroundStyle="systemOrange" />}
      <Text
        font={family === "small" ? "caption" : "footnote"}
        foregroundStyle={it.done ? "tertiaryLabel" : "label"}
        lineLimit={1}
        truncationMode="tail"
      >
        {it.title}
      </Text>
      <Spacer />
      {!!it.priority && <Image systemName="exclamationmark.arrow.triangle.2.circlepath" foregroundStyle={tintFor(it.priority)} />}
    </HStack>
  );
}

function TodayWidget() {
  return (
    <VStack alignment="leading" spacing={4} url={openURL}>
      <HStack spacing={4}>
        <Image systemName="sun.max" foregroundStyle="systemYellow" />
        <Text font="caption" foregroundStyle="secondaryLabel">{title}</Text>
        <Spacer />
        <Text font="caption" foregroundStyle="secondaryLabel">{slice.done} / {remaining}</Text>
      </HStack>

      {rows.length === 0 ? (
        <HStack spacing={6}>
          <Image systemName="checkmark.seal" foregroundStyle="systemGreen" />
          <Text font="footnote" foregroundStyle="secondaryLabel">今日清空，去收集箱挑一条</Text>
          <Spacer />
          <Button title="" systemImage="plus.circle" labelStyle="iconOnly" intent={PickNextTodayIntent()} />
        </HStack>
      ) : (
        rows.map((it) => <Row key={it.id} item={it} />)
      )}

      <HStack spacing={4}>
        <Text font="caption2" foregroundStyle="tertiaryLabel">
          {slice.day ? `${slice.day.slice(5).replace("-", "/")} · 更新于 ${new Date(slice.generatedAt).toLocaleTimeString()}` : "还没有数据，先打开工作台"}
        </Text>
        <Spacer />
        <Button title="" systemImage="arrow.clockwise" labelStyle="iconOnly" intent={PickNextTodayIntent()} />
      </HStack>
    </VStack>
  );
}

// 注意：present 之后再写业务逻辑不会执行；这里只按文档要求收尾生命周期。
Widget.present(<TodayWidget />, { policy: "atEnd" });
Script.exit();
