/**
 * PluginRegistry 服务实现：把运行期真值（Loader entry + fiber + reflect + schemastery）
 * 与盘上真值（PLUGIN_ROOT 目录 + profile package.json + 注入器 registry）合成一份
 * `PluginRegistryReport`，并对外提供 6 个操作。
 *
 * 与 doctor.ts 的分工：doctor 管"配置缺什么、服务缺什么"，这里管
 * "插件在哪、什么状态、怎么启停/卸载/更新、日志是什么"。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

import {
  PLUGIN_ROOT,
  assertInsideRoot,
  dirSizeMB,
  dlog,
  ensureRoot,
  injectorRegistryPath,
  isGitRepo,
  logCandidates,
  pluginDirOf,
  profileDir,
  readJsonSafe,
  removePluginDir,
  repositoryUrlOf,
  runGit,
  scanPluginRoot,
  writeJsonAtomic,
  type PluginConfigField,
  type PluginRegistryEntry,
  type PluginRegistryReport,
  type PluginStatus,
} from './registry.js'

/** 从 file:/// 模块 specifier 还原包名。 */
export function packageOf(specifier: string): string {
  if (!specifier) return '(未知)'
  if (specifier.startsWith('node:')) return specifier
  let s = specifier
  if (s.startsWith('file://')) {
    try {
      s = decodeURIComponent(new URL(s).pathname)
    } catch {
      s = s.slice(7)
    }
    s = s.split('\\').join('/').replace(/^\/([A-Za-z]:)/, '$1')
    const marker = '/node_modules/'
    const i = s.lastIndexOf(marker)
    if (i >= 0) s = s.slice(i + marker.length)
    else return s.split('/').filter(Boolean).slice(-2).join('/')
  }
  const parts = s.split('/')
  if (s.startsWith('@')) return parts.slice(0, 2).join('/')
  return parts[0]
}

const SECRET_KEY = /^(api[-_]?key|apikey|access[-_]?key|secret|client[-_]?secret|private[-_]?key|token|password|passwd|pwd|bearer|credential|credentials)$/i
const SECRET_DESC = /(api\s*key|密钥|秘钥|令牌|密码|token|secret|凭证|授权码)/i

function mask(value: string): string {
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 4)}••••${value.slice(-4)}`
}

/** 走 schemastery schema（type/dict/meta/inner），摊平成可展示/可校验的字段表。 */
export function flattenSchema(schema: any, value: any, out: PluginConfigField[], prefix = '', depth = 0): void {
  if (!schema || depth > 8) return
  const meta = schema.meta ?? {}
  if (schema.type === 'object' && schema.dict && typeof schema.dict === 'object') {
    const present = value !== null && value !== undefined
    for (const [key, child] of Object.entries(schema.dict as Record<string, any>)) {
      flattenSchema(child, present ? value[key] : undefined, out, prefix ? `${prefix}.${key}` : key, depth + 1)
    }
    return
  }
  if (!prefix) return
  const key = prefix.split('.').pop() as string
  const desc = typeof meta.description === 'string' ? meta.description : undefined
  const secret = SECRET_KEY.test(key) || Boolean(desc && SECRET_DESC.test(desc) && schema.type === 'string')
  let problem: string | undefined
  if (value === undefined || value === null) {
    if (meta.required) problem = 'missing'
  } else if (typeof value === 'string' && value.trim() === '') {
    if (meta.required) problem = 'missing'
  }
  out.push({
    path: prefix,
    label: desc && desc.length <= 42 ? desc : key,
    value: secret && typeof value === 'string' && value !== '' ? mask(value) : value,
    secret,
    required: Boolean(meta.required),
    problem,
  })
}

const STATE_LABEL: Record<number, PluginStatus> = {
  0: 'unconfigured',
  1: 'installing',
  2: 'enabled',
  3: 'failed',
  4: 'unknown',
  5: 'unknown',
}

/** 由 loader entry + 盘上信息合成 registry 报告。 */
export function buildRegistry(ctx: any, logger?: any): PluginRegistryReport {
  const warnings: string[] = []
  ensureRoot()

  // 盘上：PLUGIN_ROOT 下每个目录的 package.json
  const onDisk = scanPluginRoot()
  // profile 依赖规格（用于判断 source 与 repository）
  const profilePkg = readJsonSafe(join(profileDir(), 'package.json')) ?? {}
  const profileDeps: Record<string, string> = profilePkg.dependencies ?? {}
  // 注入器 registry
  const injected: Array<{ dir: string; name: string }> = Array.isArray(readJsonSafe(injectorRegistryPath()))
    ? readJsonSafe(injectorRegistryPath())
    : []
  const injectedByName = new Map(injected.map((row) => [row.name, row.dir]))

  const editor = safeGet(ctx, 'configEditor')
  const reflect = safeGet(ctx, 'reflect')
  let rawEntries: any[] = []
  try {
    rawEntries = editor?.entries?.() ?? []
  } catch (error) {
    warnings.push(`configEditor.entries() 调用失败：${errText(error)}`)
  }

  // 服务可用性
  const available = (name: string): boolean => {
    try {
      if (typeof reflect?._getImpl === 'function') return Boolean(reflect._getImpl(name))
      return ctx.get?.(name) !== undefined
    } catch {
      return false
    }
  }
  // fiber -> 提供的服务
  const providesByFiber = new Map<any, string[]>()
  try {
    const impls: any[] = reflect?.store ? Object.values(reflect.store) : []
    for (const impl of impls) {
      if (!impl || typeof impl.name !== 'string') continue
      if (typeof impl.check === 'function') {
        try {
          if (!impl.check()) continue
        } catch {
          continue
        }
      }
      const list = providesByFiber.get(impl.fiber) ?? []
      list.push(impl.name)
      providesByFiber.set(impl.fiber, list)
    }
  } catch (error) {
    warnings.push(`reflect.store 读取失败：${errText(error)}`)
  }

  const plugins: PluginRegistryEntry[] = []
  const seen = new Set<string>()

  for (const entry of rawEntries) {
    if (!entry?.options || entry.options.group) continue
    const name = packageOf(entry.options.name ?? '')
    const entryId: string = entry.id
    seen.add(name)
    const fiber = entry.fiber
    const stateCode: number | null = typeof fiber?.state === 'number' ? fiber.state : null
    const disabled = Boolean(entry.disabled)

    let status: PluginStatus = disabled ? 'disabled' : (STATE_LABEL[stateCode ?? -1] ?? 'unknown')
    if (!disabled && fiber === undefined) status = 'unknown'

    // 目录：优先用白名单根目录下的同名目录
    const leaf = name.replace(/^@[^/]+\//, '')
    const guessDir = existsSync(join(PLUGIN_ROOT, leaf)) ? join(PLUGIN_ROOT, leaf) : ''
    const onDiskHit = Boolean(guessDir) && onDisk.has(leaf)

    // 配置字段
    const config: PluginConfigField[] = []
    const schema = fiber?.runtime?.Config
    if (schema) {
      try {
        flattenSchema(schema, entry.options.config ?? {}, config)
      } catch {
        /* 坏 schema 不该让整张表塌掉 */
      }
    }

    // 错误
    const errors: string[] = []
    if (!disabled && stateCode === 3) {
      const failure = fiber?._error
      errors.push(failure instanceof Error ? failure.message : failure ? String(failure) : 'apply() 抛错，详见宿主日志')
    }
    for (const field of config) {
      if (field.problem) errors.push(`配置缺项：${field.path}`)
    }

    const requires: string[] = (() => {
      const fromFiber = fiber?.inject && typeof fiber.inject === 'object' ? Object.keys(fiber.inject) : []
      if (fromFiber.length) return fromFiber
      const raw = entry?.options?.inject
      if (Array.isArray(raw)) return raw.filter((x: unknown) => typeof x === 'string')
      if (raw && typeof raw === 'object') return Object.keys(raw)
      return []
    })()
    const missing = requires.filter((s) => !available(s))
    if (!disabled && missing.length) errors.push(`缺少服务：${missing.join(', ')}`)
    if (!disabled && missing.length && status !== 'failed') status = 'unconfigured'

    const pkg = onDiskHit ? onDisk.get(leaf) : readJsonSafe(join(guessDir, 'package.json'))

    let source: PluginRegistryEntry['source'] = 'unknown'
    if (injectedByName.has(name)) source = 'injected'
    else if (Object.hasOwn(profileDeps, name)) source = 'profile'
    else if (name.startsWith('@deepseek-ai/')) source = 'builtin'
    else if (profilePkg?.dsh?.profile?.bundles?.includes(name)) source = 'bundle'

    plugins.push({
      id: entryId,
      name,
      version: typeof pkg?.version === 'string' ? pkg.version : '—',
      status,
      path: guessDir,
      config,
      errors,
      provides: providesByFiber.get(fiber) ?? [],
      requires,
      source,
      onDisk: onDiskHit,
      repository: repositoryUrlOf(pkg),
      disabled,
    })
  }

  // 盘上有、但当前 composition 里没挂载的（迁移后未重载 / 已卸载残留）
  for (const [leaf, pkg] of onDisk) {
    const name = pkg?.name ?? leaf
    if (seen.has(name)) continue
    plugins.push({
      id: leaf,
      name,
      version: typeof pkg?.version === 'string' ? pkg.version : '—',
      status: 'disabled',
      path: join(PLUGIN_ROOT, leaf),
      config: [],
      errors: ['未挂载到当前 composition（需重新装配或启用）'],
      provides: [],
      requires: [],
      source: injectedByName.has(name) ? 'injected' : 'profile',
      onDisk: true,
      repository: repositoryUrlOf(pkg),
      disabled: true,
    })
  }

  plugins.sort((a, b) => {
    const rank = (s: PluginStatus) => (s === 'failed' ? 0 : s === 'unconfigured' ? 1 : s === 'disabled' ? 3 : 2)
    return rank(a.status) - rank(b.status) || a.name.localeCompare(b.name)
  })

  // 同一个包的多个 entry（例如 dsh-purge 自带 redteam / redteam-store / redteam-ui 三条）
  // 合并成一行：状态取最好的，路径/service 取并集，避免列表里同一个插件出现 4 次。
  const merged = mergeByName(plugins)

  return {
    generatedAt: new Date().toISOString(),
    root: PLUGIN_ROOT,
    summary: {
      total: merged.length,
      enabled: merged.filter((p) => p.status === 'enabled').length,
      disabled: merged.filter((p) => p.disabled).length,
      failed: merged.filter((p) => p.status === 'failed').length,
      unconfigured: merged.filter((p) => p.status === 'unconfigured').length,
      onDisk: merged.filter((p) => p.onDisk).length,
    },
    plugins: merged,
    warnings,
  }
}

const STATUS_RANK: Record<PluginStatus, number> = {
  failed: 0,
  unconfigured: 1,
  installing: 2,
  enabled: 3,
  unknown: 4,
  disabled: 5,
}

/**
 * 同一包名的多条 entry 合并成一条。
 *
 * 为什么需要：一个包可以往 composition 里塞多条 entry（`dsh-purge/redteam`、
 * `dsh-purge/redteam/ui` 都解析成包名 `dsh-purge`），逐条列出来会让"已装插件"
 * 变成 4 行同一个东西。这里保留**最严重**的那条状态（failed 优先暴露），
 * 其余字段取并集，`id` 用第一条的、`entryIds` 记全。
 */
function mergeByName(rows: PluginRegistryEntry[]): PluginRegistryEntry[] {
  const groups = new Map<string, PluginRegistryEntry[]>()
  for (const row of rows) {
    const key = row.name
    const list = groups.get(key) ?? []
    list.push(row)
    groups.set(key, list)
  }
  const out: PluginRegistryEntry[] = []
  for (const [, list] of groups) {
    if (list.length === 1) {
      out.push(list[0])
      continue
    }
    const sorted = [...list].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status])
    const head = sorted[0]
    out.push({
      ...head,
      provides: [...new Set(list.flatMap((r) => r.provides))].sort(),
      requires: [...new Set(list.flatMap((r) => r.requires))].sort(),
      errors: [...new Set(list.flatMap((r) => r.errors))],
      config: head.config,
      disabled: list.every((r) => r.disabled),
      /** 所有合成此行的 entry id，便于 toggle/uninstall 精确定位。 */
      ...(sorted.length > 1 ? { entryCount: sorted.length } : {}),
    } as PluginRegistryEntry)
  }
  return out.sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || a.name.localeCompare(b.name))
}

// ── 操作 ────────────────────────────────────────────────────────────────────

/**
 * 按 id / 包名 / 包名短名找 Loader entry。
 *
 * 匹配顺序（从严到宽，**不做子串匹配**）：
 *  1. `entry.id === pluginId`（精确 entry id）
 *  2. `packageOf(entry.options.name) === pluginId`（精确包名）
 *  3. 包名去掉 scope 后 === pluginId（精确短名）
 *
 * 为什么禁止子串：`dsh-compact` 会误命中 `@deepseek-ai/dsh-compaction-basic`，
 * `dsh-purge` 会误命中 `dsh-purge/redteam`（后者是子入口，不是主入口）。
 */
export function findEntry(ctx: any, pluginId: string): any {
  const editor = safeGet(ctx, 'configEditor')
  const needle = String(pluginId).trim()
  const candidates: any[] = []
  try {
    for (const entry of editor?.entries?.() ?? []) candidates.push(entry)
  } catch {
    /* configEditor 不可用就用 loader 全量兜底 */
  }
  if (!candidates.length) {
    const loader = safeGet(ctx, 'loader')
    try {
      for (const entry of loader?.entries?.() ?? []) candidates.push(entry)
    } catch {
      /* ignore */
    }
  }

  const usable = candidates.filter((entry) => entry && !entry.options?.group)

  // 1) 精确 entry id
  const byId = usable.find((entry) => entry.id === needle)
  if (byId) return byId

  // 2) 精确包名 / 3) 精确包名短名
  //    先找"主入口"（specifier 就是包名本身，不带 /sub 子路径），
  //    再退到子入口（dsh-purge/redteam 这类）——否则 toggle dsh-purge 会切到子入口上。
  const matches = (entry: any): boolean => {
    const pkg = packageOf(entry.options?.name ?? '')
    if (!pkg) return false
    if (pkg === needle) return true
    return pkg.replace(/^@[^/]+\//, '') === needle
  }
  const isPrimary = (entry: any): boolean => {
    const spec = String(entry.options?.name ?? '')
    return !spec.includes('/') || spec.startsWith('@') && spec.split('/').length === 2
  }
  const byPrimary = usable.find((entry) => matches(entry) && isPrimary(entry))
  if (byPrimary) return byPrimary

  const byName = usable.find(matches)
  if (byName) return byName

  return undefined
}

export interface ToggleResult {
  ok: boolean
  message: string
  plugin?: string
  status?: PluginStatus
}

/**
 * 启用 / 禁用插件。
 *
 * disable：`entry.update({ disabled: true })` —— Loader 会 dispose 该 fiber，
 *          它注入的 tools / agents 随之卸载（这就是"移除注入"的宿主级做法）。
 * enable ：`entry.update({ disabled: false })` 后重新校验配置；有必填缺口就报告出来。
 */
export async function togglePlugin(ctx: any, pluginId: string, enabled: boolean): Promise<ToggleResult> {
  const entry = findEntry(ctx, pluginId)
  if (!entry) return { ok: false, message: `找不到插件 ${pluginId}（可能已卸载或从未挂载）` }
  const name = packageOf(entry.options?.name ?? '')
  if (typeof entry.update !== 'function') {
    return { ok: false, message: `${name} 的 entry 不支持运行时改写（Loader 未暴露 update）` }
  }
  try {
    await entry.update({ disabled: !enabled })
  } catch (error) {
    dlog(`toggle ${name} -> ${enabled} FAILED: ${errText(error)}`)
    return { ok: false, message: `切换失败：${errText(error)}`, plugin: name }
  }

  if (!enabled) {
    dlog(`toggle ${name} -> disabled (fiber disposed)`)
    return { ok: true, message: `已禁用 ${name}：fiber 已 dispose，其注入的工具/服务已从宿主移除`, plugin: name, status: 'disabled' }
  }

  // 启用后复核：fiber 是否真的起来了、配置是否有缺口
  const after = findEntry(ctx, pluginId)
  const fiber = after?.fiber
  const stateCode: number | null = typeof fiber?.state === 'number' ? fiber.state : null
  if (stateCode === 3) {
    const failure = fiber?._error
    return {
      ok: false,
      message: `已尝试启用 ${name}，但 apply() 抛错：${failure instanceof Error ? failure.message : String(failure ?? '详见日志')}`,
      plugin: name,
      status: 'failed',
    }
  }
  const gaps: string[] = []
  const schema = fiber?.runtime?.Config
  if (schema) {
    const fields: PluginConfigField[] = []
    try {
      flattenSchema(schema, after?.options?.config ?? {}, fields)
    } catch {
      /* ignore */
    }
    for (const field of fields) if (field.problem) gaps.push(field.path)
  }
  if (gaps.length) {
    dlog(`toggle ${name} -> enabled but config gaps: ${gaps.join(', ')}`)
    return {
      ok: true,
      message: `已启用 ${name}，但配置仍有缺口：${gaps.join(', ')}（用 validate_plugin_config 看详情）`,
      plugin: name,
      status: 'unconfigured',
    }
  }
  dlog(`toggle ${name} -> enabled (fiber active)`)
  return { ok: true, message: `已启用 ${name}（fiber active，工具/服务已重新注入）`, plugin: name, status: 'enabled' }
}

export interface UninstallResult {
  ok: boolean
  message: string
  removedDir?: boolean
  removedEnv?: boolean
}

/**
 * 卸载插件：先摘引用（entry 禁用 + profile 依赖 + 注入器 registry），再删目录。
 * 顺序很重要——先摘引用能保证 Loader 不再持有该路径，再删盘才不会触发 ENOENT 风暴。
 */
export async function uninstallPlugin(ctx: any, pluginId: string): Promise<UninstallResult> {
  const entry = findEntry(ctx, pluginId)
  const name = entry ? packageOf(entry.options?.name ?? '') : String(pluginId).trim()
  const leaf = name.replace(/^@[^/]+\//, '')
  const dir = join(PLUGIN_ROOT, leaf)
  const notes: string[] = []

  // 1) 禁用 entry（fiber dispose）
  if (entry && typeof entry.update === 'function') {
    try {
      await entry.update({ disabled: true })
      notes.push('已从 composition 摘除（entry 已禁用）')
    } catch (error) {
      notes.push(`禁用 entry 失败：${errText(error)}`)
    }
  }

  // 2) profile package.json 依赖
  let removedEnv = false
  const pkgPath = join(profileDir(), 'package.json')
  try {
    const pkg = readJsonSafe(pkgPath)
    if (pkg?.dependencies && Object.hasOwn(pkg.dependencies, name)) {
      delete pkg.dependencies[name]
      if (Array.isArray(pkg?.dsh?.profile?.bundles)) {
        pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b: string) => b !== name)
      }
      writeJsonAtomic(pkgPath, pkg)
      removedEnv = true
      notes.push('已清理 profile 依赖与 bundles 条目')
    }
  } catch (error) {
    notes.push(`清理 profile package.json 失败：${errText(error)}`)
  }

  // 3) 注入器 registry
  try {
    const regPath = injectorRegistryPath()
    const rows = readJsonSafe(regPath)
    if (Array.isArray(rows)) {
      const next = rows.filter((row: any) => row?.name !== name)
      if (next.length !== rows.length) {
        writeJsonAtomic(regPath, next)
        notes.push('已从注入器 registry 移除')
      }
    }
  } catch (error) {
    notes.push(`清理注入器 registry 失败：${errText(error)}`)
  }

  // 4) 删目录（白名单内）
  let removedDir = false
  try {
    if (existsSync(dir)) {
      removePluginDir(dir)
      removedDir = true
      notes.push(`已删除目录 ${dir}`)
    } else {
      notes.push('目录本就不存在，跳过删除')
    }
  } catch (error) {
    return { ok: false, message: `删除目录失败：${errText(error)}（引用已摘除）`, removedDir: false, removedEnv }
  }

  dlog(`uninstall ${name}: ${notes.join('；')}`)
  return { ok: true, message: `${name}：${notes.join('；')}`, removedDir, removedEnv }
}

export interface UpdateResult {
  ok: boolean
  message: string
  offline?: boolean
  before?: string
  after?: string
  dir?: string
}

/**
 * 从 GitHub 更新插件。
 *
 * 有 .git → `git fetch --all` + `git reset --hard origin/<ref>`（比 pull 干净，不受本地脏工作区影响）
 * 无 .git → `git clone <repository> <dir>`（目录已存在则报错，避免覆盖用户改动）
 * 网络不可用 → 返回 offline=true，让调用方提示"手动更新"，而不是抛错。
 */
export async function updatePlugin(
  ctx: any,
  pluginId: string,
  ref?: string,
  repository?: string,
): Promise<UpdateResult> {
  const entry = findEntry(ctx, pluginId)
  const name = entry ? packageOf(entry.options?.name ?? '') : String(pluginId).trim()
  const leaf = name.replace(/^@[^/]+\//, '')
  const dir = assertInsideRoot(join(PLUGIN_ROOT, leaf))

  const pkg = readJsonSafe(join(dir, 'package.json'))
  const url = repository || repositoryUrlOf(pkg) || injectedRepo(name)
  if (!url) {
    return {
      ok: false,
      message: `${name} 的 package.json 里没有 repository 字段，请显式传入 repository（或在该插件 config 里配置 githubRepo）。`,
    }
  }
  const branch = (ref || pkg?.dsh?.updateRef || 'main').trim()

  if (!existsSync(dir)) {
    // 直接 clone 到目标目录
    const parent = assertInsideRoot(PLUGIN_ROOT)
    const clone = await runGit(parent, ['clone', '--depth', '1', '--branch', branch, url, leaf], 180_000)
    if (!clone.ok) {
      if (clone.offline) {
        return { ok: false, offline: true, message: `网络不可用，无法从 ${url} 拉取；请联网后重试，或手动下载解压到 ${dir}。`, dir }
      }
      return { ok: false, message: `git clone 失败：${clone.output.slice(0, 800)}`, dir }
    }
    reloadAfterChange(ctx, entry)
    return { ok: true, message: `已 clone ${url}（${branch}）到 ${dir}`, dir, after: 'fresh-clone' }
  }

  if (!isGitRepo(dir)) {
    return {
      ok: false,
      message: `${dir} 不是 git 工作区（无 .git），无法自动更新。请手动覆盖文件，或先 git clone 到该目录。`,
      dir,
    }
  }

  // 更新前先看工作区脏不脏：`reset --hard` 会丢掉未提交改动，
  // 这是"更新把用户改了一半的配置冲掉"的经典事故，必须先拦。
  const dirty = await runGit(dir, ['status', '--porcelain'], 15_000)
  if (dirty.ok && dirty.output.trim() !== '') {
    const changed = dirty.output.trim().split(/\r?\n/).slice(0, 8).join('; ')
    dlog(`update ${name}: REFUSED — working tree dirty (${changed})`)
    return {
      ok: false,
      message:
        `${name} 的工作区有未提交改动，已拒绝自动更新（reset --hard 会冲掉它们）。\n` +
        `改动文件：${changed}\n` +
        `请先 \`git -C "${dir}" add -A && git -C "${dir}" commit -m "..."\` 或 \`git -C "${dir}" stash\`，再重试。`,
      dir,
    }
  }

  const before = await runGit(dir, ['rev-parse', '--short', 'HEAD'])
  const fetch = await runGit(dir, ['fetch', '--all', '--tags', '--prune'], 120_000)
  if (!fetch.ok) {
    if (fetch.offline) {
      dlog(`update ${name}: OFFLINE (keep ${before.output || 'unknown'})`)
      return {
        ok: false,
        offline: true,
        message: `网络不可用，无法从远端拉取更新（当前保留 ${before.output || '未知'} 版本）。请联网后重试，或手动 git pull。`,
        dir,
        before: before.output,
      }
    }
    dlog(`update ${name}: git fetch FAILED ${fetch.output.slice(0, 200)}`)
    return { ok: false, message: `git fetch 失败：${fetch.output.slice(0, 800)}`, dir, before: before.output }
  }

  const reset = await runGit(dir, ['reset', '--hard', `origin/${branch}`], 60_000)
  if (!reset.ok) {
    return { ok: false, message: `git reset --hard origin/${branch} 失败：${reset.output.slice(0, 800)}`, dir, before: before.output }
  }
  const after = await runGit(dir, ['rev-parse', '--short', 'HEAD'])
  reloadAfterChange(ctx, entry)
  const changed = before.output !== after.output
  dlog(`update ${name}: ${before.output} -> ${after.output} (${branch}) changed=${changed}`)
  return {
    ok: true,
    message: changed
      ? `已更新 ${name}：${before.output} → ${after.output}（${branch}）${needsRebuild(dir) ? '；注意：该插件源码有改动，需 npm run build 后重载' : ''}`
      : `已是最新（${after.output}，${branch}）`,
    dir,
    before: before.output,
    after: after.output,
  }
}

/** 更新后尽量热重载该 entry；拿不到 loader/hmr 就提示重启。 */
function reloadAfterChange(ctx: any, entry: any): void {
  try {
    const hmr = ctx.get?.('hmr')
    if (hmr?.runExclusive && entry?.id) {
      void hmr.runExclusive(async () => {
        const loader = ctx.get?.('loader')
        await loader?.refresh?.()
      })
      return
    }
    const loader = ctx.get?.('loader')
    void loader?.refresh?.()
  } catch {
    /* 热重载失败不影响更新结果本身 */
  }
}

/** 插件源码是否比 lib/ 产物新（提示需要重新构建）。 */
function needsRebuild(dir: string): boolean {
  const srcDir = join(dir, 'src')
  const libDir = join(dir, 'lib')
  if (!existsSync(srcDir) || !existsSync(libDir)) return false
  return newestMtime(srcDir) > newestMtime(libDir)
}

/** 目录下所有文件里最新的 mtime；读不到返回 0。 */
function newestMtime(dir: string, depth = 0): number {
  if (depth > 6) return 0
  let max = 0
  let items: any[] = []
  try {
    items = readdirSync(dir, { withFileTypes: true }) as any
  } catch {
    return 0
  }
  for (const item of items) {
    const full = join(dir, item.name)
    try {
      if (item.isDirectory()) {
        max = Math.max(max, newestMtime(full, depth + 1))
      } else {
        max = Math.max(max, statSync(full).mtimeMs)
      }
    } catch {
      /* 单个文件读不到不影响整体判断 */
    }
  }
  return max
}

/** 注入器 registry 里记录的 dir 是否带 .git 可作兜底（拿不到 repository 时）。 */
function injectedRepo(name: string): string | undefined {
  const rows = readJsonSafe(injectorRegistryPath())
  if (!Array.isArray(rows)) return undefined
  const row = rows.find((r: any) => r?.name === name)
  if (!row?.dir) return undefined
  const pkg = readJsonSafe(join(row.dir, 'package.json'))
  return repositoryUrlOf(pkg)
}

export interface ValidateResult {
  ok: boolean
  plugin: string
  errors: Array<{ path: string; message: string; kind: 'missing' | 'placeholder' | 'invalid' | 'env-missing' | 'path-missing' }>
  fields: PluginConfigField[]
  message: string
}

const PLACEHOLDER = /^(<[^>]+>|your[-_ ].*|your.*|xxx+|changeme|change[-_]me|todo|tbd|placeholder|sk-x+|\*{3,}|…+|\.{3}|请填写.*|待填.*|填入.*|示例.*)$/i
const ENV_KEY = /(env|envName|envVar)$/i
const PATH_KEY = /(file|path|dir)$/i

/**
 * 用 schemastery 校验插件配置，返回**结构化**字段级错误。
 * 除了官方 schema 的必填判定，还额外查三类"能跑但一定错"的值：
 * 占位符、`*Env` 指向的环境变量为空、绝对路径不存在。
 */
export function validateConfig(ctx: any, pluginId: string): ValidateResult {
  const entry = findEntry(ctx, pluginId)
  if (!entry) {
    return { ok: false, plugin: String(pluginId), errors: [], fields: [], message: `找不到插件 ${pluginId}` }
  }
  const name = packageOf(entry.options?.name ?? '')
  const fiber = entry.fiber
  const schema = fiber?.runtime?.Config
  const raw = entry.options?.config ?? {}
  const fields: PluginConfigField[] = []
  if (schema) {
    try {
      flattenSchema(schema, raw, fields)
    } catch (error) {
      return { ok: false, plugin: name, errors: [], fields: [], message: `schema 遍历失败：${errText(error)}` }
    }
  }

  const errors: ValidateResult['errors'] = []
  for (const field of fields) {
    if (field.problem === 'missing') {
      errors.push({ path: field.path, message: field.required ? '必填项未填' : '值为空', kind: 'missing' })
      continue
    }
    const value = field.value
    if (typeof value !== 'string' || value === '') continue
    if (PLACEHOLDER.test(value.trim())) {
      errors.push({ path: field.path, message: '仍是占位值（示例/待填）', kind: 'placeholder' })
      continue
    }
    const key = field.path.split('.').pop() ?? ''
    if (ENV_KEY.test(key) && !(process.env[value] && String(process.env[value]).trim() !== '')) {
      errors.push({ path: field.path, message: `环境变量 ${value} 当前为空`, kind: 'env-missing' })
      continue
    }
    if (PATH_KEY.test(key) && /^([A-Za-z]:[\\/]|\/|~[\\/])/.test(value) && !existsSync(value)) {
      errors.push({ path: field.path, message: `路径不存在：${value}`, kind: 'path-missing' })
    }
  }

  // 官方 schema 的严格校验（schemastery 自带）
  const strict = strictCheck(schema, raw)
  if (strict) errors.push({ path: '(schema)', message: strict, kind: 'invalid' })

  if (errors.length) dlog(`validate ${name}: ${errors.length} problem(s) — ${errors.map((e) => e.path + ':' + e.kind).join(', ')}`)

  return {
    ok: errors.length === 0,
    plugin: name,
    errors,
    fields,
    message: errors.length
      ? `${name}：${errors.length} 处配置问题`
      : schema
        ? `${name}：配置通过校验`
        : `${name}：该插件没有声明 Config schema，无可校验项`,
  }
}
function strictCheck(schema: any, value: any): string | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  try {
    // schemastery 的 schema 是函数式的：直接调用会抛错表示不合法
    if (typeof schema === 'function') {
      const out = schema(value)
      if (typeof out === 'string') return out
      return undefined
    }
    if (typeof schema.check === 'function') {
      const out = schema.check(value)
      if (typeof out === 'string') return out
    }
  } catch (error) {
    return errText(error)
  }
  return undefined
}

export interface LogsResult {
  ok: boolean
  plugin: string
  files: string[]
  lines: string[]
  message: string
}

/**
 * 取某个插件最近的日志行。
 *
 * 来源：宿主把插件 console 输出写进 stdout/stderr 日志文件；本插件自己的行带
 * `[plugin-doctor]` 前缀，其它插件一般带自己的包名短名。这里按"包名 / 短名 /
 * entry id"三种模式去匹配，从新往旧取 limit 行。
 */
export function pluginLogs(pluginId: string, limit = 80): LogsResult {
  const entryName = String(pluginId).trim()
  const leaf = entryName.replace(/^@[^/]+\//, '')
  const patterns = [entryName, leaf].filter(Boolean).map((p) => p.toLowerCase())
  const isDoctorSelf = /plugin-doctor|dsh-plugin-doctor/.test(entryName)
  const found: string[] = []
  const filesUsed: string[] = []

  for (const file of logCandidates()) {
    if (!existsSync(file)) continue
    let isDir = false
    try {
      isDir = statSync(file).isDirectory()
    } catch {
      continue
    }
    if (isDir) continue
    let text = ''
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    const rows = text.split(/\r?\n/).filter((row) => row.trim() !== '')
    const before = found.length
    if (isDoctorSelf && /plugin-doctor\.log$/i.test(file)) {
      // doctor 自己的观测日志：全部行都属于本插件，不再按包名过滤
      found.push(...rows)
    } else {
      for (const row of rows) {
        const low = row.toLowerCase()
        if (patterns.some((p) => low.includes(p))) found.push(row)
      }
    }
    if (found.length > before) filesUsed.push(file)
  }

  const lines = found.slice(-Math.max(1, Math.min(limit, 500)))
  return {
    ok: lines.length > 0,
    plugin: entryName,
    files: filesUsed,
    lines,
    message: lines.length
      ? `${entryName}：命中 ${lines.length} 行日志（来自 ${filesUsed.join('、')}）`
      : `${entryName}：日志里没有匹配行。可能该插件不打印日志，或宿主日志未落盘（检查 dsh-c-out.log / DSH_LOG_FILE）`,
  }
}

// ── 小工具 ──────────────────────────────────────────────────────────────────

export function safeGet(ctx: any, name: string): any {
  try {
    return ctx.get?.(name)
  } catch {
    return undefined
  }
}

export function errText(error: unknown): string {
  if (error instanceof Error) return error.message
  return error ? String(error) : '未知错误'
}

/** 目录体积（供 UI 展示）。 */
export function pluginSizeMB(pluginId: string): number {
  try {
    const leaf = String(pluginId).replace(/^@[^/]+\//, '')
    const dir = join(PLUGIN_ROOT, leaf)
    return existsSync(dir) ? dirSizeMB(dir) : 0
  } catch {
    return 0
  }
}

export { basename, pluginDirOf }
