# @dsh-external/dsh-plugin-doctor · 插件体检

给**已装插件**做一次体检：谁缺 API 密钥、谁缺它依赖的宿主服务、依赖关系是否闭环，并给出**可一键执行**的修复与首次配置引导。

左侧栏图标（order 32）+ 侧栏底部快捷按钮，点开是整页面板。

## 它检查什么（全部读运行期真值，不猜）

| 数据源 | 用途 |
| --- | --- |
| `ctx.get('configEditor').entries()` | 每个 Loader entry 的 id / 模块名 / raw config / `disabled` |
| `entry.fiber` + `Fiber.state` | 0 pending / 2 active / 3 failed，判定「没生效」还是「加载失败」 |
| `fiber.inject` | 该插件声明要求的服务名 |
| `ctx.get('reflect').store` | 真正在位的服务实现（含 `check()` 谓词），反推「谁提供谁消费」 |
| `fiber.runtime.Config`（schemastery） | 摊平出可填字段：必填缺失、占位值、`*Env` 变量没值、绝对路径不存在 |
| `~/.dsh/profiles/<profile>/plugin-doctor.json` | 见过的 entry 基线 ⇒ 新装插件自动出现在「首次配置」 |

## 结论分四类

- **错误**：fiber 加载失败（附错误）、声明依赖的服务没有提供者（附候选提供者：已装但禁用 / 需安装）
- **待修**：必填缺失、密钥是占位值、`XxxEnv` 字段指向的环境变量为空、绝对路径不存在
- **提示**：关着的插件却在给别人提供必需服务（启用即修）
- **正常**：其余

## 一键修复

三种动作，全部走 Loader 的正常路径（不手改 profile 的 `package.json` / `cordis.patch.yml`）：

- `enable` → `entry.update({ disabled: false })`
- `fill-default` → `configEditor.edit()` 填 schema 默认值
- `set-field` → 首次配置页里由人填值后 `configEditor.edit()` 写入（校验 + 热更新，不用重启）

## HTTP 端点

前缀 `/@dsh-external/dsh-plugin-doctor/api`

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/report?fresh=1` | 完整体检报告 |
| GET | `/summary` | 只读计数（侧栏徽标） |
| POST | `/fix` | `{entryId, kind, path?, value?}` |
| POST | `/fix-all` | 执行所有可自动修的项 |
| POST | `/ack` | `{entryIds}` 标记「稍后配置」 |
| POST | `/rescan` | 强制重扫 |

## Agent 工具

`plugin_doctor_scan` —— 同样的体检，返回人话清单，便于模型自己排查「为什么这个插件没生效」。

## 构建

```bash
bash scripts/build.sh          # host: tsc → lib/
npx --no-install tsdown        # client: → lib/client.js（__ModuleLoader__ 形态）
```

本机没有可用的 `@types/node`（app 里那份是空壳）与官方包 d.ts，故 `src/node-shim.d.ts` 自带最小声明；`tsconfig.json` 用 `types: []` 关掉隐式类型库，并把 `src/client` 排除在 host 编译外（client 由 tsdown 转译，不做类型检查）。
