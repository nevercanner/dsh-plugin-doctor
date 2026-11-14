/**
 * 极简 Node 环境声明。
 *
 * 这个环境里没有可用的 `@types/node`（app 内的那份是只剩 package.json 的空壳），
 * 而宿主半只用到很小一片 API ⇒ 自己声明，别为了几个函数去联网装类型。
 */
declare const process: {
  env: Record<string, string | undefined>
  platform: string
  cwd(): string
}
declare const console: {
  log(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}
declare class Buffer extends Uint8Array {
  static isBuffer(value: unknown): boolean
  static from(value: string | Uint8Array, encoding?: string): Buffer
  static concat(list: readonly Uint8Array[]): Buffer
  toString(encoding?: string): string
}
declare class URL {
  constructor(input: string, base?: string)
  readonly pathname: string
  readonly searchParams: { get(name: string): string | null; toString(): string }
  toString(): string
}
declare function structuredClone<T>(value: T): T
declare function setInterval(handler: () => void, timeout?: number): unknown
declare function clearInterval(handle: unknown): void
declare function setTimeout(handler: () => void, timeout?: number): unknown

declare module 'node:fs' {
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void
}
declare module 'node:os' {
  export function homedir(): string
}
declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
}

/**
 * 宿主包在这套安装里只发 JS（.d.ts 被裁掉了），所以自己声明用到的两小块。
 * 宿主半所有内部对象（loader entry / fiber / reflect / configEditor）一律按结构访问，
 * 用 `any` 比抄一份会悄悄过期的类型更稳。
 */
declare module '@deepseek-ai/cordis' {
  export interface Context {
    [key: string]: any
  }
  export interface Fiber {
    uid: number | null
    state: number
    inject: Record<string, unknown>
    store?: Record<string, unknown>
    runtime?: any
    ctx: Context
    _error?: unknown
  }
}

declare module '@deepseek-ai/dsh-tools' {
  export function defineTool(definition: any): any
}
