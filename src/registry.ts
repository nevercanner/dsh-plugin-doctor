/**
 * PluginRegistry —— 已装插件的唯一真值来源。
 *
 * 三件事：
 *  1. **列表**：把 Loader 的 entry、profile package.json 的依赖、注入器 registry、
 *     盘上的插件目录合成一份带 status/path/config/errors 的统一视图；
 *  2. **路径纪律**：所有插件的落盘根目录硬编码为 `PLUGIN_ROOT`（默认 `D:\deepseek\plugins`），
 *     任何安装/更新/迁移的目标路径都必须过 `assertInsideRoot()` 白名单校验；
 *  3. **操作**：enable/disable（走 configEditor/entry.update 的正规 Loader 路径）、
 *     uninstall（删目录 + 清引用）、update（git pull/clone，失败降级为离线提示）、
 *     validate（schemastery 校验）、logs（从宿主日志里筛该插件的行）。
 *
 * 本文件不 import 任何官方 rc 包，只依赖 node 内置 + 宿主注入的 ctx 服务，
 * 少一个服务也只是降级一项能力，不会让整个插件卡在 pending。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

/**
 * 插件落盘根目录：这是**唯一**允许出现插件文件的目录。
 *
 * 默认 `D:\deepseek\plugins`，可被 `DSH_PLUGIN_ROOT` 环境变量或插件 config 的
 * `pluginRoot` 覆盖（后者在 apply 开头调 setPluginRoot 写入）。
 *
 * 注意：这里用 `let` 导出。ESM 的 live binding 让其它模块读到的永远是当前值，
 * 所以 `join(PLUGIN_ROOT, x)` 这类写法不用改。
 */
export let PLUGIN_ROOT: string = process.env.DSH_PLUGIN_ROOT || 'D:\\deepseek\\plugins'

/** 运行期覆盖插件根目录（插件 config 用）。 */
export function setPluginRoot(next: string | undefined): void {
  const value = String(next ?? '').trim()
  if (value) PLUGIN_ROOT = value
}

export type PluginStatus = 'enabled' | 'disabled' | 'installing' | 'failed' | 'unconfigured' | 'unknown'

export interface PluginConfigField {
  path: string
  label: string
  value: unknown
  secret: boolean
  required: boolean
  problem?: string
}

/** 一条已装插件的完整画像。 */
export interface PluginRegistryEntry {
  /** Loader entry id；拿不到时退化为包名。 */
  id: string
  /** npm 包名。 */
  name: string
  version: string
  status: PluginStatus
  /** 固定为 `<PLUGIN_ROOT>\<id>`；未落盘时为空串。 */
  path: string
  /** 该 entry 的 raw config（扁平化后的关键字段）。 */
  config: PluginConfigField[]
  /** 该插件当前的错误（fiber 失败原因 / 缺服务 / 缺配置）。 */
  errors: string[]
  /** 提供 / 依赖的宿主服务。 */
  provides: string[]
  requires: string[]
  /** 生效来源：bundle / injected / profile / builtin。 */
  source: 'bundle' | 'injected' | 'profile' | 'builtin' | 'unknown'
  /** 目录是否真实存在于白名单根目录下。 */
  onDisk: boolean
  /** git 远端（update 用）。 */
  repository?: string
  disabled: boolean
  /** 该包在 composition 里占了几条 entry（>1 表示多入口插件，如 dsh-purge 的 redteam 三件套）。 */
  entryCount?: number
}

export interface PluginRegistryReport {
  generatedAt: string
  root: string
  summary: {
    total: number
    enabled: number
    disabled: number
    failed: number
    unconfigured: number
    onDisk: number
  }
  plugins: PluginRegistryEntry[]
  warnings: string[]
}

// ── 路径纪律 ────────────────────────────────────────────────────────────────

/** 把任意用户输入规范成绝对路径（Windows 分隔符）。 */
export function toAbsolute(input: string): string {
  const raw = String(input ?? '').trim()
  if (raw === '') throw new Error('路径为空')
  let p = raw.replace(/^~(?=$|[\\/])/, homedir())
  p = normalize(p)
  if (!isAbsolute(p)) p = resolve(PLUGIN_ROOT, p)
  return p
}

/**
 * 白名单校验：目标必须落在 PLUGIN_ROOT 之内。
 * 防止插件把文件写到系统其它目录（这是安装/更新的最后一道闸）。
 */
export function assertInsideRoot(target: string): string {
  const abs = toAbsolute(target)
  const root = normalize(PLUGIN_ROOT)
  const withSep = root.endsWith(sep) ? root : root + sep
  const norm = normalize(abs)
  if (norm !== root && !norm.toLowerCase().startsWith(withSep.toLowerCase())) {
    throw new Error(`写入被拒绝：${norm} 不在插件根目录 ${root} 之内`)
  }
  return norm
}

/** 插件目录 = <PLUGIN_ROOT>\<id>（id 里的 scope 前缀会被拍平，避免多一层目录）。 */
export function pluginDirOf(id: string): string {
  const leaf = String(id).replace(/^@[^/]+\//, '').replace(/[\\/]/g, '-').trim()
  if (!leaf) throw new Error(`无法从 id "${id}" 推导目录名`)
  return assertInsideRoot(join(PLUGIN_ROOT, leaf))
}

/** 确保插件根目录存在（插件初始化时调用）。 */
export function ensureRoot(): string {
  if (!existsSync(PLUGIN_ROOT)) mkdirSync(PLUGIN_ROOT, { recursive: true })
  return PLUGIN_ROOT
}

// ── 读盘 ────────────────────────────────────────────────────────────────────

export function readJsonSafe(file: string): any {
  try {
    if (!existsSync(file)) return undefined
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function writeJsonAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

/** 扫 PLUGIN_ROOT 下的插件目录，返回 目录名 -> package.json。 */
export function scanPluginRoot(): Map<string, any> {
  const found = new Map<string, any>()
  if (!existsSync(PLUGIN_ROOT)) return found
  let names: string[] = []
  try {
    names = readdirSync(PLUGIN_ROOT)
  } catch {
    return found
  }
  for (const name of names) {
    const dir = join(PLUGIN_ROOT, name)
    let isDir = false
    try {
      isDir = statSync(dir).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const pkg = readJsonSafe(join(dir, 'package.json'))
    if (!pkg) continue
    found.set(name, pkg)
  }
  return found
}

export function profileDir(): string {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv) return fromEnv
  const profile = process.env.DSH_PROFILE ?? 'desktop'
  return join(homedir(), '.dsh', 'profiles', profile)
}

export function injectorRegistryPath(): string {
  return join(homedir(), '.dsh', 'super-injector', 'registry.json')
}

// ── git 操作 ────────────────────────────────────────────────────────────────

export interface GitResult {
  ok: boolean
  code: number | null
  output: string
  /** 网络不可用时为 true，调用方据此降级为"手动更新"提示。 */
  offline: boolean
}

const OFFLINE_PAT = /(could not resolve host|failed to connect|connection timed out|network is unreachable|unable to access|SSL certificate problem|proxy CONNECT aborted|Temporary failure in name resolution)/i

/**
 * 在指定目录跑一条 git 命令。
 * 用 execFile 而不是 shell，避免 Windows 上的引号转义问题。
 */
export async function runGit(cwd: string, args: string[], timeoutMs = 60_000): Promise<GitResult> {
  const { execFile } = await import('node:child_process')
  return await new Promise<GitResult>((settle) => {
    try {
      execFile('git', args, {
        cwd,
        timeout: timeoutMs,
        windowsHide: true,
        // 不让 git 弹凭据框卡死进程
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      }, (error: any, stdout: string, stderr: string) => {
        const output = `${stdout ?? ''}${stderr ?? ''}`.trim()
        if (!error) {
          settle({ ok: true, code: 0, output, offline: false })
          return
        }
        const code = typeof error.code === 'number' ? error.code : null
        const message = `${output}${error.message ?? ''}`
        settle({ ok: false, code, output: message, offline: OFFLINE_PAT.test(message) })
      })
    } catch (error) {
      settle({
        ok: false,
        code: null,
        output: error instanceof Error ? error.message : String(error),
        offline: true,
      })
    }
  })
}

/** 从 package.json 的 repository 字段还原一个可 clone 的 URL。 */
export function repositoryUrlOf(pkg: any): string | undefined {
  const repo = pkg?.repository
  if (!repo) return undefined
  const raw = typeof repo === 'string' ? repo : typeof repo.url === 'string' ? repo.url : undefined
  if (!raw) return undefined
  return raw
    .replace(/^git\+/, '')
    .replace(/^github:/, 'https://github.com/')
    .replace(/\.git$/, '')
}

/** 插件目录是否是一个 git 工作区。 */
export function isGitRepo(dir: string): boolean {
  return existsSync(join(dir, '.git'))
}

/** 安全删除插件目录（必须先过白名单）。 */
export function removePluginDir(dir: string): void {
  const abs = assertInsideRoot(dir)
  if (abs === normalize(PLUGIN_ROOT)) throw new Error('拒绝删除插件根目录本身')
  rmSync(abs, { recursive: true, force: true })
}

/** 目录体积（MB），用于列表展示。 */
export function dirSizeMB(dir: string): number {
  let total = 0
  const walk = (d: string): void => {
    let items: any[] = []
    try {
      items = readdirSync(d, { withFileTypes: true }) as any
    } catch {
      return
    }
    for (const item of items) {
      const full = join(d, item.name)
      try {
        if (item.isDirectory()) walk(full)
        else total += statSync(full).size
      } catch {
        /* 单个文件读不到不影响整体统计 */
      }
    }
  }
  walk(dir)
  return Math.round((total / (1024 * 1024)) * 10) / 10
}

/** 日志文件候选位置（按优先级）。 */
export function logCandidates(): string[] {
  const out: string[] = []
  const fromEnv = process.env.DSH_LOG_FILE
  if (fromEnv) out.push(fromEnv)
  // doctor 自己写的观测日志：不依赖宿主怎么重定向 stdout，永远有数据
  out.push(join(profileDir(), 'plugin-doctor.log'))
  out.push(join('D:\\deepseek', 'dsh-c-out.log'))
  out.push(join('D:\\deepseek', 'dsh-c-err.log'))
  out.push(join('D:\\deepseek', 'dsh-live-out.log'))
  out.push(join('D:\\deepseek', 'dsh-live-err.log'))
  out.push(join(profileDir(), '.plugin-manager', 'logs'))
  return out
}

/** doctor 自己的日志文件（append-only，超过 512KB 自动截断到后 2000 行）。 */
export function doctorLogPath(): string {
  return join(profileDir(), 'plugin-doctor.log')
}

/**
 * 写一行 doctor 观测日志。
 *
 * 这个文件是 `get_plugin_logs` 的**保底数据源**：宿主把 stdout 重定向到哪里
 * 我们控制不了，但插件自己的生命周期事件（加载、启停、卸载、更新、校验失败）
 * 必须留下来，否则"为什么这个插件没生效"永远查不到。
 *
 * 每行以 `[plugin-doctor]` 开头，与宿主里 doctor 的 console 前缀一致，
 * 这样按包名过滤时两个来源都能命中。
 */
export function dlog(line: string): void {
  try {
    const file = doctorLogPath()
    mkdirSync(dirname(file), { recursive: true })
    const stamped = `[${new Date().toISOString()}] [plugin-doctor] ${line}`
    const existing = existsSync(file) ? readFileSync(file, 'utf8') : ''
    let body = existing + stamped + '\n'
    // 简单封顶：超过 512KB 只留最后 2000 行
    if (body.length > 512 * 1024) {
      const rows = body.split(/\r?\n/)
      body = rows.slice(-2000).join('\n')
      if (!body.endsWith('\n')) body += '\n'
    }
    writeFileSync(file, body, 'utf8')
  } catch {
    /* 日志写失败绝不能影响主流程 */
  }
}

export { dirname }
