/**
 * dsh-btw-local — /btw（横質問）のブラウザ半身。
 *
 * 入力欄の上に一時パネルを出し、質問だけをホストへ送る。会話の文脈は
 * ホストがセッションログから読む（クライアントは文脈を組み立てない）。
 * 答えはパネルに流れるだけで、セッションの履歴・イベントには入らない。
 *
 * 開き方:
 * - 送信ボタン横の "btw" チップ
 * - 入力欄に "/btw 質問…" と打つ（プレフィックスは取り除き、質問だけ移す）
 *
 * 着想元: dsh-btw 0.0.3 (MIT, iluluyu)。DSH 0.2.0-rc.2 の slot / RPC に合わせて書き直した。
 */
window.__ModuleLoader__.load({
	id: "dsh-btw-local",
	factory: (require) => {
		const React = require("react");
		const { useEffect, useLayoutEffect, useReducer, useRef, useState } = React;
		const h = React.createElement;

		const NAME = "dsh-btw-local";
		const POLL_MS = 250;

		// ── styles ──────────────────────────────────────────────────────
		const CSS_ID = "@dsh-btw-local/client.css";
		const CSS = `
		.dsh-btw-dock{width:100%;max-width:var(--dsh-composer-card-max-width,720px);margin:0 auto;padding:0 var(--dsh-composer-side-clearance,16px) 6px;}
		.dsh-btw-card{border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));background:var(--dsw-specific-input-major,#fff);border-radius:14px;box-shadow:var(--dsw-shadow-lv2,0 0 1px rgba(0,0,0,.2));display:flex;flex-direction:column;overflow:hidden;font-family:var(--dsw-font-family,inherit);}
		.dsh-btw-head{display:flex;align-items:center;gap:8px;padding:8px 12px 0;}
		.dsh-btw-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#57585a);letter-spacing:.02em;}
		.dsh-btw-hint{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-tertiary,#81858c);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
		.dsh-btw-x{flex:none;width:22px;height:22px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:14px;line-height:1;display:grid;place-items:center;}
		.dsh-btw-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#0f1115);}
		.dsh-btw-answer{padding:6px 14px 2px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#0f1115);white-space:pre-wrap;word-break:break-word;max-height:40vh;overflow-y:auto;}
		.dsh-btw-answer:empty{display:none;}
		.dsh-btw-caret{display:inline-block;width:7px;height:14px;background:var(--dsw-alias-brand-text,#3964fe);vertical-align:-2px;margin-left:2px;animation:dsh-btw-caret .8s steps(2) infinite;}
		@keyframes dsh-btw-caret{0%,100%{opacity:1}50%{opacity:0}}
		.dsh-btw-err{color:var(--dsw-alias-state-error-primary,#e5484d);}
		.dsh-btw-row{display:flex;align-items:flex-end;gap:8px;padding:8px 10px 10px;}
		.dsh-btw-q{flex:1;resize:none;border:none;outline:none;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:inherit;font-size:14px;line-height:22px;padding:4px 6px;max-height:120px;}
		.dsh-btw-q::placeholder{color:var(--dsw-alias-label-caption,#a1a3a8);}
		.dsh-btw-go{flex:none;background:var(--dsw-alias-button-info-fill,#3964fe);color:#fff;cursor:pointer;border:none;border-radius:999px;height:30px;min-width:56px;font-size:12px;font-weight:500;}
		.dsh-btw-go:hover:not(:disabled){background:var(--dsw-alias-button-info-hover,#2b55e0);}
		.dsh-btw-go:disabled{opacity:.4;cursor:default;}
		.dsh-btw-go.ghost{background:transparent;color:var(--dsw-alias-label-secondary,#57585a);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.14));}
		.dsh-btw-chip{height:28px;padding:0 10px;border:none;border-radius:999px;background:var(--dsw-specific-selector,rgba(0,0,0,.05));color:var(--dsw-alias-label-secondary,#57585a);cursor:pointer;font-size:12px;font-weight:500;font-family:inherit;flex:none;}
		.dsh-btw-chip:hover{background:var(--dsw-alias-interactive-bg-hover-solid,rgba(0,0,0,.09));color:var(--dsw-alias-brand-text,#3964fe);}
		`;

		function injectCss() {
			if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = NAME;
			tag.dataset.pluginCss = CSS_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}

		// ── shared plumbing ────────────────────────────────────────────
		const ctxRef = { current: null };

		function rpc(method, payload) {
			const ctx = ctxRef.current;
			if (ctx === null || ctx.connection === undefined) return Promise.reject(new Error("プラグインが未初期化です"));
			return ctx.connection.rpc.call("/btw", method, payload).then((result) => {
				if (!result.ok) throw new Error(result.error?.message || `btw/${method} に失敗しました`);
				return result.value;
			});
		}

		const messageOf = (error) => (error && error.message) || String(error);

		/** 小さな observable。変更は patch、購読は useReducer。 */
		function createStore(initial) {
			const state = { ...initial };
			const listeners = new Set();
			const patch = (fields) => {
				Object.assign(state, fields);
				for (const listener of listeners) {
					try { listener(); } catch { /* 壊れた購読者で止めない */ }
				}
			};
			const use = () => {
				const force = useReducer((x) => x + 1, 0)[1];
				useEffect(() => {
					listeners.add(force);
					return () => { listeners.delete(force); };
				}, []);
				return state;
			};
			return { state, patch, use };
		}

		const ask = createStore({
			phase: "idle", question: "", text: "", error: null,
			jobId: null, timer: null, busy: false, transcriptChars: null,
		});

		function clearTimer() {
			if (ask.state.timer !== null) {
				clearInterval(ask.state.timer);
				ask.patch({ timer: null });
			}
		}

		function closeAsk() {
			const { jobId, busy } = ask.state;
			clearTimer();
			if (busy && jobId !== null) rpc("cancel", { jobId }).catch(() => { /* best effort */ });
			ask.patch({
				phase: "idle", question: "", text: "", error: null,
				jobId: null, busy: false, transcriptChars: null,
			});
		}

		function startAsk(question, sessionId) {
			if (question === "" || ask.state.busy) return;
			if (sessionId === undefined || sessionId === "") {
				ask.patch({ phase: "error", error: "セッションが選択されていません。" });
				return;
			}
			clearTimer();
			ask.patch({ phase: "asking", question, text: "", error: null, busy: true, jobId: null });
			rpc("ask", { question, sessionId }).then((result) => {
				ask.patch({ jobId: result.jobId, transcriptChars: result.transcriptChars });
				const timer = setInterval(() => {
					rpc("poll", { jobId: result.jobId }).then((poll) => {
						ask.patch({ text: poll.text, error: poll.error || null });
						if (poll.done) {
							clearInterval(timer);
							ask.patch({ phase: poll.error ? "error" : "done", busy: false, timer: null });
						}
					}).catch((error) => {
						clearInterval(timer);
						ask.patch({ phase: "error", error: messageOf(error), busy: false, timer: null });
					});
				}, POLL_MS);
				ask.patch({ timer });
			}).catch((error) => {
				ask.patch({ phase: "error", error: messageOf(error), busy: false });
			});
		}

		// ── panel (conversation.input.dock) ────────────────────────────

		function BtwPanel(props) {
			const state = ask.use();
			const [draft, setDraft] = useState("");
			const taRef = useRef(null);
			const answerRef = useRef(null);
			const composing = useRef(false);
			// /btw プレフィックスは 1 回だけ食べる（setDraft による再検出の防止）。
			const armed = useRef(true);
			const carried = useRef("");

			const input = props.useInput !== undefined ? props.useInput((value) => value) : undefined;
			const draftText = input === undefined ? undefined : input.draft;

			useEffect(() => {
				if (props.inputActions === undefined || typeof draftText !== "string") return;
				if (armed.current && /^\/btw(\s|$)/.test(draftText)) {
					armed.current = false;
					const rest = draftText.replace(/^\/btw\s*/, "");
					props.inputActions.setDraft("");
					if (ask.state.phase === "idle") ask.patch({ phase: "open" });
					if (rest !== "") carried.current = rest;
					requestAnimationFrame(() => taRef.current?.focus({ preventScroll: true }));
				} else if (!/^\/btw/.test(draftText)) {
					armed.current = true;
				}
			}, [draftText, props.inputActions]);

			useEffect(() => {
				if (state.phase !== "open") return;
				if (carried.current !== "") {
					setDraft(carried.current);
					carried.current = "";
				}
				taRef.current?.focus({ preventScroll: true });
			}, [state.phase]);

			useLayoutEffect(() => {
				const element = answerRef.current;
				if (element !== null) element.scrollTop = element.scrollHeight;
			}, [state.text]);

			if (state.phase === "idle") return null;

			const submit = () => {
				const question = draft.trim();
				if (question === "" || state.busy) return;
				setDraft("");
				startAsk(question, props.sessionId);
			};
			const onKeyDown = (event) => {
				if (event.key === "Escape") { closeAsk(); return; }
				if (event.key !== "Enter" || event.shiftKey) return;
				const ime = composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
				if (!ime) { event.preventDefault(); submit(); }
			};

			const hint = state.busy
				? "回答中… 文脈だけ・履歴に残しません"
				: state.transcriptChars !== null
					? `文脈 ${state.transcriptChars.toLocaleString()} 文字・履歴に残しません`
					: "会話の文脈だけ・履歴に残しません";
			const head = h("div", { className: "dsh-btw-head" },
				h("span", { className: "dsh-btw-title" }, "btw · 横質問"),
				h("span", { className: "dsh-btw-hint" }, hint),
				h("button", {
					className: "dsh-btw-x", title: "閉じる（Esc）",
					"aria-label": "横質問パネルを閉じる", onClick: closeAsk,
				}, "×"));
			const answer = state.error !== null
				? h("div", { className: "dsh-btw-answer dsh-btw-err" }, state.error)
				: h("div", { className: "dsh-btw-answer", ref: answerRef },
					state.text,
					state.busy ? h("span", { className: "dsh-btw-caret" }) : null);
			const action = state.busy
				? h("button", {
					className: "dsh-btw-go ghost",
					onClick: () => {
						if (state.jobId !== null) rpc("cancel", { jobId: state.jobId }).catch(() => { /* best effort */ });
						clearTimer();
						ask.patch({ busy: false, phase: "done" });
					},
				}, "停止")
				: h("button", {
					className: "dsh-btw-go",
					onClick: submit,
					disabled: draft.trim() === "",
					"aria-label": "質問する",
				}, "聞く");
			const row = h("div", { className: "dsh-btw-row" },
				h("textarea", {
					className: "dsh-btw-q",
					ref: taRef,
					value: draft,
					rows: 1,
					placeholder: "作業を止めずに、今の会話について聞く（例: さっき決めた設定ファイル名は？）",
					onChange: (event) => { setDraft(event.target.value); },
					onKeyDown,
					onCompositionStart: () => { composing.current = true; },
					onCompositionEnd: () => { setTimeout(() => { composing.current = false; }, 10); },
				}),
				action);
			return h("div", { className: "dsh-btw-dock" },
				h("div", { className: "dsh-btw-card" }, head, answer, row));
		}

		// ── chip (conversation.input.right) ────────────────────────────

		function BtwChip() {
			const state = ask.use();
			if (state.phase !== "idle") return null;
			return h("button", {
				type: "button",
				className: "dsh-btw-chip",
				title: "btw 横質問 · メインの作業を止めず、履歴に残さず聞く（入力欄の /btw でも可）",
				onClick: () => { ask.patch({ phase: "open" }); },
			}, "btw");
		}

		// ── plugin entry ───────────────────────────────────────────────

		function apply(ctx) {
			ctxRef.current = ctx;
			injectCss();

			const fibers = [];
			if (ctx.slots !== undefined) {
				fibers.push(ctx.slots.inject("conversation.input.dock", () =>
					ctx.slots.register({ name: "conversation.input.dock", id: "btw-ask", order: 8 }, BtwPanel)));
				fibers.push(ctx.slots.inject("conversation.input.right", () =>
					ctx.slots.register({ name: "conversation.input.right", id: "btw-trigger", order: 5 }, BtwChip)));
			}

			ctx.effect(() => () => {
				for (const fiber of fibers) {
					try {
						const dispose = typeof fiber.dispose === "function" ? fiber.dispose() : fiber();
						if (dispose !== undefined && typeof dispose.catch === "function") dispose.catch(() => { /* ignore */ });
					} catch { /* ignore */ }
				}
				const { jobId, busy } = ask.state;
				clearTimer();
				if (busy && jobId !== null) rpc("cancel", { jobId }).catch(() => { /* host unload cancels anyway */ });
				ctxRef.current = null;
			});
		}

		return { inject: ["slots", "connection"], apply };
	},
});
