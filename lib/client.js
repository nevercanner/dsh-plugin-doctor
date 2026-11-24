window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-plugin-doctor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		// src/client/index.ts
		/**
		* @dsh-external/dsh-plugin-doctor — 浏览器半。
		*
		* 三个注册：
		*  · `sidebar.panellist` —— 左侧栏入口（一级图标，带问题数徽标文案）；
		*  · `main` keyed=PANEL_ID —— 点入口后整页打开的面板；
		*  · 定时轮询 `/summary` —— 让入口的徽标自己更新，不用等人打开面板。
		*
		* 宿主能力一律 `fetch` 我们自己的路由（同源），不 import 官方 rc 包，接口变了只坏这一屏。
		*/
		const NS = "@dsh-external/dsh-plugin-doctor";
		const PANEL_ID = NS;
		const API = "/@dsh-external/dsh-plugin-doctor/api";
		async function getJson(url, init) {
			const response = await fetch(url, {
				credentials: "same-origin",
				...init
			});
			const text = await response.text();
			let data;
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				throw new Error(`响应不是 JSON（HTTP ${response.status}）：${text.slice(0, 160)}`);
			}
			if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
			return data;
		}
		const post = (path, payload) => getJson(`${API}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload)
		});
		const SEVERITY_TEXT = {
			error: "错误",
			warning: "待修",
			info: "提示",
			ok: "正常"
		};
		function DoctorIcon(props) {
			const size = props.size ?? 18;
			return (0, react.createElement)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				"aria-hidden": "true"
			}, (0, react.createElement)("rect", {
				x: 2.2,
				y: 2.2,
				width: 19.6,
				height: 19.6,
				rx: 5.4,
				stroke: "currentColor",
				strokeWidth: 1.6,
				opacity: props.active ? 1 : .9
			}), (0, react.createElement)("path", {
				d: "M7.4 12.4l3 3 6.2-6.6",
				stroke: "currentColor",
				strokeWidth: 1.9,
				strokeLinecap: "round",
				strokeLinejoin: "round"
			}), (0, react.createElement)("path", {
				d: "M12 6.2v2.1M11 7.25h2",
				stroke: "currentColor",
				strokeWidth: 1.4,
				strokeLinecap: "round",
				opacity: .75
			}));
		}
		const STYLE_ID = "pd-doctor-style";
		const CSS = `
.pd-root{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}
.pd-head{display:flex;align-items:center;gap:12px;padding:14px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:none}
.pd-head h1{margin:0;font-size:15px;font-weight:600;letter-spacing:.2px}
.pd-head .pd-meta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.pd-actions{margin-left:auto;display:flex;gap:8px;align-items:center}
.pd-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:8px;padding:5px 11px;font-size:12px;cursor:pointer;transition:background .15s,border-color .15s}
.pd-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pd-btn[disabled]{opacity:.45;cursor:default}
.pd-btn.pd-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-inverted)}
.pd-btn.pd-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.pd-btn.pd-ghost{background:transparent}
.pd-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:10px;padding:14px 20px 4px;flex:none}
.pd-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:var(--dsw-alias-bg-layer-1)}
.pd-stat b{display:block;font-size:19px;font-weight:600;line-height:1.2}
.pd-stat span{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.pd-stat.is-error b{color:var(--dsw-alias-state-error-primary)}
.pd-stat.is-warn b{color:var(--dsw-static-amber-500)}
.pd-stat.is-ok b{color:var(--dsw-alias-state-success-primary)}
.pd-tabs{display:flex;gap:4px;padding:12px 20px 0;flex:none;flex-wrap:wrap}
.pd-tab{appearance:none;border:none;background:transparent;color:var(--dsw-alias-label-secondary);padding:6px 11px;border-radius:8px;font-size:12.5px;cursor:pointer}
.pd-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.pd-tab.is-active{background:var(--dsw-alias-interactive-bg-active);color:var(--dsw-alias-label-primary);font-weight:600}
.pd-body{flex:1;min-height:0;overflow:auto;padding:12px 20px 28px}
.pd-note{border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:8px;padding:9px 12px;margin-bottom:12px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pd-note.is-bad{border-left-color:var(--dsw-alias-state-error-primary)}
.pd-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;margin-bottom:10px}
.pd-card h3{margin:0 0 4px;font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pd-chip{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-weight:500;white-space:nowrap}
.pd-chip.error{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.pd-chip.warning{color:var(--dsw-static-amber-500);border-color:currentColor}
.pd-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:currentColor}
.pd-card p{margin:2px 0;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.pd-card .pd-why{color:var(--dsw-alias-label-tertiary)}
.pd-card .pd-sug{color:var(--dsw-alias-label-primary-dimmed)}
.pd-cardfoot{display:flex;gap:8px;align-items:center;margin-top:9px;flex-wrap:wrap}
.pd-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:var(--dsw-alias-markdown-code-block);padding:1px 5px;border-radius:5px}
.pd-empty{color:var(--dsw-alias-label-tertiary);padding:22px 4px;font-size:12.5px}
.pd-field{display:grid;grid-template-columns:minmax(120px,190px) 1fr auto;gap:8px;align-items:center;margin:7px 0}
.pd-field label{font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.pd-field input{width:100%;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);padding:5px 9px;font-size:12.5px;font-family:inherit}
.pd-field input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.pd-table{width:100%;border-collapse:collapse;font-size:12px}
.pd-table th{ text-align:left;font-weight:600;color:var(--dsw-alias-label-tertiary);padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.pd-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top;color:var(--dsw-alias-label-secondary)}
.pd-table tr:last-child td{border-bottom:none}
.pd-table td.pd-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-primary)}
.pd-missing{color:var(--dsw-alias-state-error-primary)}
.pd-ok{color:var(--dsw-alias-state-success-primary)}
.pd-toast{position:sticky;bottom:0;margin-top:8px;padding:8px 12px;border-radius:8px;font-size:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2)}
.pd-toast.is-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.pd-footbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:5px;cursor:pointer;font-size:12px;font-family:inherit}
.pd-manage-head{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.pd-manage-head .pd-note{flex:1;margin-bottom:0}
.pd-manage-table td{padding:8px}
.pd-path{font-size:11px;color:var(--dsw-alias-label-tertiary);word-break:break-all;max-width:260px}
.pd-ops{display:flex;gap:5px;flex-wrap:wrap}
.pd-btn.pd-mini{padding:3px 8px;font-size:11.5px;border-radius:6px}
.pd-btn.pd-danger{color:var(--dsw-alias-state-error-primary);border-color:currentColor}
.pd-btn.pd-danger:hover{background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)}
.pd-logdrawer{margin-top:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);overflow:hidden}
.pd-loghead{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.pd-loghead b{font-size:12.5px}
.pd-loghead .pd-btn{margin-left:auto}
.pd-logbody{margin:0;padding:10px 12px;max-height:320px;overflow:auto;font-size:11.5px;line-height:1.55;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}
.pd-footbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
`;
		function ensureStyle() {
			if (typeof document === "undefined") return;
			if (document.getElementById(STYLE_ID)) return;
			const node = document.createElement("style");
			node.id = STYLE_ID;
			node.textContent = CSS;
			document.head.appendChild(node);
		}
		function Panel() {
			const [report, setReport] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [tab, setTab] = (0, react.useState)("findings");
			const [drafts, setDrafts] = (0, react.useState)({});
			const [toast, setToast] = (0, react.useState)(null);
			const [registry, setRegistry] = (0, react.useState)(null);
			const [manageBusy, setManageBusy] = (0, react.useState)("");
			const [logOpen, setLogOpen] = (0, react.useState)(null);
			const mounted = (0, react.useRef)(true);
			const load = (0, react.useCallback)(async (fresh) => {
				setBusy(true);
				try {
					const data = await getJson(`${API}/report${fresh ? "?fresh=1" : ""}`);
					if (!mounted.current) return;
					setReport(data);
					setError("");
				} catch (cause) {
					if (!mounted.current) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					if (mounted.current) setBusy(false);
				}
			}, []);
			(0, react.useEffect)(() => {
				ensureStyle();
				mounted.current = true;
				load(true);
				const timer = setInterval(() => {
					load(false);
				}, 3e4);
				return () => {
					mounted.current = false;
					clearInterval(timer);
				};
			}, [load]);
			(0, react.useMemo)(() => Object.entries(drafts).filter(([, value]) => value.trim() !== ""), [drafts]);
			const loadRegistry = (0, react.useCallback)(async () => {
				try {
					const data = await getJson(`${API}/plugins`);
					if (mounted.current) setRegistry(Array.isArray(data?.plugins) ? data.plugins : []);
				} catch (cause) {
					if (mounted.current) setToast({
						text: `读取插件清单失败：${cause instanceof Error ? cause.message : String(cause)}`,
						bad: true
					});
				}
			}, []);
			(0, react.useEffect)(() => {
				if (tab === "manage") loadRegistry();
			}, [tab, loadRegistry]);
			/** 统一跑一个管家动作：置忙 → 请求 → 提示 → 刷新清单。 */
			const manage = async (name, label, run) => {
				setManageBusy(name + ":" + label);
				try {
					const result = await run();
					const ok = result?.ok !== false;
					setToast({
						text: `${name} · ${label}：${result?.message ?? (ok ? "已完成" : "失败")}`,
						bad: !ok
					});
					if (Array.isArray(result?.registry?.plugins)) setRegistry(result.registry.plugins);
					else await loadRegistry();
				} catch (cause) {
					setToast({
						text: `${name} · ${label} 失败：${cause instanceof Error ? cause.message : String(cause)}`,
						bad: true
					});
				} finally {
					if (mounted.current) setManageBusy("");
				}
			};
			const doToggle = (p) => manage(p.name, p.disabled ? "启用" : "禁用", () => post("/toggle", {
				pluginId: p.name,
				enabled: p.disabled
			}));
			const doUninstall = (p) => {
				if (!(typeof window !== "undefined" && typeof window.confirm === "function" ? window.confirm(`确定卸载 ${p.name}？会删除目录 ${p.path} 并清理引用。`) : false)) return;
				return manage(p.name, "卸载", () => post("/uninstall", { pluginId: p.name }));
			};
			const doUpdate = (p) => manage(p.name, "更新", () => post("/update", { pluginId: p.name }));
			const doValidate = (p) => manage(p.name, "校验配置", async () => {
				const r = await getJson(`${API}/validate?pluginId=${encodeURIComponent(p.name)}`);
				const lines = Array.isArray(r?.errors) && r.errors.length ? r.errors.map((e) => `${e.path} [${e.kind}] ${e.message}`).join("；") : "";
				return {
					ok: r?.ok !== false,
					message: lines || r?.message || "通过"
				};
			});
			const doLogs = (p) => manage(p.name, "日志", async () => {
				const r = await getJson(`${API}/logs?pluginId=${encodeURIComponent(p.name)}&limit=120`);
				setLogOpen({
					plugin: p.name,
					lines: Array.isArray(r?.lines) ? r.lines : []
				});
				return {
					ok: r?.ok !== false,
					message: r?.message ?? ""
				};
			});
			const runFix = async (entryId, kind, path, value) => {
				setBusy(true);
				try {
					const result = await post("/fix", {
						entryId,
						kind,
						path,
						value
					});
					if (result.report) setReport(result.report);
					setToast({
						text: result.message ?? (result.ok ? "已应用" : "失败"),
						bad: !result.ok
					});
				} catch (cause) {
					setToast({
						text: cause instanceof Error ? cause.message : String(cause),
						bad: true
					});
				} finally {
					setBusy(false);
				}
			};
			const runFixAll = async () => {
				setBusy(true);
				try {
					const result = await post("/fix-all", {});
					if (result.report) setReport(result.report);
					const applied = Array.isArray(result.applied) ? result.applied.length : 0;
					const failed = Array.isArray(result.failed) ? result.failed.length : 0;
					setToast({
						text: `一键修复：成功 ${applied} 项${failed ? `，失败 ${failed} 项（见清单）` : ""}`,
						bad: failed > 0
					});
				} catch (cause) {
					setToast({
						text: cause instanceof Error ? cause.message : String(cause),
						bad: true
					});
				} finally {
					setBusy(false);
				}
			};
			const saveFirstRun = async (item) => {
				const filled = item.gaps.map((gap) => ({
					gap,
					value: (drafts[`${item.entryId}:${gap.path}`] ?? "").trim()
				})).filter((entry) => entry.value !== "");
				if (!filled.length) {
					setToast({
						text: "先填至少一个字段再保存",
						bad: true
					});
					return;
				}
				for (const entry of filled) await runFix(item.entryId, "set-field", entry.gap.path, entry.value);
				setDrafts((prev) => {
					const next = { ...prev };
					for (const entry of filled) delete next[`${item.entryId}:${entry.gap.path}`];
					return next;
				});
				setToast({ text: `${item.plugin}：已写入 ${filled.length} 个字段` });
			};
			const ack = async (entryId) => {
				setBusy(true);
				try {
					const result = await post("/ack", { entryIds: [entryId] });
					if (result.report) setReport(result.report);
					setToast({ text: "已标记为\"稍后配置\"，不再出现在首次配置里" });
				} catch (cause) {
					setToast({
						text: cause instanceof Error ? cause.message : String(cause),
						bad: true
					});
				} finally {
					setBusy(false);
				}
			};
			const head = (0, react.createElement)("header", { className: "pd-head" }, (0, react.createElement)(DoctorIcon, { size: 20 }), (0, react.createElement)("div", null, (0, react.createElement)("h1", null, "插件体检"), (0, react.createElement)("div", { className: "pd-meta" }, report ? `${report.summary.entries} 个插件 · ${report.profile} · ${formatTime(report.generatedAt)}` : "正在读取 composition…")), (0, react.createElement)("div", { className: "pd-actions" }, (0, react.createElement)("button", {
				className: "pd-btn pd-ghost",
				disabled: busy,
				onClick: () => void load(true)
			}, busy ? "刷新中…" : "重新体检"), (0, react.createElement)("button", {
				className: "pd-btn pd-primary",
				disabled: busy || !report || !report.findings.some((f) => f.fix && f.fix.kind !== "set-field"),
				onClick: () => void runFixAll()
			}, "一键修复可自动修的")));
			if (error && !report) return (0, react.createElement)("div", { className: "pd-root" }, head, (0, react.createElement)("div", { className: "pd-body" }, (0, react.createElement)("div", { className: "pd-note is-bad" }, `宿主 API 读不到：${error}`), (0, react.createElement)("div", { className: "pd-empty" }, "这通常说明宿主半没装配（只注入了 client bundle）。检查 entry 是否在跑，再点\"重新体检\"。")));
			if (!report) return (0, react.createElement)("div", { className: "pd-root" }, head, (0, react.createElement)("div", { className: "pd-body" }, (0, react.createElement)("div", { className: "pd-empty" }, "正在体检…")));
			const stats = (0, react.createElement)("div", { className: "pd-stats" }, stat(report.summary.entries, "已装插件", ""), stat(report.summary.errors, "错误", report.summary.errors ? "is-error" : "is-ok"), stat(report.summary.pendingConfig, "待填配置", report.summary.pendingConfig ? "is-warn" : "is-ok"), stat(report.summary.missingServices, "缺依赖服务", report.summary.missingServices ? "is-error" : "is-ok"), stat(report.summary.healthy, "完全健康", "is-ok"));
			const tabs = (0, react.createElement)("nav", { className: "pd-tabs" }, ...[
				["findings", `问题清单 (${report.findings.length})`],
				["firstrun", `首次配置 (${report.firstRun.length})`],
				["graph", `依赖关系 (${report.services.filter((service) => !service.available).length} 项缺)`],
				["entries", `全部插件 (${report.entries.length})`],
				["manage", "插件管家"]
			].map(([key, label]) => (0, react.createElement)("button", {
				key,
				className: `pd-tab${tab === key ? " is-active" : ""}`,
				onClick: () => setTab(key)
			}, label)));
			let body;
			if (tab === "findings") body = renderFindings(report, busy, runFix);
			else if (tab === "firstrun") body = renderFirstRun(report, drafts, setDrafts, busy, saveFirstRun, ack);
			else if (tab === "graph") body = renderGraph(report);
			else if (tab === "manage") body = renderManage({
				rows: registry,
				busyKey: manageBusy,
				onReload: () => void loadRegistry(),
				onToggle: (p) => void doToggle(p),
				onUninstall: (p) => void doUninstall(p),
				onUpdate: (p) => void doUpdate(p),
				onValidate: (p) => void doValidate(p),
				onLogs: (p) => void doLogs(p),
				logOpen,
				onCloseLogs: () => setLogOpen(null)
			});
			else body = renderEntries(report);
			return (0, react.createElement)("div", { className: "pd-root" }, head, stats, tabs, (0, react.createElement)("main", { className: "pd-body" }, report.alerts.length ? (0, react.createElement)("div", { className: "pd-note is-bad" }, report.alerts.join("；")) : null, body, toast ? (0, react.createElement)("div", { className: `pd-toast${toast.bad ? " is-bad" : ""}` }, toast.text) : null));
		}
		function stat(value, label, tone) {
			return (0, react.createElement)("div", { className: `pd-stat ${tone}` }, (0, react.createElement)("b", null, String(value)), (0, react.createElement)("span", null, label));
		}
		function renderFindings(report, busy, runFix) {
			if (!report.findings.length) return (0, react.createElement)("div", { className: "pd-empty" }, "没有任何问题：所有插件的依赖服务都到位，必填配置也都填了。");
			return (0, react.createElement)("div", null, ...report.findings.map((finding) => (0, react.createElement)("article", {
				key: finding.id,
				className: "pd-card"
			}, (0, react.createElement)("h3", null, (0, react.createElement)("span", { className: `pd-chip ${finding.severity}` }, SEVERITY_TEXT[finding.severity] ?? finding.severity), finding.title), (0, react.createElement)("p", { className: "pd-why" }, finding.detail), (0, react.createElement)("p", { className: "pd-sug" }, (0, react.createElement)("b", null, "怎么修："), finding.suggestion), finding.candidates && finding.candidates.length ? (0, react.createElement)("p", { className: "pd-why" }, "候选：", ...finding.candidates.map((name, index) => (0, react.createElement)("span", { key: index }, index ? "、" : "", (0, react.createElement)("span", { className: "pd-code" }, name)))) : null, (0, react.createElement)("div", { className: "pd-cardfoot" }, (0, react.createElement)("span", { className: "pd-chip" }, finding.plugin), finding.fix && finding.fix.kind !== "set-field" ? (0, react.createElement)("button", {
				className: "pd-btn pd-primary",
				disabled: busy,
				onClick: () => void runFix(finding.entryId, finding.fix.kind, finding.fix.path, finding.fix.value)
			}, finding.fix.label) : null, finding.fix && finding.fix.kind === "set-field" ? (0, react.createElement)("span", { className: "pd-code" }, `去「首次配置」填 ${finding.fix.path}`) : null))));
		}
		function renderFirstRun(report, drafts, setDrafts, busy, save, ack) {
			if (!report.firstRun.length) return (0, react.createElement)("div", { className: "pd-empty" }, "没有待配置的插件。新装插件第一次出现在 composition 里时会自动列到这里。");
			return (0, react.createElement)("div", null, ...report.firstRun.map((item) => (0, react.createElement)("article", {
				key: item.entryId,
				className: "pd-card"
			}, (0, react.createElement)("h3", null, (0, react.createElement)("span", { className: `pd-chip ${item.note === "新安装" ? "warning" : ""}` }, item.note), item.plugin), item.missingServices.length ? (0, react.createElement)("p", { className: "pd-why pd-missing" }, `还缺服务：${item.missingServices.join("、")}（这个填字段解决不了，要装/启用提供者）`) : null, ...item.gaps.map((gap) => (0, react.createElement)("div", {
				key: gap.path,
				className: "pd-field"
			}, (0, react.createElement)("label", { title: gap.description ?? gap.path }, gap.path, gap.secret ? (0, react.createElement)("span", { className: "pd-chip" }, "密钥") : null), (0, react.createElement)("input", {
				type: gap.secret ? "password" : "text",
				placeholder: gap.problem === "placeholder" ? "当前是占位值，请填真实值" : "必填",
				value: drafts[`${item.entryId}:${gap.path}`] ?? "",
				onChange: (event) => {
					const value = event.target.value;
					setDrafts((prev) => ({
						...prev,
						[`${item.entryId}:${gap.path}`]: value
					}));
				}
			}), gap.defaultValue !== void 0 && gap.defaultValue !== null ? (0, react.createElement)("button", {
				className: "pd-btn",
				disabled: busy,
				onClick: () => setDrafts((prev) => ({
					...prev,
					[`${item.entryId}:${gap.path}`]: String(gap.defaultValue)
				}))
			}, `默认 ${String(gap.defaultValue)}`) : (0, react.createElement)("span"))), (0, react.createElement)("div", { className: "pd-cardfoot" }, (0, react.createElement)("button", {
				className: "pd-btn pd-primary",
				disabled: busy,
				onClick: () => save(item)
			}, "保存并热更新"), (0, react.createElement)("button", {
				className: "pd-btn pd-ghost",
				disabled: busy,
				onClick: () => ack(item.entryId)
			}, "稍后配置"), (0, react.createElement)("span", { className: "pd-why" }, "保存走 Loader 的 config 校验与热更新，不用重启 dsh。")))));
		}
		function renderGraph(report) {
			const rows = report.services.filter((service) => service.consumers.length || !service.available || service.providers.length).sort((a, b) => Number(a.available) - Number(b.available) || b.consumers.length - a.consumers.length);
			if (!rows.length) return (0, react.createElement)("div", { className: "pd-empty" }, "没有采集到服务依赖关系。");
			return (0, react.createElement)("div", null, (0, react.createElement)("div", { className: "pd-note" }, "每行是一个宿主服务：谁提供它、谁在等它。红色的服务当前没有可用提供者 —— 等它的插件都会静默失效。"), (0, react.createElement)("table", { className: "pd-table" }, (0, react.createElement)("thead", null, (0, react.createElement)("tr", null, (0, react.createElement)("th", null, "服务"), (0, react.createElement)("th", null, "状态"), (0, react.createElement)("th", null, "提供者"), (0, react.createElement)("th", null, "消费方"))), (0, react.createElement)("tbody", null, ...rows.map((service) => (0, react.createElement)("tr", { key: service.name }, (0, react.createElement)("td", { className: "pd-mono" }, service.name), (0, react.createElement)("td", { className: service.available ? "pd-ok" : "pd-missing" }, service.available ? "在位" : "缺失"), (0, react.createElement)("td", null, service.providers.length ? service.providers.join("、") : "—"), (0, react.createElement)("td", null, service.consumers.length ? service.consumers.join("、") : "—"))))));
		}
		const MANAGE_STATUS_LABEL = {
			enabled: "启用",
			disabled: "禁用",
			installing: "装配中",
			failed: "失败",
			unconfigured: "待配置",
			unknown: "未知"
		};
		function renderManage(props) {
			const { rows, busyKey } = props;
			const btn = (p, label, tone, onClick) => {
				const busy = busyKey === p.name + ":" + label;
				return (0, react.createElement)("button", {
					key: label,
					className: `pd-btn pd-mini${tone ? " " + tone : ""}`,
					disabled: Boolean(busyKey),
					onClick
				}, busy ? "…" : label);
			};
			const head = (0, react.createElement)("div", { className: "pd-manage-head" }, (0, react.createElement)("div", { className: "pd-note" }, "这里能直接管插件：启用/禁用（宿主级 fiber dispose 与重装）、从 GitHub 更新、校验配置、看日志、卸载。", " 落盘根目录固定为 D:\\deepseek\\plugins，卸载前有路径白名单校验。"), (0, react.createElement)("button", {
				className: "pd-btn pd-ghost",
				onClick: props.onReload
			}, "刷新清单"));
			if (!rows) return (0, react.createElement)("div", null, head, (0, react.createElement)("div", { className: "pd-empty" }, "正在读取插件清单…"));
			if (!rows.length) return (0, react.createElement)("div", null, head, (0, react.createElement)("div", { className: "pd-empty" }, "没有读到任何插件。"));
			const table = (0, react.createElement)("table", { className: "pd-table pd-manage-table" }, (0, react.createElement)("thead", null, (0, react.createElement)("tr", null, (0, react.createElement)("th", null, "插件"), (0, react.createElement)("th", null, "版本"), (0, react.createElement)("th", null, "状态"), (0, react.createElement)("th", null, "路径"), (0, react.createElement)("th", null, "操作"))), (0, react.createElement)("tbody", null, ...rows.map((p) => (0, react.createElement)("tr", { key: p.name + "@" + p.version }, (0, react.createElement)("td", { className: "pd-mono" }, p.name, p.entryCount && p.entryCount > 1 ? (0, react.createElement)("span", { className: "pd-chip" }, p.entryCount + " 入口") : null), (0, react.createElement)("td", null, p.version || "—"), (0, react.createElement)("td", { className: p.status === "failed" ? "pd-missing" : p.status === "enabled" ? "pd-ok" : "" }, MANAGE_STATUS_LABEL[p.status] ?? p.status), (0, react.createElement)("td", { className: "pd-mono pd-path" }, p.path || "（未落盘）"), (0, react.createElement)("td", null, (0, react.createElement)("div", { className: "pd-ops" }, btn(p, p.disabled ? "启用" : "禁用", p.disabled ? "pd-primary" : "", () => props.onToggle(p)), btn(p, "更新", "", () => props.onUpdate(p)), btn(p, "校验", "", () => props.onValidate(p)), btn(p, "日志", "", () => props.onLogs(p)), btn(p, "卸载", "pd-danger", () => props.onUninstall(p))))))));
			const drawer = props.logOpen ? (0, react.createElement)("div", { className: "pd-logdrawer" }, (0, react.createElement)("div", { className: "pd-loghead" }, (0, react.createElement)("b", null, `日志 · ${props.logOpen.plugin}`), (0, react.createElement)("span", { className: "pd-chip" }, props.logOpen.lines.length + " 行"), (0, react.createElement)("button", {
				className: "pd-btn pd-ghost pd-mini",
				onClick: props.onCloseLogs
			}, "关闭")), (0, react.createElement)("pre", { className: "pd-logbody" }, props.logOpen.lines.length ? props.logOpen.lines.join("\n") : "（没有匹配行）")) : null;
			return (0, react.createElement)("div", null, head, table, drawer);
		}
		function renderEntries(report) {
			return (0, react.createElement)("table", { className: "pd-table" }, (0, react.createElement)("thead", null, (0, react.createElement)("tr", null, (0, react.createElement)("th", null, "插件"), (0, react.createElement)("th", null, "状态"), (0, react.createElement)("th", null, "缺服务"), (0, react.createElement)("th", null, "待填"), (0, react.createElement)("th", null, "提供"))), (0, react.createElement)("tbody", null, ...report.entries.map((entry) => (0, react.createElement)("tr", { key: entry.entryId }, (0, react.createElement)("td", { className: "pd-mono" }, entry.plugin), (0, react.createElement)("td", { className: entry.severity === "error" ? "pd-missing" : entry.disabled ? "" : "pd-ok" }, entry.state), (0, react.createElement)("td", { className: entry.missingServices.length ? "pd-missing" : "" }, entry.missingServices.length ? entry.missingServices.join("、") : "—"), (0, react.createElement)("td", null, entry.gaps.length ? entry.gaps.map((gap) => gap.path).join("、") : "—"), (0, react.createElement)("td", null, entry.provides.length ? entry.provides.join("、") : "—")))));
		}
		function formatTime(iso) {
			const date = new Date(iso);
			if (Number.isNaN(date.getTime())) return iso;
			const pad = (value) => String(value).padStart(2, "0");
			return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
		}
		const inject = ["slots"];
		function apply(ctx) {
			ensureStyle();
			const slots = ctx?.slots;
			if (!slots) return;
			/** 整页跳转（宿主 layout 服务）；拿不到就只留侧栏入口。 */
			let openPanel = () => {};
			ctx.effect(() => slots.inject("sidebar.panellist", () => slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 32,
				label: () => "插件体检"
			}, (props) => (0, react.createElement)(DoctorIcon, {
				size: props?.size ?? 18,
				active: Boolean(props?.active)
			}))), `${NS}: sidebar entry`);
			ctx.effect(() => slots.inject("main", () => slots.register({
				name: "main",
				key: PANEL_ID
			}, () => (0, react.createElement)(Panel, null))), `${NS}: main panel`);
			ctx.effect(() => slots.inject("sidebar.footer.action", () => slots.register({
				name: "sidebar.footer.action",
				id: `${PANEL_ID}-footer`,
				order: 46,
				label: "插件体检"
			}, () => (0, react.createElement)("button", {
				className: "pd-footbtn",
				title: "插件体检：缺密钥 / 缺服务 / 依赖关系",
				onClick: () => openPanel()
			}, (0, react.createElement)(DoctorIcon, { size: 16 })))), `${NS}: footer action`);
			ctx.inject(["layout"], (sub) => {
				if (sub?.layout?.selectPanel) openPanel = () => sub.layout.selectPanel(PANEL_ID);
			});
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map