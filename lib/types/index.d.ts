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
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "@dsh-external/dsh-plugin-doctor";
export declare const inject: string[];
export declare function apply(ctx: Context, _config: Record<string, never>): void;
