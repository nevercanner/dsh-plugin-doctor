/**
 * PluginRegistry —— 已装插件的唯一真值来源。
 *
 * 三件事：
 *  1. **列表**：把 Loader 的 entry、profile package.json 的依赖、注入器 registry、
 *     盘上的插件目录合成一份带 status/path/config/errors 的统一视图；
 *  2. **路径纪律**：所有插件的落盘根目录硬编码为 `PLUGIN_ROOT`（默认 `D:\deepseek\plugins`），
 *     任何安装/更新/迁移的目标路径都必须过 `assertInsideRoot()` 白名单校验；
 *  3. **操作**：enable/disable（走 configEditor/entry.update 的正规 Loader 路径）、
 *     uninstall（删目录 + 清引用）、update（git pull/clone，失败降级为离线提示）、
 *     validate（schemastery 校验）、logs（从宿主日志里筛该插件的行）。
 *
 * 本文件不 import 任何官方 rc 包，只依赖 node 内置 + 宿主注入的 ctx 服务，
 * 少一个服务也只是降级一项能力，不会让整个插件卡在 pending。
 */
import { dirname } from 'node:path';
/**
 * 插件落盘根目录：这是**唯一**允许出现插件文件的目录。
 *
 * 默认 `D:\deepseek\plugins`，可被 `DSH_PLUGIN_ROOT` 环境变量或插件 config 的
 * `pluginRoot` 覆盖（后者在 apply 开头调 setPluginRoot 写入）。
 *
 * 注意：这里用 `let` 导出。ESM 的 live binding 让其它模块读到的永远是当前值，
 * 所以 `join(PLUGIN_ROOT, x)` 这类写法不用改。
 */
export declare let PLUGIN_ROOT: string;
/** 运行期覆盖插件根目录（插件 config 用）。 */
export declare function setPluginRoot(next: string | undefined): void;
export type PluginStatus = 'enabled' | 'disabled' | 'installing' | 'failed' | 'unconfigured' | 'unknown';
export interface PluginConfigField {
    path: string;
    label: string;
    value: unknown;
    secret: boolean;
    required: boolean;
    problem?: string;
}
/** 一条已装插件的完整画像。 */
export interface PluginRegistryEntry {
    /** Loader entry id；拿不到时退化为包名。 */
    id: string;
    /** npm 包名。 */
    name: string;
    version: string;
    status: PluginStatus;
    /** 固定为 `<PLUGIN_ROOT>\<id>`；未落盘时为空串。 */
    path: string;
    /** 该 entry 的 raw config（扁平化后的关键字段）。 */
    config: PluginConfigField[];
    /** 该插件当前的错误（fiber 失败原因 / 缺服务 / 缺配置）。 */
    errors: string[];
    /** 提供 / 依赖的宿主服务。 */
    provides: string[];
    requires: string[];
    /** 生效来源：bundle / injected / profile / builtin。 */
    source: 'bundle' | 'injected' | 'profile' | 'builtin' | 'unknown';
    /** 目录是否真实存在于白名单根目录下。 */
    onDisk: boolean;
    /** git 远端（update 用）。 */
    repository?: string;
    disabled: boolean;
    /** 该包在 composition 里占了几条 entry（>1 表示多入口插件，如 dsh-purge 的 redteam 三件套）。 */
    entryCount?: number;
}
export interface PluginRegistryReport {
    generatedAt: string;
    root: string;
    summary: {
        total: number;
        enabled: number;
        disabled: number;
        failed: number;
        unconfigured: number;
        onDisk: number;
    };
    plugins: PluginRegistryEntry[];
    warnings: string[];
}
/** 把任意用户输入规范成绝对路径（Windows 分隔符）。 */
export declare function toAbsolute(input: string): string;
/**
 * 白名单校验：目标必须落在 PLUGIN_ROOT 之内。
 * 防止插件把文件写到系统其它目录（这是安装/更新的最后一道闸）。
 */
export declare function assertInsideRoot(target: string): string;
/** 插件目录 = <PLUGIN_ROOT>\<id>（id 里的 scope 前缀会被拍平，避免多一层目录）。 */
export declare function pluginDirOf(id: string): string;
/** 确保插件根目录存在（插件初始化时调用）。 */
export declare function ensureRoot(): string;
export declare function readJsonSafe(file: string): any;
export declare function writeJsonAtomic(file: string, value: unknown): void;
/** 扫 PLUGIN_ROOT 下的插件目录，返回 目录名 -> package.json。 */
export declare function scanPluginRoot(): Map<string, any>;
export declare function profileDir(): string;
export declare function injectorRegistryPath(): string;
export interface GitResult {
    ok: boolean;
    code: number | null;
    output: string;
    /** 网络不可用时为 true，调用方据此降级为"手动更新"提示。 */
    offline: boolean;
}
/**
 * 在指定目录跑一条 git 命令。
 * 用 execFile 而不是 shell，避免 Windows 上的引号转义问题。
 */
export declare function runGit(cwd: string, args: string[], timeoutMs?: number): Promise<GitResult>;
/** 从 package.json 的 repository 字段还原一个可 clone 的 URL。 */
export declare function repositoryUrlOf(pkg: any): string | undefined;
/** 插件目录是否是一个 git 工作区。 */
export declare function isGitRepo(dir: string): boolean;
/** 安全删除插件目录（必须先过白名单）。 */
export declare function removePluginDir(dir: string): void;
/** 目录体积（MB），用于列表展示。 */
export declare function dirSizeMB(dir: string): number;
/** 日志文件候选位置（按优先级）。 */
export declare function logCandidates(): string[];
/** doctor 自己的日志文件（append-only，超过 512KB 自动截断到后 2000 行）。 */
export declare function doctorLogPath(): string;
/**
 * 写一行 doctor 观测日志。
 *
 * 这个文件是 `get_plugin_logs` 的**保底数据源**：宿主把 stdout 重定向到哪里
 * 我们控制不了，但插件自己的生命周期事件（加载、启停、卸载、更新、校验失败）
 * 必须留下来，否则"为什么这个插件没生效"永远查不到。
 *
 * 每行以 `[plugin-doctor]` 开头，与宿主里 doctor 的 console 前缀一致，
 * 这样按包名过滤时两个来源都能命中。
 */
export declare function dlog(line: string): void;
export { dirname };
