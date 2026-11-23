# @dsh-external/dsh-plugin-doctor · 插件体检 + 插件管理

两件事：

1. **体检**：给已装插件做一次健康检查 —— 谁缺 API 密钥、谁缺它依赖的宿主服务、依赖关系是否闭环，并给出可一键执行的修复。
2. **管理**：列出所有已装插件、启用/禁用、卸载、从 GitHub 更新、校验配置、读日志。所有插件的落盘位置统一收敛到 `D:\deepseek\plugins`。

左侧栏图标（order 32）+ 侧栏底部快捷按钮，点开是整页面板。

## 插件管理（v0.2.0 新增）

6 个 Agent 工具 + 3 个 HTTP 端点，操作全部走宿主正规路径，不手改 profile。

### 工具

| 工具 | 作用 |
| --- | --- |
| `list_installed_plugins` | 已装插件清单：状态（启用/禁用/失败/待配置）、版本、来源（bundle/injected/profile/builtin）、固定落盘路径、当前错误。同一包的多个 entry 自动合并成一行（`entryCount` 记条数）。 |
| `toggle_plugin` | 启用 / 禁用。禁用 = `entry.update({disabled:true})` → fiber dispose，其注入的工具/服务从宿主移除；启用 = 重新挂载 + 复核配置缺口。 |
| `uninstall_plugin` | 先从 composition 摘除、清 profile `package.json` 依赖与注入器 registry，再删 `D:\deepseek\plugins\<id>` 目录。删除前过路径白名单。 |
| `update_plugin` | 从 GitHub 更新：git 仓库 `fetch` + `reset --hard origin/<ref>`；无目录则 `clone`。**工作区有未提交改动会拒绝**（避免 reset 冲掉改动）。网络不可用返回离线提示，不抛错。 |
| `validate_plugin_config` | 用插件自己的 schemastery schema 校验，返回**字段级**错误：必填缺失 / 占位值 / `*Env` 环境变量为空 / 绝对路径不存在。 |
| `get_plugin_logs` | 该插件最近的日志行。优先读 doctor 自写的 `~/.dsh/profiles/<profile>/plugin-doctor.log`（宿主 stdout 重定向到哪里不受控，这份一定在），再回落宿主日志文件。 |
| `plugin_storage_info` | 存储根目录概况：目录数、体积排行、未落在根目录下的零散插件、注入器 registry 是否指向旧路径。 |

### HTTP 端点（供面板 / 外部调用）

前缀 `/@dsh-external/dsh-plugin-doctor/api`

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/plugins` | registry 全量 JSON（`?format=md` 出 Markdown 表格，`?format=text` 出紧凑文本） |
| GET | `/validate?pluginId=X` | 配置校验结果 |
| GET | `/logs?pluginId=X&limit=80` | 日志行 |
| POST | `/toggle` | `{pluginId, enabled}` |
| POST | `/uninstall` | `{pluginId}` |
| POST | `/update` | `{pluginId, ref?, repository?}` |

### 路径纪律

- 插件根目录硬编码默认 `D:\deepseek\plugins`，可被环境变量 `DSH_PLUGIN_ROOT` 或插件 config 的 `pluginRoot` 覆盖。
- 任何写入/删除都必须过 `assertInsideRoot()`：目标不在根目录内直接拒绝；根目录本身不许删。
- 插件目录名 = 包名去掉 scope（`@dsh-external/dsh-plugin-doctor` → `dsh-plugin-doctor`）。

## 它检查什么（全部读运行期真值，不猜）

| 数据源 | 用途 |
| --- | --- |
| `ctx.get('configEditor').entries()` | 每个 Loader entry 的 id / 模块名 / raw config / `disabled` |
| `entry.fiber` + `Fiber.state` | 0 pending / 2 active / 3 failed / 4 disposed，判定「没生效」还是「加载失败」 |
| `fiber.inject` | 该插件声明要求的服务名 |
| `ctx.get('reflect').store` | 真正在位的服务实现（含 `check()` 谓词），反推「谁提供谁消费」 |
| `fiber.runtime.Config`（schemastery） | 摊平出可填字段：必填缺失、占位值、`*Env` 变量没值、绝对路径不存在 |
| `~/.dsh/profiles/<profile>/plugin-doctor.json` | 见过的 entry 基线 ⇒ 新装插件自动出现在「首次配置」 |

## 结论分四类

- **错误**：fiber 加载失败（附错误）、声明依赖的服务没有提供者（附候选提供者）
- **待修**：必填缺失、密钥是占位值、`XxxEnv` 字段指向的环境变量为空、绝对路径不存在
- **提示**：关着的插件却在给别人提供必需服务（启用即修）
- **正常**：其余

## 一键修复

三种动作，全部走 Loader 的正常路径（不手改 profile 的 `package.json` / `cordis.patch.yml`）：

- `enable` → `entry.update({ disabled: false })`
- `fill-default` → `configEditor.edit()` 填 schema 默认值
- `set-field` → 首次配置页里由人填值后 `configEditor.edit()` 写入（校验 + 热更新，不用重启）

## 构建

```bash
bash scripts/build.sh          # host: tsc → lib/
npx --no-install tsdown        # client: → lib/client.js（__ModuleLoader__ 形态）
```

本机没有可用的 `@types/node`（app 里那份是空壳）与官方包 d.ts，故 `src/node-shim.d.ts` 自带最小声明；`tsconfig.json` 用 `types: []` 关掉隐式类型库，并把 `src/client` 排除在 host 编译外（client 由 tsdown 转译，不做类型检查）。

## 已知坑

- **`dsh.client.inject` 只写真实存在的包名**。`@deepseek-ai/dsh-client-ui-slots` 在多数安装里**不存在**（77 个官方包无一依赖它），写进去会让 client 模块注册失败、侧栏图标不出现。要注册 `sidebar.panellist` / `main` 槽，inject 写 `@deepseek-ai/dsh-client-ui-layout` + `@deepseek-ai/dsh-client-ui-sidebar` 即可。
- **插件 `node_modules` 不要用 robocopy 搬**。robocopy 会把 junction 展开成实体目录且内容不全，导致 `Cannot find package '@deepseek-ai/dsh-scope'`。迁移后应把 `node_modules/@deepseek-ai/*` 重建为指向宿主的 junction。
- **update_plugin 会拒绝脏工作区**。`reset --hard` 会丢未提交改动，所以有改动时先 `git stash` 或先提交。
