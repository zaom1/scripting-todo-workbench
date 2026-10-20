// spotlight.tsx —— 系统搜索命中后的落点（PRD FR-602）。
// 该文件只在用户点搜索结果时被系统拉起，Spotlight.current 此时才有值。
import { Script, Spotlight } from "scripting";
import { snapshot } from "./core";

const current = Spotlight.current;
const params = ((current && current.parameters) || {}) as { openTask?: string; view?: string };
const { settings } = snapshot();

if (params.openTask) {
  // 把 id 交给主脚本，由 index.tsx 直接打开该任务详情
  Script.run({ name: settings.scriptName, queryParameters: { id: params.openTask }, singleMode: true }).then(() => { }).catch(() => { });
} else if (params.view) {
  Script.run({ name: settings.scriptName, queryParameters: { view: params.view }, singleMode: true }).then(() => { }).catch(() => { });
}

Script.exit();
