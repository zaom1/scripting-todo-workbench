// 仅供 Node 单测编译使用（tsconfig.test.json 里 types: []，不依赖 @types/node）
declare const console: { log(...args: unknown[]): void };
declare const process: { exit(code?: number): never };
