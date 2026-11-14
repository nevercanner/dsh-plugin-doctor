/**
 * @dsh-external/dsh-plugin-doctor — 宿主半。
 *
 * 职责：
 *  1. 体检：扫一遍 Loader entries + 服务实现 + Config schema，得出「谁缺服务 / 谁缺配置 / 谁依赖谁」；
 *  2. 一键修复：`enable`（打开被依赖却关着的 entry）、`fill-default`（补 schema 默认值）、
 *     `set-field`（写人填的值）——全部走 `configEditor.edit()` / `entry.update()` 的正常 Loader 路径，
 *     不手改 profile 的 package.json 或 cordis.patch.yml；
 *  3. 首次配置感知：把见过的 entry 存成盘上状态，新 entry 出现即提示；
 *  4. 给 Agent 一个工具 `plugin_doctor_scan`，让它也能自己体检；
 *  5. 给浏览器半三个路由（report / summary / fix / fix-all / ack / rescan）。
 *
 * 本文件**不硬注入** configEditor / reflect / credentials —— 那些用 `ctx.get()` 兜底取，
 * 少一个服务也不会让整个 entry 卡在 pending（本插件自己就是干这个的，不能犯这个错）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { cloneConfig, scanComposition, setAt, type DoctorReport, type FixKind } from './doctor.js'

export const name = '@dsh-external/dsh-plugin-doctor'
export const inject = ['webServer']

const API = '/@dsh-external/dsh-plugin-doctor/api'
const LOG_TAG = '[plugin-doctor]'

interface PersistState {
  known: string[]
  acked: string[]
  updatedAt: string
}

function profileDir(): string {
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (fromEnv) return fromEnv
  const profile = process.env.DSH_PROFILE ?? 'desktop'
  return join(homedir(), '.dsh', 'profiles', profile)
}

function statePath(): string {
  return join(profileDir(), 'plugin-doctor.json')
}

function loadState(): PersistState {
  const file = statePath()
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<PersistState>
      return {
        known: Array.isArray(raw.known) ? raw.known.filter((item) => typeof item === 'string') : [],
        acked: Array.isArray(raw.acked) ? raw.acked.filter((item) => typeof item === 'string') : [],
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      }
    }
  } catch (error) {
    console.warn(LOG_TAG, '读取状态文件失败，按首次运行处理', error)
  }
  return { known: [], acked: [], updatedAt: '' }
}

function saveState(state: PersistState): void {
  const file = statePath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8')
  } catch (error) {
    console.warn(LOG_TAG, '写状态文件失败', error)
  }
}

/** 缓存最近一次报告：面板轮询时不必每次都扫全量。 */
let cached: { report: DoctorReport; at: number } | undefined
let dirty = true

export function apply(ctx: Context, _config: Record<string, never>): void {
  const anyCtx = ctx as any
  const state = loadState()
  const firstBoot = state.known.length === 0

  const readReport = (fresh: boolean): DoctorReport => {
    if (!fresh && cached && !dirty && Date.now() - cached.at < 4000) return cached.report
    const report = scanComposition(ctx, state)
    // 第一次跑没有基线：别把已装的两百多个插件全报成"新安装"。
    if (firstBoot) {
      report.newPlugins = []
      report.alerts = []
      report.summary.newPlugins = 0
      report.firstRun = report.firstRun.map((item) => ({ ...item, note: '待配置' }))
    }
    // known 只增不减：entry id 变了才算"新安装"
    const ids = new Set(report.entries.map((entry) => entry.entryId))
    const merged = new Set(state.known)
    for (const id of ids) merged.add(id)
    const added = report.entries.filter((entry) => !state.known.includes(entry.entryId)).map((entry) => entry.entryId)
    state.known = [...merged]
    if (added.length || firstBoot) saveState(state)
    cached = { report, at: Date.now() }
    dirty = false
    if (!firstBoot && added.length) {
      const names = report.entries.filter((entry) => added.includes(entry.entryId)).map((entry) => entry.plugin)
      console.info(LOG_TAG, `新安装插件：${names.join('、')}（${added.length} 个），已生成首次配置清单`)
    }
    return report
  }

  const entryFor = (entryId: string): any => {
    const editor = safeGet(anyCtx, 'configEditor')
    const entries: any[] = editor?.entries?.() ?? []
    return entries.find((entry) => entry?.id === entryId && !entry.options?.group)
  }

  /** 把一条 finding 的修复执行掉。返回给界面的人话结果。 */
  const applyFix = async (input: { entryId: string; kind: FixKind; path?: string; value?: unknown }): Promise<{ ok: boolean; message: string }> => {
    const entry = entryFor(input.entryId)
    if (!entry) return { ok: false, message: `找不到 entry ${input.entryId}（可能刚被卸载）` }
    const editor = safeGet(anyCtx, 'configEditor')
    try {
      if (input.kind === 'enable') {
        if (typeof entry.update !== 'function') return { ok: false, message: '该 entry 不支持运行时改写（Loader 未暴露 update）' }
        await entry.update({ disabled: false })
        dirty = true
        return { ok: true, message: `已启用 ${entry.options?.name ?? input.entryId}` }
      }
      if (input.kind === 'fill-default' || input.kind === 'set-field') {
        if (!input.path) return { ok: false, message: '缺少字段路径' }
        if (!editor?.edit) return { ok: false, message: 'configEditor 服务不可用，没法写回配置' }
        const value = input.value
        await editor.edit(entry, (current: any) => {
          const next = cloneConfig(current)
          setAt(next, input.path as string, value)
          return next
        })
        dirty = true
        return { ok: true, message: `已写入 ${input.path}` }
      }
      return { ok: false, message: `未知修复类型 ${String(input.kind)}` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  // ── 路由 ────────────────────────────────────────────────────────────────
  ctx.effect(() => anyCtx.webServer.register({
    kind: 'prefix',
    path: API,
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const tail = url.pathname.slice(API.length) || '/'
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify(payload))
      }
      try {
        if (tail === '/report' && req.method !== 'POST') {
          return send(200, readReport(url.searchParams.get('fresh') === '1'))
        }
        if (tail === '/summary') {
          const report = readReport(false)
          return send(200, { ...report.summary, generatedAt: report.generatedAt, alerts: report.alerts })
        }
        if (tail === '/rescan') {
          const report = readReport(true)
          return send(200, report)
        }
        if (req.method !== 'POST') return send(405, { error: '该操作只接受 POST' })
        const body = await readJson(req)
        if (tail === '/fix') {
          const entryId = String(body?.entryId ?? '')
          const kind = String(body?.kind ?? '') as FixKind
          const result = await applyFix({ entryId, kind, path: body?.path, value: body?.value })
          console.info(LOG_TAG, `修复 ${entryId} / ${kind} →`, result.ok ? 'OK' : result.message)
          return send(200, { ...result, report: readReport(true) })
        }
        if (tail === '/fix-all') {
          const report = readReport(false)
          const safe = report.findings.filter((finding) => finding.fix && finding.fix.kind !== 'set-field')
          const applied: string[] = []
          const failed: Array<{ id: string; message: string }> = []
          for (const finding of safe) {
            const fix = finding.fix!
            const result = await applyFix({ entryId: finding.entryId, kind: fix.kind, path: fix.path, value: fix.value })
            if (result.ok) applied.push(`${finding.plugin}: ${fix.label}`)
            else failed.push({ id: finding.id, message: result.message })
          }
          return send(200, { ok: true, applied, failed, report: readReport(true) })
        }
        if (tail === '/ack') {
          const ids = Array.isArray(body?.entryIds) ? body.entryIds.filter((item: unknown) => typeof item === 'string') : []
          state.acked = [...new Set([...state.acked, ...ids])]
          saveState(state)
          return send(200, { ok: true, acked: state.acked.length, report: readReport(true) })
        }
        return send(404, { error: `未知端点 ${tail}` })
      } catch (error) {
        console.warn(LOG_TAG, '路由异常', error)
        return send(500, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), '@dsh-external/dsh-plugin-doctor: api')

  // ── 自动感知：新插件激活 / entry 增删，就把缓存打脏，下次读为最新 ─────────────
  ctx.effect(() => anyCtx.on('internal/status', (fiber: any) => {
    if (!fiber) return
    const entryId = fiber?.ctx?.fiber?.entry?.id ?? fiber?.entry?.id
    if (typeof entryId === 'string' && !state.known.includes(entryId)) {
      dirty = true
      console.info(LOG_TAG, `新 entry 激活：${entryId}`)
    }
  }), '@dsh-external/dsh-plugin-doctor: status watcher')
  ctx.effect(() => anyCtx.on('loader/entry-init', () => { dirty = true }), '@dsh-external/dsh-plugin-doctor: entry watcher')

  // ── Agent 工具 ───────────────────────────────────────────────────────────
  ctx.inject(['tools'], (sub: any) => {
    sub.effect(() => sub.tools.register(defineTool({
      name: 'plugin_doctor_scan',
      description: '体检当前 dsh 已装插件：哪些缺 API 密钥/必填配置、哪些缺少依赖的宿主服务、依赖关系是否闭环，并给出可执行的修复建议（含一键修复可用的种类与字段路径）。',
      parameters: {},
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
      },
      async execute() {
        const report = readReport(true)
        const lines: string[] = []
        lines.push(`插件 ${report.summary.entries} 个：错误 ${report.summary.errors}，警告 ${report.summary.warnings}，待配置 ${report.summary.pendingConfig}，缺服务 ${report.summary.missingServices}`)
        for (const finding of report.findings.slice(0, 40)) {
          lines.push(`- [${finding.severity}] ${finding.title} → ${finding.suggestion}${finding.fix ? `（可一键：${finding.fix.label}${finding.fix.path ? ` @ ${finding.fix.path}` : ''}）` : ''}`)
        }
        const open = report.services.filter((service) => !service.available && service.consumers.length)
        if (open.length) {
          lines.push('缺服务的依赖链：')
          for (const service of open.slice(0, 20)) lines.push(`- ${service.name} ← ${service.consumers.join('、')}`)
        }
        if (report.firstRun.length) {
          lines.push('首次配置待办：')
          for (const item of report.firstRun.slice(0, 20)) {
            const fields = item.gaps.map((gap) => gap.path).join(', ')
            lines.push(`- ${item.plugin}${fields ? ` 需填：${fields}` : ''}${item.missingServices.length ? ` 需服务：${item.missingServices.join(', ')}` : ''}`)
          }
        }
        return lines.join('\n')
      },
    })), '@dsh-external/dsh-plugin-doctor: scan tool')
  })

  console.info(LOG_TAG, `已就绪（profile 状态文件：${statePath()}）`)
}

function safeGet(ctx: any, name: string): any {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

async function readJson(req: any): Promise<any> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}
