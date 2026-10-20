/**
 * 本地开发用的 "scripting" 类型垫片 —— 只用于在 PC 上跑 `tsc` 做语法与自检，
 * 不参与真机运行（真机由 Scripting App 提供同名模块与完整类型）。
 *
 * 所有签名均来自官方文档 llms-full.txt 的逐字提取；标 any 的属性表示
 * 「文档给出的类型表述过宽或我未逐一核对」，不代表该 API 不存在。
 */
declare module "scripting" {
  // ── 运行时 ─────────────────────────────────────────────
  export const Script: {
    env: "index" | "widget" | "control_widget_button" | "control_widget_toggle" | "notification" | "intent" | "app_intents" | "spotlight" | "live_activity" | "assistant_tool" | "keyboard" | string;
    queryParameters: Record<string, any>;
    metadata: Record<string, any>;
    exit(result?: any): never;
    run<T = any>(options: { name: string; queryParameters?: Record<string, any>; singleMode?: boolean }): Promise<T | null>;
    requestAccess(apis: string[]): Promise<string[]>;
    createRunURLScheme(scriptName: string, params?: Record<string, any>): string;
  };

  export const Navigation: {
    present(options: { element: any }): Promise<void>;
    useDismiss(): () => void;
  };

  // ── Hooks ─────────────────────────────────────────────
  export function useState<S>(initial: S | (() => S)): [S, (v: S | ((p: S) => S)) => void];
  export function useEffect(fn: () => (void | (() => void)), deps?: any[]): void;
  export function useMemo<T>(fn: () => T, deps?: any[]): T;
  export function useCallback<T extends (...a: any[]) => any>(fn: T, deps?: any[]): T;
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S): [S, (a: A) => void];
  export function createContext<T>(def?: T): any;
  export function useContext<T>(ctx: any): T;

  export interface Observable<T> {
    value: T;
    setValue(v: T): void;
  }
  export function useObservable<T>(initial: T): Observable<T>;
  export function observable<T>(initial: T): Observable<T>;
  export function modifiers(): any;

  // ── 持久化与文件 ─────────────────────────────────────────
  /** 注意：Storage 是同步 API，未命中返回 null */
  export const Storage: {
    set<T>(key: string, value: T, options?: { shared: boolean }): boolean;
    get<T>(key: string, options?: { shared: boolean }): T | null;
    setData(key: string, data: any, options?: { shared: boolean }): void;
    getData(key: string, options?: { shared: boolean }): any;
    remove(key: string, options?: { shared: boolean }): void;
    contains(key: string, options?: { shared: boolean }): boolean;
    clear(): void;
    keys(): string[];
  };

  export const FileManager: {
    documentsDirectory: string;
    appGroupDocumentsDirectory: string;
    iCloudDocumentsDirectory: string;
    temporaryDirectory: string;
    scriptsDirectory: string;
    isiCloudEnabled: boolean;
    writeAsString(path: string, contents: string): Promise<void>;
    writeAsStringSync(path: string, contents: string): void;
    readAsString(path: string): Promise<string>;
    readAsStringSync(path: string): string;
    exists(path: string): Promise<boolean>;
    existsSync(path: string): boolean;
    createDirectory(path: string, recursive?: boolean): Promise<void>;
    remove(path: string): Promise<void>;
    removeSync(path: string): void;
    readDirectory(path: string, recursive?: boolean): Promise<string[]>;
    zip(src: string, dest: string, keepParent?: boolean): Promise<void>;
  };

  export const CloudSharedData: {
    new (storeId: string): {
      put(key: string, value: any, blob?: any): Promise<void>;
      get(key: string): Promise<any>;
      remove(key: string): Promise<void>;
      entries(): Promise<any[]>;
      refresh(): Promise<void>;
      onChange(cb: () => void): () => void;
    };
  };

  export const UUID: { string(): string };
  export const Data: { fromUTF8(s: string): any };
  export const Path: { join(...p: string[]): string; dirname(p: string): string; basename(p: string): string };
  export const Pasteboard: { contents(): Promise<string[]>; write(text: string): Promise<void> };
  export const ShareSheet: { present(items: any[]): Promise<boolean> };

  // ── 日期 ─────────────────────────────────────────────
  export const DateComponents: {
    new (o: { year?: number; month?: number; day?: number; hour?: number; minute?: number; second?: number; weekday?: number }): any;
    fromDate(d: Date): any;
    forDaily(): any;
    forWeekly(): any;
  };
  export const DateFormatter: {
    new (): { setLocalizedDateFormatFromTemplate(tpl: string): void; string(d: Date | number): string };
    localizedString(d: Date | number, o: { dateStyle?: string; timeStyle?: string }): string;
    dateFormat(template: string, locale?: string): string;
  };

  // ── 通知 / 提醒 ─────────────────────────────────────────
  export class TimeIntervalNotificationTrigger {
    constructor(o: { timeInterval: number; repeats?: boolean });
  }
  export class CalendarNotificationTrigger {
    constructor(o: { dateMatching: any; repeats?: boolean });
  }
  export class LocationNotificationTrigger {
    constructor(o: { region: any; repeats?: boolean });
  }
  export const Notification: {
    schedule(options: {
      title?: string;
      subtitle?: string;
      body?: string;
      badge?: number;
      iconImageData?: any;
      silent?: boolean;
      interruptionLevel?: "active" | "passive" | "timeSensitive";
      userInfo?: Record<string, any>;
      threadIdentifier?: string;
      trigger?: any;
      actions?: { title: string; icon?: string; url: string; destructive?: boolean }[];
      tapAction?: "none" | { type: "runScript"; scriptName: string } | { type: "openURL"; url: string };
      customUI?: boolean;
    }): Promise<void>;
    present(element: any): void;
    current: { identifier: string; content: { title: string; subtitle?: string; body?: string; userInfo?: Record<string, any> }; trigger?: any } | null;
    getAllPendings(): Promise<{ identifier: string; content?: { userInfo?: Record<string, any> }; request?: { identifier: string; content: { title: string; userInfo?: Record<string, any> } } }[]>;
    getAllDelivereds(): Promise<any[]>;
    removeAllPendings(): Promise<void>;
    removePendings(ids: string[]): Promise<void>;
    removeDelivereds(ids: string[]): Promise<void>;
    removeAllDelivereds(): Promise<void>;
    getAllPendingsOfCurrentScript(): Promise<{ identifier: string; content?: { userInfo?: Record<string, any> }; request?: { identifier: string; content: { userInfo?: Record<string, any> } } }[]>;
    getAllDeliveredsOfCurrentScript(): Promise<any[]>;
    removeAllPendingsOfCurrentScript(): Promise<void>;
    removeAllDeliveredsOfCurrentScript(): Promise<void>;
    setBadgeCount(count: number): Promise<void>;
  };

  export const EventAlarm: {
    fromAbsoluteDate(d: Date): any;
    fromRelativeOffset(seconds: number): any;
  };
  export const RecurrenceRule: {
    create(o: { frequency: string; interval?: number; daysOfTheWeek?: { weekday: string; weekNumber?: number }[]; end?: any }): any;
  };
  export const RecurrenceEnd: { fromCount(n: number): any; fromDate(d: Date): any };

  export class Reminder {
    constructor();
    identifier: string;
    title: string;
    notes?: string | null;
    completionDate?: Date | null;
    alarms?: any[];
    hasAlarm: boolean;
    recurrenceRules?: any[] | null;
    isCompleted: boolean;
    priority?: number;
    dueDateComponents?: any;
    calendar?: any;
    addAlarm(alarm: any): void;
    removAlarm(alarm: any): void;
    alarms?: any[];
    addRecurrenceRule(rule: any): void;
    save(): Promise<void>;
    remove(): Promise<void>;
    static getAll(calendars?: any[]): Promise<Reminder[]>;
    static getIncompletes(o?: { startDate?: any; endDate?: any; calendars?: any[] }): Promise<Reminder[]>;
    static getCompleteds(o?: any): Promise<Reminder[]>;
    static get(identifier: string): Promise<Reminder | null>;
  }

  export const Calendar: { defaultForReminders(): Promise<any | null> };

  export const Haptics: {
    transient(intensity: number, sharpness: number): Promise<void>;
    continuous(intensity: number, sharpness: number, duration: number): Promise<void>;
    supportsHaptics: boolean;
  };
  export const HapticFeedback: {
    lightImpact(): void; mediumImpact(): void; heavyImpact(): void;
    selection(): void; notificationSuccess(): void; notificationError(): void;
  };

  export const Spotlight: {
    index(item: { id: string; title: string; keywords?: string[]; parameters?: Record<string, any>; contentDescription?: string; expirationDate?: number }): Promise<void>;
    indexItems(items: any[]): Promise<void>;
    getItems(): Promise<any[]>;
    delete(id: string): Promise<void>;
    deleteItems(ids: string[]): Promise<void>;
    deleteAll(): Promise<void>;
    current: { id: string; parameters: Record<string, any> } | null;
  };

  // ── 小组件 / AppIntent ─────────────────────────────────
  export const Widget: {
    present(element: any, reloadPolicy?: { policy: "atEnd" } | { policy: "after"; date: Date }): void;
    preview(options?: any): Promise<void>;
    reloadAll(): void;
    reloadUserWidgets(): void;
    reloadTestWidgets(): void;
    family: "small" | "medium" | "large";
    displaySize: { width: number; height: number };
    parameter: string | null;
  };

  export const ControlWidget: {
    present(element: any): void;
    reloadButtons(): void;
    reloadToggles(): void;
    /** 当前控件在编辑器里被分配的自定义参数 */
    parameter: string | null;
  };

  export const AppIntentProtocol: {
    AppIntent: any;
    AudioPlaybackIntent: any;
    LiveActivityIntent: any;
  };
  export const AppIntentManager: {
    // 无参数 intent（重载在前，避免被带参重载吞掉）
    register(options: { name: string; protocol: any; perform: () => Promise<void> }): () => any;
    // 带参数 intent：perform 的形参类型即工厂入参类型
    register<T extends object>(options: {
      name: string;
      protocol: any;
      perform: (params: T) => Promise<void>;
    }): (params: T) => any;
  };
  export const Intent: {
    snippetIntent(o: any): any;
    requestConfirmation(name: string, intent: any, options?: any): Promise<void>;
    continueInForeground(dialog?: any, options?: any): Promise<void>;
    text(s: string): any;
    json(v: any): any;
    shortcutParameter(o: any): any;
    textsParameter(o: any): any;
  };

  export const Device: { model: string; isiPhone: boolean; screen: { width: number; height: number; scale: number } };
  export const Keyboard: { hide(): void };

  // ── 视图组件（修饰符即普通 prop，见文档 Chaining View Modifiers）──
  type AnyProps = Record<string, any>;
  export function NavigationStack(props: AnyProps): any;
  export function List(props: AnyProps): any;
  export function Section(props: AnyProps): any;
  export function ForEach<T extends { id: string }>(props: {
    data: Observable<T[]> | T[];
    builder: (item: T, index: number) => any;
    editActions?: "delete" | "move" | "all" | null;
    [k: string]: any;
  }): any;
  export function Text(props: AnyProps): any;
  export function Image(props: AnyProps): any;
  export function Label(props: AnyProps): any;
  export function HStack(props: AnyProps): any;
  export function VStack(props: AnyProps): any;
  export function ZStack(props: AnyProps): any;
  export function Spacer(props?: AnyProps): any;
  export function Divider(props?: AnyProps): any;
  export function Group(props: AnyProps): any;
  export function GroupBox(props: AnyProps): any;
  export function Button(props: { title?: string; systemImage?: string; action?: () => void; intent?: any; role?: string; children?: any; [k: string]: any }): any;
  export function Toggle(props: { value: boolean; onChanged?: (v: boolean) => void; title?: string; systemImage?: string; intent?: any; [k: string]: any }): any;
  export function Picker<T extends string | number>(props: { value?: T; onChanged?: (v: T) => void; title?: string; children?: any; [k: string]: any }): any;
  export function TextField(props: { title?: string; value: string; onChanged?: (v: string) => void; onSubmit?: any; prompt?: string; axis?: string; autofocus?: boolean; [k: string]: any }): any;
  export function SecureField(props: AnyProps): any;
  export function DatePicker(props: { title: string; value: number; onChanged?: (v: number) => void; displayedComponents?: string[]; [k: string]: any }): any;
  export function Menu(props: AnyProps): any;
  export function DisclosureGroup(props: AnyProps): any;
  export function ProgressView(props: AnyProps): any;
  export function Gauge(props: { value: number; label: any; min?: number; max?: number; [k: string]: any }): any;
  export function EditButton(props?: AnyProps): any;
  export function NavigationLink(props: AnyProps): any;
  export function NavigationDestination(props: AnyProps): any;
  export function TabView(props: AnyProps): any;
  export function Tab(props: AnyProps): any;
  export function Form(props: AnyProps): any;
  export function ControlWidgetButton(props: AnyProps): any;
  export function ControlWidgetToggle(props: AnyProps): any;
  export function DateLabel(props: AnyProps): any;
  export function ScrollView(props: AnyProps): any;
  export function ContentUnavailableView(props: AnyProps): any;
  export function Circle(props: AnyProps): any;
  export function LabeledContent(props: AnyProps): any;
}
