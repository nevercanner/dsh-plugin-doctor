/**
 * 配置体检引擎（纯逻辑，不碰 HTTP / UI）。
 *
 * 数据来源全部是运行期真值，不猜：
 *  · `ctx.get('configEditor').entries()` —— 每个 Loader entry 的 id / 模块名 / raw config / disabled；
 *  · `entry.fiber` —— 该 entry 的 fiber 与 `Fiber.state`（0 pending / 2 active / 3 failed …）；
 *  · `fiber.inject` —— 声明要求的服务名（cordis 解好后的 map）；
 *  · `ctx.reflect.store` —— 真正在位的服务实现（name / 提供它的 fiber / check 谓词）；
 *  · `fiber.runtime.Config` —— 插件自己的 schemastery schema，用来判断"必填项缺了/还是占位符"。
 *
 * 由此得到三件事：谁缺服务、谁缺配置、谁被谁依赖（依赖图）。
 */
import { existsSync } from 'node:fs';
const STATE_LABEL = {
    0: '待加载（缺服务）',
    1: '加载中',
    2: '运行中',
    3: '加载失败',
    4: '已卸载',
    5: '卸载中',
};
/** 密钥类字段的**叶子键名**（不是整条路径）：只认真正的凭据字段。 */
const SECRET_KEY = /^(api[-_]?key|apikey|access[-_]?key|secret|client[-_]?secret|private[-_]?key|token|password|passwd|pwd|bearer|credential|credentials)$/i;
const SECRET_DESC = /(api\s*key|密钥|秘钥|令牌|密码|token|secret|凭证|授权码)/i;
/** 以 Env 结尾的字段存的是"环境变量名"，验的是那个变量有没有值。 */
const ENV_KEY = /(env|envName|envVar)$/i;
/** 以 File / Path / Dir 结尾的字符串存的是路径，验的是它存不存在。 */
const PATH_KEY = /(file|path|dir)$/i;
const PLACEHOLDER = /^(<[^>]+>|your[-_ ].*|your.*|xxx+|changeme|change[-_]me|todo|tbd|placeholder|sk-x+|\*{3,}|…+|\.{3}|请填写.*|待填.*|填入.*|示例.*)$/i;
/** 从模块 specifier 还原包名：`file:///…/node_modules/dsh-x/lib/i.js` → `dsh-x`。 */
export function packageOf(specifier) {
    if (!specifier)
        return '(未知)';
    if (specifier.startsWith('node:'))
        return specifier;
    let s = specifier;
    if (s.startsWith('file://')) {
        try {
            s = decodeURIComponent(new URL(s).pathname);
        }
        catch {
            s = s.slice(7);
        }
        s = s.split(String.fromCharCode(92)).join('/').replace(new RegExp('^/([A-Za-z]:)'), '$1');
        const marker = '/node_modules/';
        const i = s.lastIndexOf(marker);
        if (i >= 0)
            s = s.slice(i + marker.length);
        else
            return s.split('/').filter(Boolean).slice(-2).join('/');
    }
    const parts = s.split('/');
    if (s.startsWith('@'))
        return parts.slice(0, 2).join('/');
    return parts[0];
}
function getAt(root, path) {
    if (!path)
        return root;
    let cursor = root;
    for (const key of path.split('.')) {
        if (cursor === null || cursor === undefined)
            return undefined;
        cursor = cursor[key];
    }
    return cursor;
}
/** 深拷贝 raw config（含 void 值也要保住），失败退回浅拷贝。 */
export function cloneConfig(value) {
    if (value === null || typeof value !== 'object')
        return value ?? {};
    try {
        return structuredClone(value);
    }
    catch {
        try {
            return JSON.parse(JSON.stringify(value));
        }
        catch {
            return { ...value };
        }
    }
}
export function setAt(root, path, value) {
    const keys = path.split('.');
    let cursor = root;
    for (let i = 0; i < keys.length - 1; i += 1) {
        const key = keys[i];
        if (cursor[key] === null || typeof cursor[key] !== 'object')
            cursor[key] = {};
        cursor = cursor[key];
    }
    cursor[keys[keys.length - 1]] = value;
}
function humanize(key) {
    return key
        .replace(/[-_]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^./, (c) => c.toUpperCase());
}
function pickDescription(meta) {
    const desc = meta?.description;
    if (typeof desc === 'string')
        return desc;
    if (desc && typeof desc === 'object') {
        const lang = globalThis.document?.documentElement?.lang ?? '';
        if (lang.startsWith('zh') && typeof desc.zh === 'string')
            return desc.zh;
        if (typeof desc.en === 'string')
            return desc.en;
        const first = Object.values(desc).find((v) => typeof v === 'string');
        return first;
    }
    return undefined;
}
function isPlaceholder(value) {
    if (typeof value !== 'string')
        return false;
    const trimmed = value.trim();
    if (trimmed === '')
        return false;
    return PLACEHOLDER.test(trimmed);
}
function envIsSet(name) {
    const value = process.env?.[name];
    return typeof value === 'string' && value.trim() !== '';
}
/** 只有绝对路径才值得校验：相对路径（.agent-teams 这类）是运行时按需创建的，报它就是噪音。 */
function looksAbsolute(value) {
    if (value === '' || value === ':memory:' || /^[a-z]+:\/\//i.test(value))
        return false;
    return new RegExp('^([A-Za-z]:[\\/]|/|~[\\/])').test(value);
}
function pathExists(value) {
    try {
        return existsSync(value);
    }
    catch {
        return true;
    }
}
/** 走 schemastery schema（type/meta/dict/inner），摊平成可填字段表。 */
function walkSchema(schema, value, prefix, out, depth = 0, configured = true) {
    if (!schema || depth > 8)
        return;
    const meta = schema.meta ?? {};
    if (schema.type === 'object' && schema.dict && typeof schema.dict === 'object') {
        // 可选子对象没配就是没配：不再把它的每个子字段都报成缺失（tls.* 这类假阳性来源）。
        const present = value !== null && value !== undefined;
        if (!present && prefix && !meta.required)
            return;
        // 「有对象但一个键都没填」= 没启用这一块（tls: {} 就是这样），子字段的 required 只是 schema 的愿望。
        const meaningful = present && Object.keys(schema.dict).some((key) => value[key] !== undefined && value[key] !== null);
        for (const [key, child] of Object.entries(schema.dict)) {
            walkSchema(child, present ? value[key] : undefined, prefix ? `${prefix}.${key}` : key, out, depth + 1, configured && meaningful);
        }
        return;
    }
    if (!prefix)
        return;
    const description = pickDescription(meta);
    const key = prefix.split('.').pop();
    const current = value;
    const isString = typeof current === 'string';
    const secret = SECRET_KEY.test(key) || Boolean(description && SECRET_DESC.test(description) && schema.type === 'string');
    const kind = secret
        ? 'secret'
        : ENV_KEY.test(key) && schema.type === 'string'
            ? 'env'
            : PATH_KEY.test(key) && schema.type === 'string'
                ? 'path'
                : 'text';
    let problem;
    if (current === undefined || current === null) {
        // 父对象整体没配（configured=false）时，子字段的"必填"只是 schema 的愿望，不是可执行的待办。
        if (meta.required && configured)
            problem = 'missing';
    }
    else if (isString && current.trim() === '') {
        // 空串只有"必填"才算问题；可选字段留空是常态。
        if (meta.required && configured)
            problem = 'missing';
    }
    else if (isPlaceholder(current)) {
        problem = 'placeholder';
    }
    else if (kind === 'env' && isString && !envIsSet(current)) {
        problem = 'env-missing';
    }
    else if (kind === 'path' && isString && looksAbsolute(current) && !pathExists(current)) {
        problem = 'path-missing';
    }
    out.push({
        path: prefix,
        label: description && description.length <= 42 ? description : humanize(key),
        description,
        kind,
        secret,
        required: Boolean(meta.required),
        defaultValue: meta.default,
        current: secret && isString && current !== '' ? mask(current) : current,
        problem,
    });
}
function mask(value) {
    if (value.length <= 8)
        return '••••';
    return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
/** 只统计"真的需要人管"的字段：必填缺失、或密钥类空/占位。 */
function collectGaps(fields) {
    // 判定全部在 walkSchema 里做完：没值但可选的字段不算缺口（那才是满屏假阳性的来源）。
    return fields.filter((field) => field.problem !== undefined);
}
function normalizeInject(entry, fiber) {
    const fromFiber = fiber && fiber.inject && typeof fiber.inject === 'object' ? Object.keys(fiber.inject) : [];
    if (fromFiber.length)
        return fromFiber;
    const raw = entry?.options?.inject;
    if (Array.isArray(raw))
        return raw.filter((item) => typeof item === 'string');
    if (raw && typeof raw === 'object')
        return Object.keys(raw);
    return [];
}
/**
 * 扫一遍当前 composition。
 *
 * @param ctx 宿主插件上下文
 * @param state 首次安装感知用的持久状态（known / acked）
 */
export function scanComposition(ctx, state) {
    const anyCtx = ctx;
    const editor = safeGet(anyCtx, 'configEditor');
    const reflect = safeGet(anyCtx, 'reflect');
    const impls = reflect?.store ? Object.values(reflect.store) : [];
    const providerByFiber = new Map();
    for (const impl of impls) {
        if (!impl || typeof impl.name !== 'string')
            continue;
        if (typeof impl.check === 'function') {
            try {
                if (!impl.check())
                    continue;
            }
            catch {
                continue;
            }
        }
        const list = providerByFiber.get(impl.fiber) ?? [];
        list.push(impl.name);
        providerByFiber.set(impl.fiber, list);
    }
    const availableCache = new Map();
    const available = (name) => {
        if (availableCache.has(name))
            return availableCache.get(name);
        let result = false;
        try {
            if (typeof reflect?._getImpl === 'function')
                result = Boolean(reflect._getImpl(name));
            else
                result = anyCtx.get?.(name) !== undefined;
        }
        catch {
            result = false;
        }
        availableCache.set(name, result);
        return result;
    };
    const declared = reflect?.props ? Object.keys(reflect.props) : [];
    const entries = [];
    const findings = [];
    const serviceConsumers = new Map();
    const serviceProviders = new Map();
    const entryById = new Map();
    const rawEntries = (() => {
        try {
            return editor?.entries?.() ?? [];
        }
        catch {
            return [];
        }
    })();
    for (const entry of rawEntries) {
        if (!entry?.options || entry.options.group)
            continue;
        const entryId = entry.id;
        entryById.set(entryId, entry);
        const fiber = entry.fiber;
        const specifier = entry.options.name ?? '';
        const plugin = packageOf(specifier);
        const disabled = Boolean(entry.disabled);
        const stateCode = typeof fiber?.state === 'number' ? fiber.state : null;
        const requires = normalizeInject(entry, fiber);
        const provides = providerByFiber.get(fiber) ?? [];
        const missingServices = requires.filter((name) => !available(name));
        for (const name of requires) {
            const set = serviceConsumers.get(name) ?? new Set();
            set.add(plugin);
            serviceConsumers.set(name, set);
        }
        for (const name of provides) {
            const set = serviceProviders.get(name) ?? new Set();
            set.add(plugin);
            serviceProviders.set(name, set);
        }
        const schema = fiber?.runtime?.Config;
        const fields = [];
        if (schema) {
            try {
                walkSchema(schema, entry.options.config ?? {}, '', fields);
            }
            catch {
                /* 坏 schema 不该让整张报表塌掉 */
            }
        }
        const gaps = disabled ? [] : collectGaps(fields);
        let severity = 'ok';
        let errorText;
        if (!disabled && fiber && stateCode === 3) {
            severity = 'error';
            const failure = fiber?._error;
            errorText = failure instanceof Error ? failure.message : failure ? String(failure) : '插件 apply() 抛错，具体栈见宿主日志';
            findings.push({
                id: `${entryId}::failed`,
                entryId,
                plugin,
                severity: 'error',
                code: 'fiber-failed',
                title: `${plugin} 加载失败`,
                detail: errorText,
                suggestion: '看宿主日志里该 entry 的 apply 报错；改完配置或依赖后点"重新加载"，或重启 dsh。',
            });
        }
        else if (!disabled && fiber && (stateCode === 0 || stateCode === 1) && missingServices.length) {
            severity = 'error';
            findings.push({
                id: `${entryId}::service`,
                entryId,
                plugin,
                severity: 'error',
                code: 'missing-service',
                title: `${plugin} 缺少服务：${missingServices.join(', ')}`,
                detail: `该 entry 声明依赖 ${missingServices.join('、')}，但当前 composition 里没有可用的提供者，所以它一直停在"待加载"，功能完全没生效。`,
                suggestion: '启用（或安装）提供这些服务的插件；下面按"已装但关着 / 未安装"给出候选。',
                candidates: suggestProviders(missingServices, rawEntries, providerByFiber, available),
            });
        }
        else if (!disabled && !fiber) {
            severity = 'warning';
            findings.push({
                id: `${entryId}::nomount`,
                entryId,
                plugin,
                severity: 'warning',
                code: 'not-mounted',
                title: `${plugin} 没有 fiber`,
                detail: 'entry 存在但模块没导入成功（路径/导出不对），或者导入后没拿到 apply。',
                suggestion: '确认包已安装且 dsh 能 import 到；必要时重装该插件再重启。',
            });
        }
        for (const gap of gaps) {
            if (gap.problem === 'env-missing') {
                // `XxxEnv` 字段存的是**环境变量名**，不是密钥本身。用户在这个字段里填任何值，
                // 都不会让 process.env 多出那个变量 —— 所以"改环境变量名"是个死循环。
                //
                // 正确的出路有两条，按优先级：
                //   ① 插件自己还有 `apiKey` 这类"直接填密钥"的字段（deepseek-web-search 就是这样）
                //      → 引导用户填真实密钥，这条能被配置写入真正消除；
                //   ② 没有直填字段 → 只能去启动环境设变量并重启，明确告知"填配置无效"。
                const siblingKey = siblingDirectKey(fields, gap.path);
                if (siblingKey && !siblingKey.current) {
                    findings.push({
                        id: `${entryId}::env::${gap.path}`,
                        entryId,
                        plugin,
                        severity: 'warning',
                        code: 'missing-env',
                        title: `${plugin} 缺少凭据：${siblingKey.path} 为空（${String(gap.current)} 环境变量也没设）`,
                        detail: `字段 ${gap.path} 只是**环境变量名**（当前指向 ${String(gap.current)}，该变量在进程环境里为空），` +
                            `在它里面填值不会生效。这个插件另有 ${siblingKey.path} 可以直接填真实密钥。`,
                        suggestion: `在「首次配置」里填 ${siblingKey.path}（真实密钥）后保存，这条警告就会消失；` +
                            `或改去启动 dsh 的环境里设置 ${String(gap.current)} 再重启。`,
                        fix: { kind: 'set-field', label: '填真实密钥', path: siblingKey.path },
                    });
                    if (severity !== 'error')
                        severity = 'warning';
                    continue;
                }
                if (siblingKey && siblingKey.current) {
                    // 已经直填了密钥 → 环境变量那个只是遗留默认值，不该继续报
                    continue;
                }
                // 没有直填字段：只告知，不给可点的"填配置"按钮（给了也是白填）
                findings.push({
                    id: `${entryId}::env::${gap.path}`,
                    entryId,
                    plugin,
                    severity: 'warning',
                    code: 'missing-env',
                    title: `${plugin} 的环境变量没值：${String(gap.current)}`,
                    detail: `字段 ${gap.path} 指定了环境变量 ${String(gap.current)}，但当前进程环境里它是空的 —— 该插件会拿不到凭据。` +
                        `注意：这个字段存的是**变量名**，在面板里填它不会生效。`,
                    suggestion: `在启动 dsh 的环境里设置 ${String(gap.current)} 并重启 dsh；或把 ${gap.path} 改成一个已在环境里有值的变量名。`,
                });
                if (severity !== 'error')
                    severity = 'warning';
                continue;
            }
            if (gap.problem === 'path-missing') {
                findings.push({
                    id: `${entryId}::path::${gap.path}`,
                    entryId,
                    plugin,
                    severity: 'warning',
                    code: 'missing-path',
                    title: `${plugin} 指向的路径不存在：${String(gap.current)}`,
                    detail: `字段 ${gap.path} 是一个文件/目录路径，磁盘上找不到它。`,
                    suggestion: '确认文件确实存在，或把该字段改成真实路径；路径写错时插件通常静默降级。',
                    fix: { kind: 'set-field', label: '改路径', path: gap.path },
                });
                if (severity !== 'error')
                    severity = 'warning';
                continue;
            }
            if (gap.secret) {
                findings.push({
                    id: `${entryId}::secret::${gap.path}`,
                    entryId,
                    plugin,
                    severity: 'warning',
                    code: 'missing-secret',
                    title: `${plugin} 缺少 API 密钥/凭据：${gap.path}`,
                    detail: gap.description ? `字段说明：${gap.description}` : '该字段是密钥/令牌类配置，当前为空或是占位值。',
                    suggestion: '在"首次配置"里填真实值后保存；保存走 Loader 的校验与热更新，不用重启。',
                    fix: hasDefault(gap) ? { kind: 'fill-default', label: '填入默认值', path: gap.path, value: gap.defaultValue } : { kind: 'set-field', label: '去填写', path: gap.path },
                });
                if (severity !== 'error')
                    severity = 'warning';
                continue;
            }
            findings.push({
                id: `${entryId}::field::${gap.path}`,
                entryId,
                plugin,
                severity: 'warning',
                code: gap.problem === 'placeholder' ? 'placeholder-value' : 'missing-required',
                title: `${plugin} 配置不完整：${gap.path}`,
                detail: gap.description ?? (gap.problem === 'placeholder' ? '该字段还是占位值（示例/待填），不是真实配置。' : '该字段是必填项，当前没有值。'),
                suggestion: hasDefault(gap) ? '用 schema 默认值补齐即可（不会覆盖你已填的值）。' : '在"首次配置"里填入该值。',
                fix: hasDefault(gap) ? { kind: 'fill-default', label: '填入默认值', path: gap.path, value: gap.defaultValue } : { kind: 'set-field', label: '去填写', path: gap.path },
            });
            if (severity !== 'error')
                severity = 'warning';
        }
        entries.push({
            entryId,
            plugin,
            specifier,
            disabled,
            state: disabled ? '已禁用' : STATE_LABEL[stateCode ?? -1] ?? '无 fiber',
            stateCode,
            provides,
            requires,
            missingServices,
            fields,
            gaps,
            severity,
            error: errorText,
        });
    }
    // 依赖反向检查：关掉的插件，却在给别人提供必需的服务的 —— 这就是"配好了却没生效"的典型。
    for (const report of entries) {
        if (!report.disabled)
            continue;
        const needed = report.provides.filter((name) => {
            const consumers = serviceConsumers.get(name);
            if (!consumers || !consumers.size)
                return false;
            return [...consumers].some((consumer) => consumer !== report.plugin);
        });
        if (!needed.length)
            continue;
        const consumers = new Set();
        for (const name of needed)
            for (const consumer of serviceConsumers.get(name) ?? [])
                if (consumer !== report.plugin)
                    consumers.add(consumer);
        findings.push({
            id: `${report.entryId}::disabled-dep`,
            entryId: report.entryId,
            plugin: report.plugin,
            severity: 'warning',
            code: 'disabled-dependency',
            title: `${report.plugin} 关着，但 ${[...consumers].join('、')} 依赖它提供的 ${needed.join('、')}`,
            detail: '这些插件此刻拿不到该服务，相关功能会静默失效。',
            suggestion: '如果只是暂时关掉，可以忽略；要实现功能就启用它。',
            fix: { kind: 'enable', label: '启用它' },
        });
    }
    const services = [...new Set([...declared, ...serviceConsumers.keys(), ...serviceProviders.keys()])]
        .sort()
        .map((name) => ({
        name,
        available: available(name),
        providers: [...(serviceProviders.get(name) ?? [])],
        consumers: [...(serviceConsumers.get(name) ?? [])].sort(),
    }));
    const known = new Set(state.known);
    const acked = new Set(state.acked);
    const newPlugins = entries.filter((item) => !known.has(item.entryId)).map((item) => item.plugin);
    const firstRun = entries
        .filter((item) => !item.disabled && !acked.has(item.entryId))
        .filter((item) => item.gaps.length > 0 || item.missingServices.length > 0)
        .map((item) => ({
        entryId: item.entryId,
        plugin: item.plugin,
        gaps: item.gaps,
        missingServices: item.missingServices,
        note: !known.has(item.entryId) ? '新安装' : '仍待配置',
    }));
    const deduped = [];
    const seen = new Set();
    for (const finding of findings) {
        const key = `${finding.plugin}::${finding.code}::${finding.fix?.path ?? finding.id}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        deduped.push(finding);
    }
    findings.length = 0;
    findings.push(...deduped);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    const pendingConfig = new Set(firstRun.flatMap((item) => item.gaps.map((gap) => `${item.entryId}:${gap.path}`))).size;
    const missingServiceTotal = new Set(entries.flatMap((item) => item.missingServices)).size;
    const alerts = [];
    if (newPlugins.length)
        alerts.push(`检测到新安装插件：${newPlugins.join('、')}`);
    return {
        generatedAt: new Date().toISOString(),
        profile: process.env.DSH_PROFILE ?? 'desktop',
        summary: {
            entries: entries.length,
            problems: findings.length,
            errors,
            warnings,
            missingServices: missingServiceTotal,
            pendingConfig,
            healthy: entries.filter((item) => item.severity === 'ok' && !item.gaps.length).length,
            newPlugins: newPlugins.length,
        },
        entries: entries.sort((a, b) => rank(a.severity) - rank(b.severity) || a.plugin.localeCompare(b.plugin)),
        findings: findings.sort((a, b) => rank(a.severity) - rank(b.severity) || a.plugin.localeCompare(b.plugin)),
        services,
        firstRun,
        newPlugins,
        alerts,
    };
}
function rank(severity) {
    return severity === 'error' ? 0 : severity === 'warning' ? 1 : severity === 'info' ? 2 : 3;
}
function hasDefault(field) {
    return field.defaultValue !== undefined && field.defaultValue !== null;
}
/**
 * 给 `xxxEnv` 这种"存环境变量名"的字段，找到同一插件里"直接存密钥"的孪生字段。
 *
 * 例：`apiKeyEnv` → `apiKey`；`tokenEnv` → `token`；`secretEnv` → `secret`。
 * 找到它就是找到了能真正消除警告的填值入口（在 Env 字段里填值永远无效）。
 *
 * @param fields 该插件摊平后的全部字段
 * @param envPath 出问题的 Env 字段路径
 * @returns 孪生的直填字段；没有则 undefined
 */
function siblingDirectKey(fields, envPath) {
    const segs = envPath.split('.');
    const leaf = segs[segs.length - 1];
    const m = /^(.*?)(env|envName|envVar)$/i.exec(leaf);
    if (!m)
        return undefined;
    const base = m[1];
    if (!base)
        return undefined;
    const candidates = [`${base}Key`, `${base}`, `${base}Token`, `${base}Secret`];
    const prefix = segs.slice(0, -1).join('.');
    for (const name of candidates) {
        const path = prefix ? `${prefix}.${name}` : name;
        const hit = fields.find((f) => f.path === path);
        if (hit)
            return hit;
    }
    return undefined;
}
function safeGet(ctx, name) {
    try {
        return ctx.get?.(name);
    }
    catch {
        return undefined;
    }
}
/**
 * 给缺失服务找候选提供者：
 * ① 已安装但禁用的 entry 里，名字与服务名相近的；
 * ② 名字相近的已启用插件（多半是它的 client 半没起来）。
 */
function suggestProviders(missing, rawEntries, providerByFiber, available) {
    const candidates = new Set();
    const needles = missing.map((name) => name.toLowerCase());
    for (const entry of rawEntries) {
        if (!entry?.options || entry.options.group)
            continue;
        const plugin = packageOf(entry.options.name ?? '');
        const lower = plugin.toLowerCase();
        const provides = providerByFiber.get(entry.fiber) ?? [];
        const hits = needles.some((needle) => lower.includes(needle) || needle.includes(lower.replace(/^.*\//, '')));
        if (!hits)
            continue;
        const already = provides.some((name) => available(name));
        if (already)
            continue;
        candidates.add(entry.disabled ? `${plugin}（已安装，当前禁用）` : `${plugin}（已启用，但服务未就位）`);
    }
    if (!candidates.size) {
        for (const needle of needles)
            candidates.add(`未找到现成提供者：需安装提供 "${needle}" 服务的插件`);
    }
    return [...candidates];
}
//# sourceMappingURL=doctor.js.map