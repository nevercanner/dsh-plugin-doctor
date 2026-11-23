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
import { buildRegistry, errText, safeGet, type ValidateResult } from './service.js';
export interface ToolOptions {
    /** true = Markdown 表格；false = 紧凑文本。 */
    showInUi: boolean;
}
/** registry 报告 -> Markdown 表格。 */
export declare function renderListMarkdown(report: ReturnType<typeof buildRegistry>): string;
/** registry 报告 -> 紧凑文本。 */
export declare function renderListText(report: ReturnType<typeof buildRegistry>): string;
export declare function renderValidate(result: ValidateResult): string;
/**
 * 注册全部工具。
 * @param sub 注入了 tools 的子上下文
 * @param ctxConfig 插件 config（showInUi 等）
 */
export declare function registerTools(sub: any, ctxConfig: any, defineTool: any): void;
export { safeGet, errText };
