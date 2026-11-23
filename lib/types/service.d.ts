/**
 * PluginRegistry 服务实现：把运行期真值（Loader entry + fiber + reflect + schemastery）
 * 与盘上真值（PLUGIN_ROOT 目录 + profile package.json + 注入器 registry）合成一份
 * `PluginRegistryReport`，并对外提供 6 个操作。
 *
 * 与 doctor.ts 的分工：doctor 管"配置缺什么、服务缺什么"，这里管
 * "插件在哪、什么状态、怎么启停/卸载/更新、日志是什么"。
 */
import { basename } from 'node:path';
import { pluginDirOf, type PluginConfigField, type PluginRegistryReport, type PluginStatus } from './registry.js';
/** 从 file:/// 模块 specifier 还原包名。 */
export declare function packageOf(specifier: string): string;
/** 走 schemastery schema（type/dict/meta/inner），摊平成可展示/可校验的字段表。 */
export declare function flattenSchema(schema: any, value: any, out: PluginConfigField[], prefix?: string, depth?: number): void;
/** 由 loader entry + 盘上信息合成 registry 报告。 */
export declare function buildRegistry(ctx: any, logger?: any): PluginRegistryReport;
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
export declare function findEntry(ctx: any, pluginId: string): any;
export interface ToggleResult {
    ok: boolean;
    message: string;
    plugin?: string;
    status?: PluginStatus;
}
/**
 * 启用 / 禁用插件。
 *
 * disable：`entry.update({ disabled: true })` —— Loader 会 dispose 该 fiber，
 *          它注入的 tools / agents 随之卸载（这就是"移除注入"的宿主级做法）。
 * enable ：`entry.update({ disabled: false })` 后重新校验配置；有必填缺口就报告出来。
 */
export declare function togglePlugin(ctx: any, pluginId: string, enabled: boolean): Promise<ToggleResult>;
export interface UninstallResult {
    ok: boolean;
    message: string;
    removedDir?: boolean;
    removedEnv?: boolean;
}
/**
 * 卸载插件：先摘引用（entry 禁用 + profile 依赖 + 注入器 registry），再删目录。
 * 顺序很重要——先摘引用能保证 Loader 不再持有该路径，再删盘才不会触发 ENOENT 风暴。
 */
export declare function uninstallPlugin(ctx: any, pluginId: string): Promise<UninstallResult>;
export interface UpdateResult {
    ok: boolean;
    message: string;
    offline?: boolean;
    before?: string;
    after?: string;
    dir?: string;
}
/**
 * 从 GitHub 更新插件。
 *
 * 有 .git → `git fetch --all` + `git reset --hard origin/<ref>`（比 pull 干净，不受本地脏工作区影响）
 * 无 .git → `git clone <repository> <dir>`（目录已存在则报错，避免覆盖用户改动）
 * 网络不可用 → 返回 offline=true，让调用方提示"手动更新"，而不是抛错。
 */
export declare function updatePlugin(ctx: any, pluginId: string, ref?: string, repository?: string): Promise<UpdateResult>;
export interface ValidateResult {
    ok: boolean;
    plugin: string;
    errors: Array<{
        path: string;
        message: string;
        kind: 'missing' | 'placeholder' | 'invalid' | 'env-missing' | 'path-missing';
    }>;
    fields: PluginConfigField[];
    message: string;
}
/**
 * 用 schemastery 校验插件配置，返回**结构化**字段级错误。
 * 除了官方 schema 的必填判定，还额外查三类"能跑但一定错"的值：
 * 占位符、`*Env` 指向的环境变量为空、绝对路径不存在。
 */
export declare function validateConfig(ctx: any, pluginId: string): ValidateResult;
export interface LogsResult {
    ok: boolean;
    plugin: string;
    files: string[];
    lines: string[];
    message: string;
}
/**
 * 取某个插件最近的日志行。
 *
 * 来源：宿主把插件 console 输出写进 stdout/stderr 日志文件；本插件自己的行带
 * `[plugin-doctor]` 前缀，其它插件一般带自己的包名短名。这里按"包名 / 短名 /
 * entry id"三种模式去匹配，从新往旧取 limit 行。
 */
export declare function pluginLogs(pluginId: string, limit?: number): LogsResult;
export declare function safeGet(ctx: any, name: string): any;
export declare function errText(error: unknown): string;
/** 目录体积（供 UI 展示）。 */
export declare function pluginSizeMB(pluginId: string): number;
export { basename, pluginDirOf };
