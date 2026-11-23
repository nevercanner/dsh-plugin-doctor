/**
 * 极简 Node 环境声明。
 *
 * 这个环境里没有可用的 `@types/node`（app 内的那份是只剩 package.json 的空壳），
 * 而宿主半只用到很小一片 API ⇒ 自己声明，别为了几个函数去联网装类型。
 *
 * 原则：**只声明真正用到的**，签名按 Node 的实际行为写（宁可宽一点，也不写错的窄签名）。
 */
declare const process: {
  env: Record<string, string | undefined>
  platform: string
  pid: number
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
  export interface Dirent {
    name: string
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }
  export interface Stats {
    size: number
    mtimeMs: number
    ctimeMs: number
    isDirectory(): boolean
    isFile(): boolean
    isSymbolicLink(): boolean
  }
  export function existsSync(path: string): boolean
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void
  export function readFileSync(path: string, encoding: 'utf8'): string
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void
  export function readdirSync(path: string): string[]
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[]
  export function statSync(path: string): Stats
  export function lstatSync(path: string): Stats
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void
  export function rmdirSync(path: string): void
  export function unlinkSync(path: string): void
  export function renameSync(from: string, to: string): void
  export function readlinkSync(path: string): string
  export function symlinkSync(target: string, path: string, type?: string | null): void
  export function realpathSync(path: string): string
  export function cpSync(from: string, to: string, options?: { recursive?: boolean }): void
}

declare module 'node:os' {
  export function homedir(): string
}

declare module 'node:path' {
  export function join(...parts: string[]): string
  export function dirname(path: string): string
  export function basename(path: string, ext?: string): string
  export function normalize(path: string): string
  export function isAbsolute(path: string): boolean
  export function resolve(...parts: string[]): string
  export const sep: string
}

declare module 'node:child_process' {
  export interface ExecFileOptions {
    cwd?: string
    timeout?: number
    windowsHide?: boolean
    env?: Record<string, string | undefined>
  }
  export function execFile(
    file: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
  ): { pid?: number }
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

/** schemastery 在这套安装里没发 .d.ts，按实际形态给最小声明。 */
declare module '@deepseek-ai/schemastery' {
  export interface Schema {
    default(value: unknown): Schema
    description(text: string): Schema
    required(value?: boolean): Schema
  }
  export interface Schemastery {
    object<T extends Record<string, unknown>>(dict: T): Schema
    string(): Schema
    number(): Schema
    boolean(): Schema
    array<T>(inner: T): Schema
    dict<T>(inner: T): Schema
    union(list: readonly unknown[]): Schema
  }
  const z: Schemastery
  export default z
}
