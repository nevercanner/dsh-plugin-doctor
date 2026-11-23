/**
 * @dsh-external/dsh-plugin-doctor — 宿主半。
 *
 * 两层能力：
 *  A. **配置体检**（doctor.ts）：谁能跑、谁缺服务、谁缺配置、依赖闭环没有；
 *  B. **插件管理**（registry.ts / service.ts / tools.ts）：清单、启停、卸载、GitHub 更新、
 *     配置校验、日志。所有落盘路径强制收敛在 `PLUGIN_ROOT`（默认 D:\deepseek\plugins）。
 *
 * 修复与管理动作全部走 Loader 的正规路径（`configEditor.edit()` / `entry.update()`），
 * 不手改 profile 的 package.json 或 cordis.patch.yml。
 *
 * 本文件**不硬注入** configEditor / reflect / credentials —— 一律 `ctx.get()` 兜底，
 * 少一个服务只降级一项能力，不会让 entry 卡在 pending（本插件自己就是干这个的）。
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "@dsh-external/dsh-plugin-doctor";
export declare const inject: string[];
/**
 * 插件配置。
 *  - showInUi：list_installed_plugins 输出 Markdown 表格（true）还是紧凑文本（false）
 *  - pluginRoot：插件落盘根目录，默认 D:\deepseek\plugins（也可用 DSH_PLUGIN_ROOT 环境变量）
 */
export declare const Config: import("@deepseek-ai/schemastery").Schema;
export declare function apply(ctx: Context, config: any): void;
