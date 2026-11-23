import { defineTool } from '@deepseek-ai/dsh-tools';
import z from '@deepseek-ai/schemastery';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { cloneConfig, scanComposition, setAt } from './doctor.js';
import { PLUGIN_ROOT, dlog, ensureRoot, injectorRegistryPath, readJsonSafe, setPluginRoot } from './registry.js';
import { buildRegistry, errText, pluginLogs, togglePlugin, uninstallPlugin, updatePlugin, validateConfig, } from './service.js';
import { registerTools, renderListMarkdown, renderListText } from './tools.js';
export const name = '@dsh-external/dsh-plugin-doctor';
export const inject = ['webServer'];
/**
 * 插件配置。
 *  - showInUi：list_installed_plugins 输出 Markdown 表格（true）还是紧凑文本（false）
 *  - pluginRoot：插件落盘根目录，默认 D:\deepseek\plugins（也可用 DSH_PLUGIN_ROOT 环境变量）
 */
export const Config = z.object({
    showInUi: z.boolean().default(true),
    pluginRoot: z.string().default('D:\\deepseek\\plugins'),
});
const API = '/@dsh-external/dsh-plugin-doctor/api';
const LOG_TAG = '[plugin-doctor]';
function profileDir() {
    const fromEnv = process.env.DSH_PROFILE_DIR;
    if (fromEnv)
        return fromEnv;
    const profile = process.env.DSH_PROFILE ?? 'desktop';
    return join(homedir(), '.dsh', 'profiles', profile);
}
function statePath() {
    return join(profileDir(), 'plugin-doctor.json');
}
function loadState() {
    const file = statePath();
    try {
        if (existsSync(file)) {
            const raw = JSON.parse(readFileSync(file, 'utf8'));
            return {
                known: Array.isArray(raw.known) ? raw.known.filter((item) => typeof item === 'string') : [],
                acked: Array.isArray(raw.acked) ? raw.acked.filter((item) => typeof item === 'string') : [],
                updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
            };
        }
    }
    catch (error) {
        console.warn(LOG_TAG, '读取状态文件失败，按首次运行处理', error);
    }
    return { known: [], acked: [], updatedAt: '' };
}
function saveState(state) {
    const file = statePath();
    try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    }
    catch (error) {
        console.warn(LOG_TAG, '写状态文件失败', error);
    }
}
/** 缓存最近一次报告：面板轮询时不必每次都扫全量。 */
let cached;
let dirty = true;
/**
 * 启动自检：插件根目录存在性 + 注入器 registry 是否还指向别的路径。
 * 这是"零散路径"问题的最后一道提醒 —— 不阻断启动，只把事实写进日志。
 */
function migrationSelfCheck() {
    try {
        ensureRoot();
        console.info(LOG_TAG, `插件根目录：${PLUGIN_ROOT}`);
        dlog(`startup: PLUGIN_ROOT=${PLUGIN_ROOT}`);
    }
    catch (error) {
        console.warn(LOG_TAG, `无法创建插件根目录 ${PLUGIN_ROOT}：${errText(error)}`);
        dlog(`startup ERROR: cannot create ${PLUGIN_ROOT} — ${errText(error)}`);
    }
    try {
        const rows = readJsonSafe(injectorRegistryPath());
        if (Array.isArray(rows)) {
            const outside = rows.filter((row) => {
                const dir = String(row?.dir ?? '');
                if (!dir)
                    return false;
                return !dir.toLowerCase().startsWith(PLUGIN_ROOT.toLowerCase());
            });
            if (outside.length) {
                console.warn(LOG_TAG, `注入器 registry 里有 ${outside.length} 个插件不在根目录下：${outside.map((r) => `${r.name}@${r.dir}`).join('、')}。` +
                    `建议迁移到 ${PLUGIN_ROOT} 后把 registry 的 dir 一并改掉。`);
                dlog(`startup WARN: ${outside.length} injector entries outside root: ${outside.map((r) => r.name).join(',')}`);
            }
        }
    }
    catch (error) {
        console.warn(LOG_TAG, `读取注入器 registry 失败：${errText(error)}`);
    }
}
export function apply(ctx, config) {
    const anyCtx = ctx;
    // config.pluginRoot 优先于环境变量；不填就用默认 D:\deepseek\plugins
    setPluginRoot(config?.pluginRoot);
    const state = loadState();
    const firstBoot = state.known.length === 0;
    const options = { showInUi: Boolean(config?.showInUi ?? true) };
    migrationSelfCheck();
    const readReport = (fresh) => {
        if (!fresh && cached && !dirty && Date.now() - cached.at < 4000)
            return cached.report;
        const report = scanComposition(ctx, state);
        // 第一次跑没有基线：别把已装的两百多个插件全报成"新安装"。
        if (firstBoot) {
            report.newPlugins = [];
            report.alerts = [];
            report.summary.newPlugins = 0;
            report.firstRun = report.firstRun.map((item) => ({ ...item, note: '待配置' }));
        }
        // known 只增不减：entry id 变了才算"新安装"
        const ids = new Set(report.entries.map((entry) => entry.entryId));
        const merged = new Set(state.known);
        for (const id of ids)
            merged.add(id);
        const added = report.entries.filter((entry) => !state.known.includes(entry.entryId)).map((entry) => entry.entryId);
        state.known = [...merged];
        if (added.length || firstBoot)
            saveState(state);
        cached = { report, at: Date.now() };
        dirty = false;
        if (!firstBoot && added.length) {
            const names = report.entries.filter((entry) => added.includes(entry.entryId)).map((entry) => entry.plugin);
            console.info(LOG_TAG, `新安装插件：${names.join('、')}（${added.length} 个），已生成首次配置清单`);
        }
        return report;
    };
    const readRegistry = () => buildRegistry(anyCtx, anyCtx.logger);
    const entryFor = (entryId) => {
        const editor = safeGet(anyCtx, 'configEditor');
        const entries = editor?.entries?.() ?? [];
        return entries.find((entry) => entry?.id === entryId && !entry.options?.group);
    };
    /** 把一条 finding 的修复执行掉。返回给界面的人话结果。 */
    const applyFix = async (input) => {
        const entry = entryFor(input.entryId);
        if (!entry)
            return { ok: false, message: `找不到 entry ${input.entryId}（可能刚被卸载）` };
        const editor = safeGet(anyCtx, 'configEditor');
        try {
            if (input.kind === 'enable') {
                if (typeof entry.update !== 'function')
                    return { ok: false, message: '该 entry 不支持运行时改写（Loader 未暴露 update）' };
                await entry.update({ disabled: false });
                dirty = true;
                return { ok: true, message: `已启用 ${entry.options?.name ?? input.entryId}` };
            }
            if (input.kind === 'fill-default' || input.kind === 'set-field') {
                if (!input.path)
                    return { ok: false, message: '缺少字段路径' };
                if (!editor?.edit)
                    return { ok: false, message: 'configEditor 服务不可用，没法写回配置' };
                const value = input.value;
                await editor.edit(entry, (current) => {
                    const next = cloneConfig(current);
                    setAt(next, input.path, value);
                    return next;
                });
                dirty = true;
                return { ok: true, message: `已写入 ${input.path}` };
            }
            return { ok: false, message: `未知修复类型 ${String(input.kind)}` };
        }
        catch (error) {
            return { ok: false, message: errText(error) };
        }
    };
    // ── 路由 ────────────────────────────────────────────────────────────────
    ctx.effect(() => anyCtx.webServer.register({
        kind: 'prefix',
        path: API,
        handler: async (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const tail = url.pathname.slice(API.length) || '/';
            const send = (status, payload) => {
                res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify(payload));
            };
            try {
                // ── 只读 ──
                if (tail === '/report' && req.method !== 'POST') {
                    return send(200, readReport(url.searchParams.get('fresh') === '1'));
                }
                if (tail === '/summary') {
                    const report = readReport(false);
                    const registry = readRegistry();
                    return send(200, { ...report.summary, registry, generatedAt: report.generatedAt, alerts: report.alerts });
                }
                if (tail === '/rescan') {
                    const report = readReport(true);
                    return send(200, report);
                }
                // ── 插件管理（GET） ──
                if (tail === '/plugins') {
                    const registry = readRegistry();
                    const format = url.searchParams.get('format');
                    if (format === 'text' || format === 'md') {
                        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(options.showInUi ? renderListMarkdown(registry) : renderListText(registry));
                        return;
                    }
                    return send(200, registry);
                }
                if (tail === '/logs') {
                    const pluginId = url.searchParams.get('pluginId') ?? '';
                    const limit = Number(url.searchParams.get('limit') ?? '80');
                    if (!pluginId)
                        return send(400, { error: '缺少 pluginId' });
                    return send(200, pluginLogs(pluginId, Number.isFinite(limit) ? limit : 80));
                }
                if (tail === '/validate') {
                    const pluginId = url.searchParams.get('pluginId') ?? '';
                    if (!pluginId)
                        return send(400, { error: '缺少 pluginId' });
                    return send(200, validateConfig(anyCtx, pluginId));
                }
                if (req.method !== 'POST')
                    return send(405, { error: '该操作只接受 POST' });
                const body = await readJson(req);
                // ── 插件管理（POST） ──
                if (tail === '/toggle') {
                    const pluginId = String(body?.pluginId ?? '');
                    if (!pluginId)
                        return send(400, { error: '缺少 pluginId' });
                    const result = await togglePlugin(anyCtx, pluginId, Boolean(body?.enabled));
                    console.info(LOG_TAG, `toggle ${pluginId} -> ${body?.enabled} :`, result.message);
                    dirty = true;
                    return send(200, { ...result, registry: readRegistry() });
                }
                if (tail === '/uninstall') {
                    const pluginId = String(body?.pluginId ?? '');
                    if (!pluginId)
                        return send(400, { error: '缺少 pluginId' });
                    const result = await uninstallPlugin(anyCtx, pluginId);
                    console.info(LOG_TAG, `uninstall ${pluginId} :`, result.message);
                    dirty = true;
                    return send(200, { ...result, registry: readRegistry() });
                }
                if (tail === '/update') {
                    const pluginId = String(body?.pluginId ?? '');
                    if (!pluginId)
                        return send(400, { error: '缺少 pluginId' });
                    const result = await updatePlugin(anyCtx, pluginId, body?.ref ? String(body.ref) : undefined, body?.repository ? String(body.repository) : undefined);
                    console.info(LOG_TAG, `update ${pluginId} :`, result.message);
                    dirty = true;
                    return send(200, { ...result, registry: readRegistry() });
                }
                // ── 配置体检修复 ──
                if (tail === '/fix') {
                    const entryId = String(body?.entryId ?? '');
                    const kind = String(body?.kind ?? '');
                    const result = await applyFix({ entryId, kind, path: body?.path, value: body?.value });
                    console.info(LOG_TAG, `修复 ${entryId} / ${kind} →`, result.ok ? 'OK' : result.message);
                    return send(200, { ...result, report: readReport(true) });
                }
                if (tail === '/fix-all') {
                    const report = readReport(false);
                    const safe = report.findings.filter((finding) => finding.fix && finding.fix.kind !== 'set-field');
                    const applied = [];
                    const failed = [];
                    for (const finding of safe) {
                        const fix = finding.fix;
                        const result = await applyFix({ entryId: finding.entryId, kind: fix.kind, path: fix.path, value: fix.value });
                        if (result.ok)
                            applied.push(`${finding.plugin}: ${fix.label}`);
                        else
                            failed.push({ id: finding.id, message: result.message });
                    }
                    return send(200, { ok: true, applied, failed, report: readReport(true) });
                }
                if (tail === '/ack') {
                    const ids = Array.isArray(body?.entryIds) ? body.entryIds.filter((item) => typeof item === 'string') : [];
                    state.acked = [...new Set([...state.acked, ...ids])];
                    saveState(state);
                    return send(200, { ok: true, acked: state.acked.length, report: readReport(true) });
                }
                return send(404, { error: `未知端点 ${tail}` });
            }
            catch (error) {
                console.warn(LOG_TAG, '路由异常', error);
                return send(500, { error: errText(error) });
            }
        },
    }), '@dsh-external/dsh-plugin-doctor: api');
    // ── 自动感知：新插件激活 / entry 增删，就把缓存打脏 ────────────────────────
    ctx.effect(() => anyCtx.on('internal/status', (fiber) => {
        if (!fiber)
            return;
        const entryId = fiber?.ctx?.fiber?.entry?.id ?? fiber?.entry?.id;
        if (typeof entryId === 'string') {
            dirty = true;
            // 已记录的 entry 不重复刷日志（原来是每个 fiber 都打一行，一天几千行）
            if (!state.known.includes(entryId)) {
                console.info(LOG_TAG, `新 entry 激活：${entryId}`);
            }
        }
    }), '@dsh-external/dsh-plugin-doctor: status watcher');
    ctx.effect(() => anyCtx.on('loader/entry-init', () => { dirty = true; }), '@dsh-external/dsh-plugin-doctor: entry watcher');
    // ── Agent 工具 ───────────────────────────────────────────────────────────
    ctx.inject(['tools'], (sub) => {
        // 原有：配置体检
        sub.effect(() => sub.tools.register(defineTool({
            name: 'plugin_doctor_scan',
            description: '体检当前 dsh 已装插件：哪些缺 API 密钥/必填配置、哪些缺少依赖的宿主服务、依赖关系是否闭环，并给出可执行的修复建议（含一键修复可用的种类与字段路径）。',
            parameters: {},
            output: {
                schema: { type: 'string' },
                render: (_args, value) => [{ type: 'text', text: String(value) }],
            },
            async execute() {
                const report = readReport(true);
                const lines = [];
                lines.push(`插件 ${report.summary.entries} 个：错误 ${report.summary.errors}，警告 ${report.summary.warnings}，待配置 ${report.summary.pendingConfig}，缺服务 ${report.summary.missingServices}`);
                for (const finding of report.findings.slice(0, 40)) {
                    lines.push(`- [${finding.severity}] ${finding.title} → ${finding.suggestion}${finding.fix ? `（可一键：${finding.fix.label}${finding.fix.path ? ` @ ${finding.fix.path}` : ''}）` : ''}`);
                }
                const open = report.services.filter((service) => !service.available && service.consumers.length);
                if (open.length) {
                    lines.push('缺服务的依赖链：');
                    for (const service of open.slice(0, 20))
                        lines.push(`- ${service.name} ← ${service.consumers.join('、')}`);
                }
                if (report.firstRun.length) {
                    lines.push('首次配置待办：');
                    for (const item of report.firstRun.slice(0, 20)) {
                        const fields = item.gaps.map((gap) => gap.path).join(', ');
                        lines.push(`- ${item.plugin}${fields ? ` 需填：${fields}` : ''}${item.missingServices.length ? ` 需服务：${item.missingServices.join(', ')}` : ''}`);
                    }
                }
                return lines.join('\n');
            },
        })), '@dsh-external/dsh-plugin-doctor: scan tool');
        // 新增：6 个插件管理工具
        sub.effect(() => registerTools(sub, options, defineTool), '@dsh-external/dsh-plugin-doctor: management tools');
    });
    console.info(LOG_TAG, `已就绪（profile 状态文件：${statePath()}）`);
    dlog(`ready: state=${statePath()} root=${PLUGIN_ROOT}`);
}
function safeGet(ctx, name) {
    try {
        return ctx.get?.(name);
    }
    catch {
        return undefined;
    }
}
async function readJson(req) {
    const chunks = [];
    for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8').trim();
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=index.js.map