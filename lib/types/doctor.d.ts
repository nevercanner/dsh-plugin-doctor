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
import type { Context } from '@deepseek-ai/cordis';
export type Severity = 'error' | 'warning' | 'info';
/** 修复类型：`enable` 打开被依赖却关着的 entry；`fill-default` 用 schema 默认值补齐；`set-field` 需要人填。 */
export type FixKind = 'enable' | 'fill-default' | 'set-field';
export interface FixAction {
    kind: FixKind;
    label: string;
    path?: string;
    value?: unknown;
}
export interface Finding {
    id: string;
    entryId: string;
    plugin: string;
    severity: Severity;
    code: string;
    title: string;
    detail: string;
    suggestion: string;
    fix?: FixAction;
    /** 缺服务时给出的候选包名（已安装但未启用 / 未安装）。 */
    candidates?: string[];
}
export type FieldKind = 'text' | 'secret' | 'env' | 'path';
export interface FieldSpec {
    path: string;
    label: string;
    description?: string;
    /** 字段语义：普通文本 / 密钥 / 环境变量名 / 文件路径。 */
    kind: FieldKind;
    secret: boolean;
    required: boolean;
    defaultValue?: unknown;
    current: unknown;
    problem?: 'missing' | 'placeholder' | 'env-missing' | 'path-missing';
}
export interface EntryReport {
    entryId: string;
    plugin: string;
    specifier: string;
    disabled: boolean;
    state: string;
    stateCode: number | null;
    provides: string[];
    requires: string[];
    missingServices: string[];
    fields: FieldSpec[];
    gaps: FieldSpec[];
    severity: Severity | 'ok';
    error?: string;
}
export interface ServiceNode {
    name: string;
    available: boolean;
    providers: string[];
    consumers: string[];
}
export interface FirstRunItem {
    entryId: string;
    plugin: string;
    gaps: FieldSpec[];
    missingServices: string[];
    note: string;
}
export interface DoctorReport {
    generatedAt: string;
    profile: string;
    summary: {
        entries: number;
        problems: number;
        errors: number;
        warnings: number;
        missingServices: number;
        pendingConfig: number;
        healthy: number;
        newPlugins: number;
    };
    entries: EntryReport[];
    findings: Finding[];
    services: ServiceNode[];
    firstRun: FirstRunItem[];
    newPlugins: string[];
    alerts: string[];
}
/** 从模块 specifier 还原包名：`file:///…/node_modules/dsh-x/lib/i.js` → `dsh-x`。 */
export declare function packageOf(specifier: string): string;
/** 深拷贝 raw config（含 void 值也要保住），失败退回浅拷贝。 */
export declare function cloneConfig(value: any): any;
export declare function setAt(root: any, path: string, value: unknown): void;
/**
 * 扫一遍当前 composition。
 *
 * @param ctx 宿主插件上下文
 * @param state 首次安装感知用的持久状态（known / acked）
 */
export declare function scanComposition(ctx: Context, state: {
    known: string[];
    acked: string[];
}): DoctorReport;
