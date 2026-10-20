// 仅供 PC 端 tsc 自检使用：把 JSX 编译目标指向全局 h()/Fragment 占位，
// 真机由 Scripting 自己的构建管线处理，不会用到这里。
declare const h: (type: any, props?: any, ...children: any[]) => any;
declare const Fragment: any;
declare const console: { log(...args: any[]): void; warn(...args: any[]): void; error(...args: any[]): void };
