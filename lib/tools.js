/**
 * 6 个面向 Agent 的工具。
 *
 * 命名与职责：
 *  · list_installed_plugins   —— 已装插件清单（含 status / path / config / errors）
 *  · toggle_plugin            —— 启用 / 禁用（宿主级：fiber dispose 与重新注入）
 *  · uninstall_plugin         —— 摘引用 + 删 PLUGIN_ROOT 下目录
 *  · update_plugin            —— 从 GitHub 拉更新（fetch+reset，离线降级）
 *  · validate_plugin_config   —— schemastery 校验，返回字段级错误
 *  · get_plugin_logs          —— 该插件最近的日志行
 *
 * 渲染约定：showInUi 为 true 时优先输出 Markdown 表格（人读 / 前端好渲染），
 * 为 false 时输出紧凑纯文本（省 token）。
 */
import { buildRegistry, errText, pluginLogs, pluginSizeMB, safeGet, togglePlugin, uninstallPlugin, updatePlugin, validateConfig, } from './service.js';
import { PLUGIN_ROOT } from './registry.js';
const STATUS_LABEL = {
    enabled: '启用',
    disabled: '禁用',
    installing: '装配中',
    failed: '失败',
    unconfigured: '待配置',
    unknown: '未知',
};
function text(value) {
    return [{ type: 'text', text: value }];
}
/** 转义 Markdown 表格里的竖线。 */
function cell(value) {
    const s = value === undefined || value === null ? '—' : String(value);
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim() || '—';
}
/** registry 报告 -> Markdown 表格。 */
export function renderListMarkdown(report) {
    const s = report.summary;
    const head = [
        `已装插件 ${s.total} 个：启用 ${s.enabled}，禁用 ${s.disabled}，失败 ${s.failed}，待配置 ${s.unconfigured}；落盘 ${s.onDisk} 个`,
        `插件根目录：\`${report.root}\``,
    ];
    if (!report.plugins.length) {
        head.push('', '_没有采集到任何插件 entry。可能 configEditor 服务不可用，或 composition 尚未装配。_');
        return head.join('\n');
    }
    const rows = report.plugins.map((p) => {
        const err = p.errors.length ? p.errors[0].slice(0, 60) : '—';
        return `| ${cell(p.name)} | ${cell(p.version)} | ${cell(STATUS_LABEL[p.status] ?? p.status)} | ${cell(p.source)} | ${cell(p.path || '（未落盘）')} | ${cell(err)} |`;
    });
    const table = [
        '| 插件 | 版本 | 状态 | 来源 | 路径 | 错误 / 备注 |',
        '| --- | --- | --- | --- | --- | --- |',
        ...rows,
    ];
    return [...head, '', ...table].join('\n');
}
/** registry 报告 -> 紧凑文本。 */
export function renderListText(report) {
    const s = report.summary;
    const lines = [
        `插件 ${s.total}：启用 ${s.enabled} / 禁用 ${s.disabled} / 失败 ${s.failed} / 待配置 ${s.unconfigured} / 落盘 ${s.onDisk}`,
        `root=${report.root}`,
    ];
    for (const p of report.plugins) {
        lines.push(`- ${p.name}@${p.version} [${STATUS_LABEL[p.status] ?? p.status}] (${p.source}) ${p.path || '(未落盘)'}` +
            (p.errors.length ? `  !! ${p.errors[0].slice(0, 80)}` : ''));
    }
    return lines.join('\n');
}
export function renderValidate(result) {
    if (!result.errors.length)
        return `✅ ${result.message}`;
    const lines = [`❌ ${result.message}`];
    for (const e of result.errors) {
        lines.push(`- ${e.path}  [${e.kind}]  ${e.message}`);
    }
    return lines.join('\n');
}
/**
 * 注册全部工具。
 * @param sub 注入了 tools 的子上下文
 * @param ctxConfig 插件 config（showInUi 等）
 */
export function registerTools(sub, ctxConfig, defineTool) {
    const showInUi = Boolean(ctxConfig?.showInUi ?? true);
    sub.tools.register(defineTool({
        name: 'list_installed_plugins',
        description: '列出所有已装插件及其状态（启用/禁用/失败/待配置）、版本、来源（bundle/injected/profile/builtin）、固定落盘路径（' +
            PLUGIN_ROOT +
            '\\<id>）以及当前错误。用于回答"装了哪些插件""为什么这个插件没生效"。',
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute() {
            const report = buildRegistry(sub, sub.logger);
            return showInUi ? renderListMarkdown(report) : renderListText(report);
        },
    }));
    sub.tools.register(defineTool({
        name: 'toggle_plugin',
        description: '启用或禁用指定插件。禁用会 dispose 该插件的 fiber（其注入的工具/服务随之从宿主移除）；启用会重新挂载并复核配置，若有必填缺口会一并报告。pluginId 可传 entry id 或 npm 包名。',
        parameters: {
            pluginId: { type: 'string', description: '插件标识：Loader entry id 或 npm 包名（如 @dsh-external/dsh-tool-toggle）', required: true },
            enabled: { type: 'boolean', description: 'true = 启用，false = 禁用', required: true },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute(args) {
            const pluginId = String(args?.pluginId ?? '').trim();
            const enabled = Boolean(args?.enabled);
            if (!pluginId)
                return '缺少 pluginId';
            const result = await togglePlugin(sub, pluginId, enabled);
            return (result.ok ? '✅ ' : '❌ ') + result.message;
        },
    }));
    sub.tools.register(defineTool({
        name: 'uninstall_plugin',
        description: '卸载插件：从 composition 摘除（禁用 entry）、清理 profile package.json 依赖与注入器 registry，然后删除 ' +
            PLUGIN_ROOT +
            '\\<id> 目录。删除前会做路径白名单校验，绝不会删到插件根目录之外。',
        parameters: {
            pluginId: { type: 'string', description: '插件标识（entry id 或包名）', required: true },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute(args) {
            const pluginId = String(args?.pluginId ?? '').trim();
            if (!pluginId)
                return '缺少 pluginId';
            const result = await uninstallPlugin(sub, pluginId);
            return (result.ok ? '✅ ' : '❌ ') + result.message;
        },
    }));
    sub.tools.register(defineTool({
        name: 'update_plugin',
        description: '从 GitHub 更新插件到最新提交。git 仓库走 fetch + reset --hard origin/<ref>；目录不存在则 git clone。ref 默认 main/master；repository 省略时取 package.json 的 repository 字段。网络不可用时返回离线提示，不抛错。',
        parameters: {
            pluginId: { type: 'string', description: '插件标识（entry id 或包名）', required: true },
            ref: { type: 'string', description: '分支或 tag，默认 main' },
            repository: { type: 'string', description: 'GitHub 仓库 URL（覆盖 package.json 的 repository）' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute(args) {
            const pluginId = String(args?.pluginId ?? '').trim();
            if (!pluginId)
                return '缺少 pluginId';
            const result = await updatePlugin(sub, pluginId, args?.ref ? String(args.ref) : undefined, args?.repository ? String(args.repository) : undefined);
            if (result.offline)
                return '⚠️ ' + result.message;
            return (result.ok ? '✅ ' : '❌ ') + result.message;
        },
    }));
    sub.tools.register(defineTool({
        name: 'validate_plugin_config',
        description: '用插件自己的 schemastery schema 校验配置，返回结构化字段级错误（必填缺失 / 占位值 / *Env 环境变量为空 / 绝对路径不存在）。用于回答"这个插件为什么起不来"。',
        parameters: {
            pluginId: { type: 'string', description: '插件标识（entry id 或包名）', required: true },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute(args) {
            const pluginId = String(args?.pluginId ?? '').trim();
            if (!pluginId)
                return '缺少 pluginId';
            return renderValidate(validateConfig(sub, pluginId));
        },
    }));
    sub.tools.register(defineTool({
        name: 'get_plugin_logs',
        description: '取某个插件最近的日志行（从宿主 stdout/stderr 日志文件里按包名/短名匹配），用于排查加载失败、反复重载、服务未就位等问题。',
        parameters: {
            pluginId: { type: 'string', description: '插件标识（entry id 或包名）', required: true },
            limit: { type: 'number', description: '最多返回多少行，默认 80，上限 500' },
        },
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute(args) {
            const pluginId = String(args?.pluginId ?? '').trim();
            if (!pluginId)
                return '缺少 pluginId';
            const limit = Number.isFinite(Number(args?.limit)) ? Number(args.limit) : 80;
            const result = pluginLogs(pluginId, limit);
            if (!result.ok)
                return '⚠️ ' + result.message;
            return [`${result.message}`, '', ...result.lines].join('\n');
        },
    }));
    // ── 迁移助手（内部用，也暴露给 Agent 便于排查零散路径） ──────────────────
    sub.tools.register(defineTool({
        name: 'plugin_storage_info',
        description: `报告插件存储根目录（${PLUGIN_ROOT}）的概况：目录数、占用体积、哪些目录缺 package.json，以及注入器 registry 是否仍指向旧路径。`,
        parameters: {},
        output: {
            schema: { type: 'string' },
            render: (_args, value) => text(String(value)),
        },
        async execute() {
            const report = buildRegistry(sub, sub.logger);
            const lines = [
                `插件根目录：${report.root}`,
                `已记录 entry：${report.summary.total}（落盘 ${report.summary.onDisk}）`,
            ];
            const sizes = report.plugins
                .filter((p) => p.onDisk)
                .map((p) => ({ name: p.name, size: pluginSizeMB(p.name) }))
                .sort((a, b) => b.size - a.size);
            lines.push('', '体积排行：');
            for (const row of sizes.slice(0, 15))
                lines.push(`- ${row.name}  ${row.size} MB`);
            const total = sizes.reduce((acc, row) => acc + row.size, 0);
            lines.push(`合计 ${Math.round(total * 10) / 10} MB`);
            const notOnDisk = report.plugins.filter((p) => !p.onDisk);
            if (notOnDisk.length) {
                lines.push('', '未落在根目录下（零散路径）：');
                for (const p of notOnDisk)
                    lines.push(`- ${p.name}（${p.status}）`);
            }
            if (report.warnings.length) {
                lines.push('', '警告：', ...report.warnings.map((w) => `- ${w}`));
            }
            return lines.join('\n');
        },
    }));
}
export { safeGet, errText };
//# sourceMappingURL=tools.js.map