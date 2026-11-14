/**
 * @dsh-external/dsh-plugin-doctor — 浏览器半。
 *
 * 三个注册：
 *  · `sidebar.panellist` —— 左侧栏入口（一级图标，带问题数徽标文案）；
 *  · `main` keyed=PANEL_ID —— 点入口后整页打开的面板；
 *  · 定时轮询 `/summary` —— 让入口的徽标自己更新，不用等人打开面板。
 *
 * 宿主能力一律 `fetch` 我们自己的路由（同源），不 import 官方 rc 包，接口变了只坏这一屏。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

const NS = '@dsh-external/dsh-plugin-doctor'
const PANEL_ID = NS
const API = '/@dsh-external/dsh-plugin-doctor/api'

interface FieldSpec {
  path: string
  label: string
  description?: string
  secret: boolean
  required: boolean
  defaultValue?: unknown
  current: unknown
  problem?: 'missing' | 'placeholder'
}

interface Finding {
  id: string
  entryId: string
  plugin: string
  severity: 'error' | 'warning' | 'info'
  code: string
  title: string
  detail: string
  suggestion: string
  fix?: { kind: 'enable' | 'fill-default' | 'set-field'; label: string; path?: string; value?: unknown }
  candidates?: string[]
}

interface EntryReport {
  entryId: string
  plugin: string
  specifier: string
  disabled: boolean
  state: string
  stateCode: number | null
  provides: string[]
  requires: string[]
  missingServices: string[]
  fields: FieldSpec[]
  gaps: FieldSpec[]
  severity: 'error' | 'warning' | 'info' | 'ok'
  error?: string
}

interface ServiceNode {
  name: string
  available: boolean
  providers: string[]
  consumers: string[]
}

interface FirstRunItem {
  entryId: string
  plugin: string
  gaps: FieldSpec[]
  missingServices: string[]
  note: string
}

interface DoctorReport {
  generatedAt: string
  profile: string
  summary: {
    entries: number
    problems: number
    errors: number
    warnings: number
    missingServices: number
    pendingConfig: number
    healthy: number
    newPlugins: number
  }
  entries: EntryReport[]
  findings: Finding[]
  services: ServiceNode[]
  firstRun: FirstRunItem[]
  newPlugins: string[]
  alerts: string[]
}

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, { credentials: 'same-origin', ...init })
  const text = await response.text()
  let data: any
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`)
  }
  if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`)
  return data
}

const post = (path: string, payload: unknown) =>
  getJson(`${API}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) })

const SEVERITY_TEXT: Record<string, string> = { error: '错误', warning: '待修', info: '提示', ok: '正常' }

// ── 图标 ─────────────────────────────────────────────────────────────────────
function DoctorIcon(props: { size?: number; active?: boolean }) {
  const size = props.size ?? 18
  return h(
    'svg',
    { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true' },
    h('rect', { x: 2.2, y: 2.2, width: 19.6, height: 19.6, rx: 5.4, stroke: 'currentColor', strokeWidth: 1.6, opacity: props.active ? 1 : 0.9 }),
    h('path', { d: 'M7.4 12.4l3 3 6.2-6.6', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    h('path', { d: 'M12 6.2v2.1M11 7.25h2', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', opacity: 0.75 }),
  )
}

// ── 样式（只挂一次；颜色全走主题变量，跟随明暗） ──────────────────────────────
const STYLE_ID = 'pd-doctor-style'
const CSS = `
.pd-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.pd-head{display:flex;align-items:center;gap:12px;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.pd-head h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.2px}
.pd-head .pd-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.pd-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.pd-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s}
.pd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pd-btn[disabled]{opacity:.45;cursor:default}
.pd-btn.pd-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.pd-btn.pd-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.pd-btn.pd-ghost{background:transparent}
.pd-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;padding:14px 20px 4px;flex:none}
.pd-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1)}
.pd-stat b{display:block;font-size:19px;font-weight:600;line-height:1.2}
.pd-stat span{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.pd-stat.is-error b{color:var(--dsw-alias-state-error-primary)}
.pd-stat.is-warn b{color:var(--dsw-static-amber-500)}
.pd-stat.is-ok b{color:var(--dsw-alias-state-success-primary)}
.pd-tabs{display:flex;gap:4px;padding:12px 20px 0;flex:none;flex-wrap:wrap}
.pd-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 11px;border-radius:8px;font-size:12.5px;cursor:pointer}
.pd-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pd-tab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}
.pd-body{flex:1;min-height:0;overflow:auto;padding:12px 20px 28px}
.pd-note{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:9px 12px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pd-note.is-bad{border-left-color:var(--dsw-alias-state-error-primary)}
.pd-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin-bottom:10px}
.pd-card h3{margin:0 0 4px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pd-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}
.pd-chip.error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.pd-chip.warning{color:var(--dsw-static-amber-500);border-color:currentColor}
.pd-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.pd-card p{margin:2px 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pd-card .pd-why{color:var(--dsw-alias-label-tertiary)}
.pd-card .pd-sug{color:var(--dsw-alias-label-primary-dimmed)}
.pd-cardfoot{display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap}
.pd-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-markdown-code-block);padding:1px 5px;border-radius:5px}
.pd-empty{color:var(--dsw-alias-label-tertiary);padding:22px 4px;font-size:12.5px}
.pd-field{display:grid;grid-template-columns:minmax(120px,190px) 1fr auto;gap:8px;align-items:center;margin:7px 0}
.pd-field label{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pd-field input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 9px;font-size:12.5px;font-family:inherit}
.pd-field input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pd-table{width:100%;border-collapse:collapse;font-size:12px}
.pd-table th{ text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.pd-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;color:var(--dsw-alias-label-secondary)}
.pd-table tr:last-child td{border-bottom:none}
.pd-table td.pd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}
.pd-missing{color:var(--dsw-alias-state-error-primary)}
.pd-ok{color:var(--dsw-alias-state-success-primary)}
.pd-toast{position:sticky;bottom:0;margin-top:8px;padding:8px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.pd-toast.is-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.pd-footbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px;cursor:pointer;font-size:12px;font-family:inherit}
.pd-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`

function ensureStyle(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const node = document.createElement('style')
  node.id = STYLE_ID
  node.textContent = CSS
  document.head.appendChild(node)
}

// ── 面板 ─────────────────────────────────────────────────────────────────────
function Panel() {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<'findings' | 'firstrun' | 'graph' | 'entries'>('findings')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [toast, setToast] = useState<{ text: string; bad?: boolean } | null>(null)
  const mounted = useRef(true)

  const load = useCallback(async (fresh: boolean) => {
    setBusy(true)
    try {
      const data = await getJson(`${API}/report${fresh ? '?fresh=1' : ''}`)
      if (!mounted.current) return
      setReport(data as DoctorReport)
      setError('')
    } catch (cause) {
      if (!mounted.current) return
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [])

  useEffect(() => {
    ensureStyle()
    mounted.current = true
    void load(true)
    // 面板开着的时候自己续着看：新装插件一激活，这里 30 秒内就会出现在「首次配置」。
    const timer = setInterval(() => { void load(false) }, 30000)
    return () => {
      mounted.current = false
      clearInterval(timer)
    }
  }, [load])

  const dirty = useMemo(() => Object.entries(drafts).filter(([, value]) => value.trim() !== ''), [drafts])

  const runFix = async (entryId: string, kind: string, path?: string, value?: unknown) => {
    setBusy(true)
    try {
      const result = await post('/fix', { entryId, kind, path, value })
      if (result.report) setReport(result.report as DoctorReport)
      setToast({ text: result.message ?? (result.ok ? '已应用' : '失败'), bad: !result.ok })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : String(cause), bad: true })
    } finally {
      setBusy(false)
    }
  }

  const runFixAll = async () => {
    setBusy(true)
    try {
      const result = await post('/fix-all', {})
      if (result.report) setReport(result.report as DoctorReport)
      const applied = Array.isArray(result.applied) ? result.applied.length : 0
      const failed = Array.isArray(result.failed) ? result.failed.length : 0
      setToast({ text: `一键修复：成功 ${applied} 项${failed ? `，失败 ${failed} 项（见清单）` : ''}`, bad: failed > 0 })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : String(cause), bad: true })
    } finally {
      setBusy(false)
    }
  }

  const saveFirstRun = async (item: FirstRunItem) => {
    const filled = item.gaps
      .map((gap) => ({ gap, value: (drafts[`${item.entryId}:${gap.path}`] ?? '').trim() }))
      .filter((entry) => entry.value !== '')
    if (!filled.length) {
      setToast({ text: '先填至少一个字段再保存', bad: true })
      return
    }
    for (const entry of filled) {
      // eslint-disable-next-line no-await-in-loop
      await runFix(item.entryId, 'set-field', entry.gap.path, entry.value)
    }
    setDrafts((prev) => {
      const next = { ...prev }
      for (const entry of filled) delete next[`${item.entryId}:${entry.gap.path}`]
      return next
    })
    setToast({ text: `${item.plugin}：已写入 ${filled.length} 个字段` })
  }

  const ack = async (entryId: string) => {
    setBusy(true)
    try {
      const result = await post('/ack', { entryIds: [entryId] })
      if (result.report) setReport(result.report as DoctorReport)
      setToast({ text: '已标记为"稍后配置"，不再出现在首次配置里' })
    } catch (cause) {
      setToast({ text: cause instanceof Error ? cause.message : String(cause), bad: true })
    } finally {
      setBusy(false)
    }
  }

  const head = h(
    'header',
    { className: 'pd-head' },
    h(DoctorIcon, { size: 20 }),
    h('div', null,
      h('h1', null, '插件体检'),
      h('div', { className: 'pd-meta' },
        report ? `${report.summary.entries} 个插件 · ${report.profile} · ${formatTime(report.generatedAt)}` : '正在读取 composition…'),
    ),
    h('div', { className: 'pd-actions' },
      h('button', { className: 'pd-btn pd-ghost', disabled: busy, onClick: () => void load(true) }, busy ? '刷新中…' : '重新体检'),
      h('button', { className: 'pd-btn pd-primary', disabled: busy || !report || !report.findings.some((f) => f.fix && f.fix.kind !== 'set-field'), onClick: () => void runFixAll() }, '一键修复可自动修的'),
    ),
  )

  if (error && !report) {
    return h('div', { className: 'pd-root' }, head,
      h('div', { className: 'pd-body' },
        h('div', { className: 'pd-note is-bad' }, `宿主 API 读不到：${error}`),
        h('div', { className: 'pd-empty' }, '这通常说明宿主半没装配（只注入了 client bundle）。检查 entry 是否在跑，再点"重新体检"。'),
      ))
  }

  if (!report) {
    return h('div', { className: 'pd-root' }, head, h('div', { className: 'pd-body' }, h('div', { className: 'pd-empty' }, '正在体检…')))
  }

  const stats = h('div', { className: 'pd-stats' },
    stat(report.summary.entries, '已装插件', ''),
    stat(report.summary.errors, '错误', report.summary.errors ? 'is-error' : 'is-ok'),
    stat(report.summary.pendingConfig, '待填配置', report.summary.pendingConfig ? 'is-warn' : 'is-ok'),
    stat(report.summary.missingServices, '缺依赖服务', report.summary.missingServices ? 'is-error' : 'is-ok'),
    stat(report.summary.healthy, '完全健康', 'is-ok'),
  )

  const tabs = h('nav', { className: 'pd-tabs' },
    ...[
      ['findings', `问题清单 (${report.findings.length})`],
      ['firstrun', `首次配置 (${report.firstRun.length})`],
      ['graph', `依赖关系 (${report.services.filter((service) => !service.available).length} 项缺)`],
      ['entries', `全部插件 (${report.entries.length})`],
    ].map(([key, label]) => h('button', {
      key,
      className: `pd-tab${tab === key ? ' is-active' : ''}`,
      onClick: () => setTab(key as typeof tab),
    }, label)),
  )

  let body: any
  if (tab === 'findings') body = renderFindings(report, busy, runFix)
  else if (tab === 'firstrun') body = renderFirstRun(report, drafts, setDrafts, busy, saveFirstRun, ack)
  else if (tab === 'graph') body = renderGraph(report)
  else body = renderEntries(report)

  return h('div', { className: 'pd-root' }, head, stats, tabs,
    h('main', { className: 'pd-body' },
      report.alerts.length ? h('div', { className: 'pd-note is-bad' }, report.alerts.join('；')) : null,
      body,
      toast ? h('div', { className: `pd-toast${toast.bad ? ' is-bad' : ''}` }, toast.text) : null,
    ),
  )
}

function stat(value: number, label: string, tone: string) {
  return h('div', { className: `pd-stat ${tone}` }, h('b', null, String(value)), h('span', null, label))
}

function renderFindings(report: DoctorReport, busy: boolean, runFix: (entryId: string, kind: string, path?: string, value?: unknown) => void) {
  if (!report.findings.length) {
    return h('div', { className: 'pd-empty' }, '没有任何问题：所有插件的依赖服务都到位，必填配置也都填了。')
  }
  return h('div', null, ...report.findings.map((finding) => h('article', { key: finding.id, className: 'pd-card' },
    h('h3', null,
      h('span', { className: `pd-chip ${finding.severity}` }, SEVERITY_TEXT[finding.severity] ?? finding.severity),
      finding.title,
    ),
    h('p', { className: 'pd-why' }, finding.detail),
    h('p', { className: 'pd-sug' }, h('b', null, '怎么修：'), finding.suggestion),
    finding.candidates && finding.candidates.length
      ? h('p', { className: 'pd-why' }, '候选：', ...finding.candidates.map((name, index) => h('span', { key: index }, index ? '、' : '', h('span', { className: 'pd-code' }, name))))
      : null,
    h('div', { className: 'pd-cardfoot' },
      h('span', { className: 'pd-chip' }, finding.plugin),
      finding.fix && finding.fix.kind !== 'set-field'
        ? h('button', {
          className: 'pd-btn pd-primary',
          disabled: busy,
          onClick: () => void runFix(finding.entryId, finding.fix!.kind, finding.fix!.path, finding.fix!.value),
        }, finding.fix.label)
        : null,
      finding.fix && finding.fix.kind === 'set-field'
        ? h('span', { className: 'pd-code' }, `去「首次配置」填 ${finding.fix.path}`)
        : null,
    ),
  )))
}

function renderFirstRun(
  report: DoctorReport,
  drafts: Record<string, string>,
  setDrafts: (update: (prev: Record<string, string>) => Record<string, string>) => void,
  busy: boolean,
  save: (item: FirstRunItem) => void,
  ack: (entryId: string) => void,
) {
  if (!report.firstRun.length) {
    return h('div', { className: 'pd-empty' }, '没有待配置的插件。新装插件第一次出现在 composition 里时会自动列到这里。')
  }
  return h('div', null, ...report.firstRun.map((item) => h('article', { key: item.entryId, className: 'pd-card' },
    h('h3', null,
      h('span', { className: `pd-chip ${item.note === '新安装' ? 'warning' : ''}` }, item.note),
      item.plugin,
    ),
    item.missingServices.length
      ? h('p', { className: 'pd-why pd-missing' }, `还缺服务：${item.missingServices.join('、')}（这个填字段解决不了，要装/启用提供者）`)
      : null,
    ...item.gaps.map((gap) => h('div', { key: gap.path, className: 'pd-field' },
      h('label', { title: gap.description ?? gap.path }, gap.path, gap.secret ? h('span', { className: 'pd-chip' }, '密钥') : null),
      h('input', {
        type: gap.secret ? 'password' : 'text',
        placeholder: gap.problem === 'placeholder' ? '当前是占位值，请填真实值' : '必填',
        value: drafts[`${item.entryId}:${gap.path}`] ?? '',
        onChange: (event: any) => {
          const value = event.target.value
          setDrafts((prev) => ({ ...prev, [`${item.entryId}:${gap.path}`]: value }))
        },
      }),
      gap.defaultValue !== undefined && gap.defaultValue !== null
        ? h('button', {
          className: 'pd-btn',
          disabled: busy,
          onClick: () => setDrafts((prev) => ({ ...prev, [`${item.entryId}:${gap.path}`]: String(gap.defaultValue) })),
        }, `默认 ${String(gap.defaultValue)}`)
        : h('span'),
    )),
    h('div', { className: 'pd-cardfoot' },
      h('button', { className: 'pd-btn pd-primary', disabled: busy, onClick: () => save(item) }, '保存并热更新'),
      h('button', { className: 'pd-btn pd-ghost', disabled: busy, onClick: () => ack(item.entryId) }, '稍后配置'),
      h('span', { className: 'pd-why' }, '保存走 Loader 的 config 校验与热更新，不用重启 dsh。'),
    ),
  )))
}

function renderGraph(report: DoctorReport) {
  const rows = report.services
    .filter((service) => service.consumers.length || !service.available || service.providers.length)
    .sort((a, b) => Number(a.available) - Number(b.available) || b.consumers.length - a.consumers.length)
  if (!rows.length) return h('div', { className: 'pd-empty' }, '没有采集到服务依赖关系。')
  return h('div', null,
    h('div', { className: 'pd-note' }, '每行是一个宿主服务：谁提供它、谁在等它。红色的服务当前没有可用提供者 —— 等它的插件都会静默失效。'),
    h('table', { className: 'pd-table' },
      h('thead', null, h('tr', null,
        h('th', null, '服务'), h('th', null, '状态'), h('th', null, '提供者'), h('th', null, '消费方'),
      )),
      h('tbody', null, ...rows.map((service) => h('tr', { key: service.name },
        h('td', { className: 'pd-mono' }, service.name),
        h('td', { className: service.available ? 'pd-ok' : 'pd-missing' }, service.available ? '在位' : '缺失'),
        h('td', null, service.providers.length ? service.providers.join('、') : '—'),
        h('td', null, service.consumers.length ? service.consumers.join('、') : '—'),
      ))),
    ),
  )
}

function renderEntries(report: DoctorReport) {
  return h('table', { className: 'pd-table' },
    h('thead', null, h('tr', null,
      h('th', null, '插件'), h('th', null, '状态'), h('th', null, '缺服务'), h('th', null, '待填'), h('th', null, '提供'),
    )),
    h('tbody', null, ...report.entries.map((entry) => h('tr', { key: entry.entryId },
      h('td', { className: 'pd-mono' }, entry.plugin),
      h('td', { className: entry.severity === 'error' ? 'pd-missing' : entry.disabled ? '' : 'pd-ok' }, entry.state),
      h('td', { className: entry.missingServices.length ? 'pd-missing' : '' }, entry.missingServices.length ? entry.missingServices.join('、') : '—'),
      h('td', null, entry.gaps.length ? entry.gaps.map((gap) => gap.path).join('、') : '—'),
      h('td', null, entry.provides.length ? entry.provides.join('、') : '—'),
    ))),
  )
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

// ── 装配 ─────────────────────────────────────────────────────────────────────
export const inject = ['slots']

export function apply(ctx: any): void {
  ensureStyle()
  const slots = ctx?.slots
  if (!slots) return

  /** 整页跳转（宿主 layout 服务）；拿不到就只留侧栏入口。 */
  let openPanel: () => void = () => {}

  // 侧栏入口：id 与 main 槽的 key 同名，宿主据此把图标和面板对上。
  ctx.effect(() => slots.inject('sidebar.panellist', () => slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 32,
    label: () => '插件体检',
  }, (props: any) => h(DoctorIcon, { size: props?.size ?? 18, active: Boolean(props?.active) }))), `${NS}: sidebar entry`)

  // 点入口后整页打开的面板
  ctx.effect(() => slots.inject('main', () => slots.register({
    name: 'main',
    key: PANEL_ID,
  }, () => h(Panel, null))), `${NS}: main panel`)

  // 侧栏底部再加一个快捷入口（老宿主没有 panellist 时的兜底，也是常用位置）
  ctx.effect(() => slots.inject('sidebar.footer.action', () => slots.register({
    name: 'sidebar.footer.action',
    id: `${PANEL_ID}-footer`,
    order: 46,
    label: '插件体检',
  }, () => h('button', {
    className: 'pd-footbtn',
    title: '插件体检：缺密钥 / 缺服务 / 依赖关系',
    onClick: () => openPanel(),
  }, h(DoctorIcon, { size: 16 })))), `${NS}: footer action`)

  ctx.inject(['layout'], (sub: any) => {
    if (sub?.layout?.selectPanel) openPanel = () => sub.layout.selectPanel(PANEL_ID)
  })
}
