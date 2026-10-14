import puppeteer from "@cloudflare/puppeteer";
import type { Browser, CDPSession, Page } from "@cloudflare/puppeteer";
import { DurableObject } from "cloudflare:workers";
import type { Env, SessionRequest, SessionResult } from "./types.js";

const DEFAULT_KEEP_ALIVE_MS = 60_000;
const MAX_TEXT = 80_000;
const MAX_CDP_BYTES = 250_000;
const MAX_SEQUENCE_STEPS = 30;
const MAX_SEQUENCE_MS = 60_000;
const STATE_READ_TIMEOUT_MS = 2_500;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const CDP_CONNECT_TIMEOUT_MS = 10_000;
const BROWSER_API_TIMEOUT_MS = 10_000;
const BROWSER_CLOSE_CONFIRM_TIMEOUT_MS = 2_000;
const STATE_PERSIST_TIMEOUT_MS = 20_000;
const BROWSER_OPERATION_TIMEOUT_MS = 30_000;

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms.`), { code: "CDP_COMMAND_TIMEOUT" })), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function keyCode(key: string): string {
	if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
	if (/^[0-9]$/.test(key)) return `Digit${key}`;
	return key;
}

function virtualKeyCode(key: string): number | undefined {
	return /^[a-z0-9]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : undefined;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
	}
	return btoa(binary);
}

function safeHeaders(headers: Record<string, string>) {
	const hidden = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie", "x-api-key"]);
	return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, hidden.has(name.toLowerCase()) ? "[redacted]" : String(value).slice(0, 1000)]));
}

type Json = Record<string, any>;
type AXNode = {
	nodeId: string;
	backendDOMNodeId?: number;
	ignored?: boolean;
	role?: { value?: string };
	name?: { value?: string };
	value?: { value?: string };
	properties?: Array<{ name: string; value?: { value?: unknown } }>;
};
type PersistedViewport = {
	width: number;
	height: number;
	deviceScaleFactor: number;
	mobile: boolean;
};
type PersistedBrowserTab = {
	/** The previous Cloudflare target ID. It changes when Chromium is restored. */
	tabId?: string;
	url: string;
	viewport: PersistedViewport | null;
};
type PersistedBrowserState = {
	version: 1;
	cookies: Json[];
	localStorage: Record<string, Record<string, string>>;
	tabs: PersistedBrowserTab[];
};
type BrowserConnectionFailure = {
	sessionId: string;
	requestId: string;
	op: string;
	code: string;
	message: string;
	at: number;
};
type BrowserClosePending = { sessionId: string; requestId: string; startedAt: number };
const MUTATING_OPS = new Set(["new_tab", "close_tab", "navigate", "back", "forward", "reload", "wait", "action", "fill_form", "handle_dialog", "evaluate", "viewport", "mouse", "keyboard", "sequence", "network_requests", "debug_capture", "cdp", "handoff", "handoff_status", "handoff_complete"]);

function normalizeViewport(viewport: Partial<PersistedViewport> | null | undefined): PersistedViewport {
	const positiveNumber = (value: number | undefined, fallback: number) => Number.isFinite(value) && Number(value) > 0 ? Number(value) : fallback;
	return {
		width: positiveNumber(viewport?.width, 800),
		height: positiveNumber(viewport?.height, 600),
		deviceScaleFactor: positiveNumber(viewport?.deviceScaleFactor, 1),
		mobile: typeof viewport?.mobile === "boolean" ? viewport.mobile : false,
	};
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function safeText(value: unknown, limit = MAX_TEXT): string {
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return text.length > limit ? `${text.slice(0, limit)}\n… output truncated (${text.length - limit} more characters)` : text;
}

async function evaluatePage(page: Page, expression: string, timeoutMs = 10_000): Promise<unknown> {
	const session = await page.createCDPSession();
	try {
		const result = await session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: Math.min(Math.max(timeoutMs, 1), 30_000) });
		if (result.exceptionDetails) throw Object.assign(new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page evaluation failed."), { code: "PAGE_EVALUATION_ERROR" });
		return result.result?.value ?? null;
	} finally { await session.detach().catch(() => undefined); }
}

type DialogInfo = { type: string; message: string; defaultPrompt?: string };
type ObservedEvaluation = { result?: unknown; dialog?: DialogInfo; dialogPending?: true; session?: CDPSession };

async function evaluatePageWithDialog(page: Page, expression: string, timeoutMs = 10_000): Promise<ObservedEvaluation> {
	const session = await page.createCDPSession();
	let keepSessionOpen = false;
	let resolveDialog!: (value: DialogInfo) => void;
	const dialogOpened = new Promise<DialogInfo>((resolve) => { resolveDialog = resolve; });
	const onDialog = (event: { type?: string; message?: string; defaultPrompt?: string }) => resolveDialog({
		type: String(event.type ?? "unknown"),
		message: String(event.message ?? ""),
		...(event.defaultPrompt ? { defaultPrompt: String(event.defaultPrompt) } : {}),
	});
	session.on("Page.javascriptDialogOpening", onDialog);
	try {
		await session.send("Page.enable");
		const evaluation = session.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: Math.min(Math.max(timeoutMs, 1), 30_000) })
			.then((value) => ({ kind: "result" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
		const outcome = await Promise.race([evaluation, dialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
		if (outcome.kind === "dialog") {
			keepSessionOpen = true;
			return { dialog: outcome.dialog, dialogPending: true, session };
		}
		if (outcome.kind === "error") throw outcome.error;
		if (outcome.value.exceptionDetails) throw Object.assign(new Error(outcome.value.exceptionDetails.exception?.description ?? outcome.value.exceptionDetails.text ?? "Page evaluation failed."), { code: "PAGE_EVALUATION_ERROR" });
		return { result: outcome.value.result?.value ?? null };
	} finally {
		session.off("Page.javascriptDialogOpening", onDialog);
		if (!keepSessionOpen) await session.detach().catch(() => undefined);
	}
}

async function applyViewport(page: Page, viewport: PersistedViewport): Promise<void> {
	// `page.setViewport()` may reload when Puppeteer reconnects to an existing
	// mobile page, because the newly created Page wrapper has no cached viewport
	// state. Use the Page's primary CDP session to restore emulation without a
	// navigation or reload.
	const session = (page as any)._client() as CDPSession;
	const normalized = normalizeViewport(viewport);
	await (session as any).send("Emulation.setDeviceMetricsOverride", {
		width: normalized.width,
		height: normalized.height,
		deviceScaleFactor: normalized.deviceScaleFactor,
		mobile: normalized.mobile,
		screenOrientation: { angle: 0, type: "portraitPrimary" },
	}, { timeout: CDP_COMMAND_TIMEOUT_MS });
	await (session as any).send("Emulation.setTouchEmulationEnabled", { enabled: normalized.mobile }, { timeout: CDP_COMMAND_TIMEOUT_MS });
}

function getTabId(page: Page): string {
	const target = page.target() as any;
	return String(target._targetId ?? target._targetInfo?.targetId ?? "unknown");
}

async function pageSummary(page: Page): Promise<Json> {
	const [title, viewport] = await Promise.all([
		withTimeout(page.title(), STATE_READ_TIMEOUT_MS, "Reading page title").catch(() => ""),
		withTimeout(page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })), STATE_READ_TIMEOUT_MS, "Reading page viewport").catch(() => null),
	]);
	return {
		tabId: getTabId(page),
		url: page.url(),
		title,
		viewport,
	};
}

async function listTabs(browser: Browser): Promise<Json[]> {
	const pages = await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Listing browser tabs");
	return Promise.all(pages.map(pageSummary));
}

async function pickPage(browser: Browser, tabId?: string, create = false): Promise<Page> {
	const pages = await browser.pages();
	if (tabId) {
		const page = pages.find((candidate) => getTabId(candidate) === tabId);
		if (!page) throw Object.assign(new Error(`Tab ${tabId} does not exist.`), { code: "TAB_NOT_FOUND" });
		return page;
	}
	if (pages[0]) return pages[0];
	if (!create) throw Object.assign(new Error("No browser tab is open."), { code: "NO_TABS" });
	return browser.newPage();
}

function normalizeAX(node: AXNode) {
	return {
		role: node.role?.value ?? "",
		name: node.name?.value ?? "",
		value: String(node.value?.value ?? ""),
		backendDOMNodeId: node.backendDOMNodeId ?? null,
		ignored: Boolean(node.ignored),
	};
}

async function axSnapshot(session: CDPSession) {
	const result = await session.send("Accessibility.getFullAXTree", {}) as { nodes?: AXNode[] };
	const nodes = (result.nodes ?? []).filter((node) => !node.ignored && node.backendDOMNodeId && node.role?.value !== "none");
	const serialized = nodes.map(normalizeAX);
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(serialized)));
	const snapshotId = Array.from(new Uint8Array(digest).slice(0, 9), (byte) => byte.toString(16).padStart(2, "0")).join("");
	return { nodes, serialized, snapshotId };
}

async function textSnapshot(page: Page, maxChars = 30_000): Promise<string> {
	return page.evaluate((max) => {
		const walk = (root: ParentNode): string[] => {
			const lines: string[] = [];
			for (const node of Array.from(root.querySelectorAll("body *"))) {
				if (node.shadowRoot) lines.push(...walk(node.shadowRoot));
				const element = node as HTMLElement;
				if (element.hidden || element.getAttribute("aria-hidden") === "true") continue;
				const tag = element.tagName.toLowerCase();
				const role = element.getAttribute("role") || ({ button: "button", a: "link", input: "textbox", textarea: "textbox", select: "combobox" } as Record<string, string>)[tag] || "";
				const name = element.getAttribute("aria-label") || element.getAttribute("placeholder") || element.innerText?.trim().replace(/\s+/g, " ").slice(0, 180) || "";
				const attrs = [element.id ? `#${element.id}` : "", element.getAttribute("name") ? `[name=${element.getAttribute("name")}]` : ""].filter(Boolean).join("");
				if (role || name || attrs) lines.push(`${tag}${attrs}${role ? ` [${role}]` : ""}${name ? ` ${JSON.stringify(name)}` : ""}`);
			}
			return lines;
		};
		return walk(document).join("\n").slice(0, max);
	}, maxChars);
}

async function elementByTarget(page: Page, input: Json, session: CDPSession): Promise<{ objectId: string; backendDOMNodeId: number }> {
	const locator = input.target ?? input;
	if (typeof locator.css === "string" && locator.css.length <= 2000) {
		const { root } = await session.send("DOM.getDocument", { depth: -1, pierce: true });
		const { nodeId } = await session.send("DOM.querySelector", { nodeId: root.nodeId, selector: locator.css });
		if (!nodeId) throw Object.assign(new Error(`No element matches selector: ${locator.css}`), { code: "ELEMENT_NOT_FOUND" });
		const resolved = await session.send("DOM.resolveNode", { nodeId });
		const backend = await session.send("DOM.describeNode", { nodeId });
		return { objectId: resolved.object.objectId!, backendDOMNodeId: backend.node.backendNodeId! };
	}

	if (typeof locator.ref === "string") {
		const snapshot = await axSnapshot(session);
		if (!locator.snapshotId || locator.snapshotId !== snapshot.snapshotId) {
			throw Object.assign(new Error("The element reference is stale. Take a fresh browser_snapshot or browser_find and retry."), { code: "STALE_ELEMENT", snapshotId: snapshot.snapshotId });
		}
		const match = /^e(\d+)$/.exec(locator.ref);
		const node = match ? snapshot.nodes[Number(match[1]) - 1] : undefined;
		if (!node?.backendDOMNodeId) throw Object.assign(new Error(`Element reference ${locator.ref} was not found in this snapshot.`), { code: "ELEMENT_NOT_FOUND" });
		const resolved = await session.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
		return { objectId: resolved.object.objectId!, backendDOMNodeId: node.backendDOMNodeId };
	}

	if (typeof locator.role === "string" || typeof locator.name === "string") {
		const snapshot = await axSnapshot(session);
		const exact = locator.exact !== false;
		const name = String(locator.name ?? "");
		const matches = snapshot.nodes.map((node, index) => ({ node, index })).filter(({ node }) => {
			const roleOkay = !locator.role || node.role?.value === locator.role;
			const candidate = node.name?.value ?? "";
			const nameOkay = !name || (exact ? candidate === name : candidate.toLocaleLowerCase().includes(name.toLocaleLowerCase()));
			return roleOkay && nameOkay;
		});
		if (matches.length > 1) throw Object.assign(new Error(`The locator matched ${matches.length} elements; narrow it with a fresh ref or CSS selector.`), { code: "AMBIGUOUS_TARGET", matches: matches.slice(0, 20).map(({ node, index }) => ({ ref: `e${index + 1}`, role: node.role?.value, name: node.name?.value, snapshotId: snapshot.snapshotId })) });
		const node = matches[0]?.node;
		if (!node?.backendDOMNodeId) throw Object.assign(new Error("No element matched the requested role and name."), { code: "ELEMENT_NOT_FOUND" });
		const resolved = await session.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
		return { objectId: resolved.object.objectId!, backendDOMNodeId: node.backendDOMNodeId };
	}
	throw Object.assign(new Error("Pass a target with css, ref + snapshotId, or role/name."), { code: "INVALID_TARGET" });
}

async function callElement(session: CDPSession, objectId: string, functionDeclaration: string, args: unknown[] = []) {
	let resolveDialog!: (value: DialogInfo) => void;
	const dialogOpened = new Promise<DialogInfo>((resolve) => { resolveDialog = resolve; });
	const onDialog = (event: { type?: string; message?: string; defaultPrompt?: string }) => resolveDialog({
		type: String(event.type ?? "unknown"),
		message: String(event.message ?? ""),
		...(event.defaultPrompt ? { defaultPrompt: String(event.defaultPrompt) } : {}),
	});
	session.on("Page.javascriptDialogOpening", onDialog);
	try {
		const call = session.send("Runtime.callFunctionOn", {
		objectId,
		functionDeclaration,
		arguments: args.map((value) => ({ value })),
		awaitPromise: true,
		returnByValue: true,
		userGesture: true,
	}, { timeout: 10_000 }).then((value) => ({ kind: "result" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
		const outcome = await Promise.race([call, dialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
		if (outcome.kind === "dialog") throw Object.assign(new Error(`A JavaScript ${outcome.dialog.type} dialog is open: ${outcome.dialog.message}`), { code: "JAVASCRIPT_DIALOG_OPEN", dialogPending: true, dialog: outcome.dialog });
		if (outcome.kind === "error") throw outcome.error;
		const result = outcome.value;
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.text ?? "Page script failed.");
	return result.result?.value;
	} finally { session.off("Page.javascriptDialogOpening", onDialog); }
}

async function elementCenter(session: CDPSession, backendDOMNodeId: number) {
	await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: backendDOMNodeId });
	const { model } = await session.send("DOM.getBoxModel", { backendNodeId: backendDOMNodeId });
	const points = model.content as number[];
	return { x: (points[0] + points[2] + points[4] + points[6]) / 4, y: (points[1] + points[3] + points[5] + points[7]) / 4 };
}

async function snapshot(page: Page, input: Json) {
	const session = await page.createCDPSession();
	try {
		const ax = await axSnapshot(session);
		const maxNodes = Math.min(Math.max(Number(input.maxNodes ?? 250), 1), 1000);
		const maxChars = Math.min(Math.max(Number(input.maxChars ?? 30_000), 500), MAX_TEXT);
		const nodes = ax.nodes.slice(0, maxNodes).map((node, index) => ({
			ref: `e${index + 1}`,
			role: node.role?.value ?? "",
			name: node.name?.value ?? "",
			value: node.value?.value,
			backendDOMNodeId: undefined,
		}));
		return { tabId: getTabId(page), url: page.url(), title: await page.title(), snapshotId: ax.snapshotId, nodes, text: safeText(await textSnapshot(page, maxChars), maxChars), truncated: ax.nodes.length > maxNodes };
	} finally {
		await session.detach().catch(() => undefined);
	}
}

async function browserStatus(env: Env, sessionId: string | undefined) {
	if (!sessionId) return { active: false, browserRunActive: false, cdpStatus: "not_connected", browserSessionId: null, tabs: null, tabsKnown: false };
	try {
		const session = await withTimeout(env.BROWSER.getSession(sessionId), BROWSER_API_TIMEOUT_MS, "Checking Browser Run session");
		const active = Boolean(session);
		return {
			active,
			browserRunActive: active,
			cdpStatus: active ? "not_checked" : "not_connected",
			connectionIdPresent: Boolean(session?.connectionId),
			browserRunSession: session ? { startTime: session.startTime ?? null, lastUpdated: session.lastUpdated ?? null, connectionStartTime: session.connectionStartTime ?? null, connectionEndTime: session.connectionEndTime ?? null } : null,
			browserSessionId: undefined,
			tabs: null,
			tabsKnown: false,
		};
	} catch {
		return { active: null, browserRunActive: null, cdpStatus: "unknown", browserSessionId: undefined, tabs: null, tabsKnown: false, error: "Could not query Browser Run session metadata." };
	}
}

export class BrowserSession extends DurableObject<Env> {
	private lock: Promise<void> = Promise.resolve();
	private lockEpoch = 0;
	private activeOperation?: { requestId: string; op: string; startedAt: number };
	private activeOperationEpoch?: number;
	private activeRelease?: () => void;
	private closeOperation?: { requestId: string; op: string; startedAt: number };
	private closeBarrier?: Promise<void>;
	private queuedOperations = 0;
	private lastCdpCheck?: { sessionId: string; status: "reachable"; at: number };
	private pendingDialogSession?: CDPSession;
	private pendingDialogResolver?: (accept: boolean, promptText?: string) => Promise<void>;
	private pendingDialogPage?: Page;
	private pendingDialogBrowser?: Browser;
	private pendingDialogSessionId?: string;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request): Promise<Response> {
		if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
		const startedAt = Date.now();
		const requestId = crypto.randomUUID();
		let input: SessionRequest;
		try { input = await request.json() as SessionRequest; }
		catch { return jsonResponse({ isError: true, requestId, code: "INVALID_INPUT", message: "Request body must be valid JSON.", durationMs: Date.now() - startedAt }); }
		// A modal dialog can suspend the request that opened it while holding the
		// session queue. Dismiss/accept it out of band so that request can resume.
		if (input.op === "handle_dialog") {
			try {
				const result = await this.handleDialogOutOfBand(input);
				result.structuredContent = { ...(result.structuredContent ?? {}), requestId, durationMs: Date.now() - startedAt };
				return jsonResponse(result);
			} catch (error) {
				const value = error as { code?: string; message?: string; [key: string]: unknown };
				return jsonResponse({ isError: true, requestId, code: this.errorCode(error), message: value.message ?? String(error), durationMs: Date.now() - startedAt, ...(value.tabIdMappings ? { tabIdMappings: value.tabIdMappings } : {}), ...(value.dialogPending ? { dialogPending: true, dialog: value.dialog } : {}) });
			}
		}
		// This recovery operation only edits saved tab metadata and remains
		// available when Chromium restoration or the normal session queue fails.
		if (input.op === "forget_saved_tab") {
			try {
				const result = await this.forgetSavedTab(input.input ?? {});
				result.structuredContent = { ...(result.structuredContent ?? {}), requestId, durationMs: Date.now() - startedAt };
				return jsonResponse(result);
			} catch (error) {
				const value = error as { code?: string; message?: string };
				return jsonResponse({ isError: true, requestId, code: this.errorCode(error), message: value.message ?? String(error), durationMs: Date.now() - startedAt });
			}
		}
		// This operation only reads Durable Object storage and Browser Run session
		// metadata. Keep it available even if a page operation is stuck on CDP.
		if (input.op === "status") {
			try {
				const result = await this.dispatch(input);
				result.structuredContent = { ...(result.structuredContent ?? {}), requestId, durationMs: Date.now() - startedAt };
				return jsonResponse(result);
			} catch (error) {
				const value = error as { code?: string; message?: string };
				return jsonResponse({ isError: true, requestId, code: this.errorCode(error), message: value.message ?? String(error), durationMs: Date.now() - startedAt });
			}
		}
		// Closing must remain available even when a CDP call or a queued browser
		// operation is stuck. It uses Browser Run's session API directly.
		if (input.op === "close_session") return this.closeSessionOutOfBand(requestId, startedAt);
		if (input.op === "clear_saved_state") return this.clearSavedStateOutOfBand(requestId, startedAt);
		const previous = this.lock;
		let release!: () => void;
		this.lock = new Promise<void>((resolve) => { release = resolve; });
		const operationEpoch = this.lockEpoch;
		this.queuedOperations++;
		const queuedAt = Date.now();
		let acquired = false;
		try {
			await previous;
			if (operationEpoch !== this.lockEpoch) throw Object.assign(new Error("This browser operation was canceled because the session was closed."), { code: "BROWSER_OPERATION_CANCELED" });
			this.queuedOperations--;
			acquired = true;
			const operationStartedAt = Date.now();
			this.activeOperation = { requestId, op: input.op, startedAt: operationStartedAt };
			this.activeOperationEpoch = operationEpoch;
			this.activeRelease = release;
			const queueWaitMs = operationStartedAt - queuedAt;
			if (queueWaitMs >= 1_000 || input.op === "resume") console.info("Browser operation lock acquired", { requestId, op: input.op, queueWaitMs, queuedOperations: this.queuedOperations });
			const result = await this.dispatch(input, operationEpoch);
			result.structuredContent = { ...(result.structuredContent ?? {}), requestId, durationMs: Date.now() - startedAt };
			return jsonResponse(result);
		} catch (error) {
			const value = error as { code?: string; message?: string; [key: string]: unknown };
			const code = this.errorCode(error);
			if (code === "BROWSER_SESSION_LOST" || code === "BROWSER_CONNECTION_FAILED") console.warn("Browser session operation failed", { requestId, op: input.op, code, message: String(value.message ?? error).slice(0, 500), durationMs: Date.now() - startedAt });
			if (code === "CDP_COMMAND_TIMEOUT" || code === "BROWSER_SESSION_LOST") {
				const sessionId = await this.storedSessionId().catch(() => undefined);
				if (sessionId) await this.recordCdpFailure(sessionId, requestId, input.op, code, String(value.message ?? error)).catch(() => undefined);
			}
			return jsonResponse({ isError: true, requestId, code, message: value.message ?? String(error), durationMs: Date.now() - startedAt, ...(value.snapshotId ? { snapshotId: value.snapshotId } : {}), ...(value.matches ? { matches: value.matches } : {}), ...(value.persistenceWarning ? { persistenceWarning: value.persistenceWarning } : {}), ...(value.tabIdMappings ? { tabIdMappings: value.tabIdMappings } : {}), ...(value.dialogPending ? { dialogPending: true, dialog: value.dialog } : {}) });
		} finally {
			if (!acquired) this.queuedOperations--;
			if (acquired) {
				if (Date.now() - startedAt >= 5_000) console.info("Browser operation lock released", { requestId, op: input.op, durationMs: Date.now() - startedAt, queuedOperations: this.queuedOperations });
				if (this.activeOperationEpoch === operationEpoch) {
					this.activeOperation = undefined;
					this.activeOperationEpoch = undefined;
				}
			}
			if (this.activeRelease === release) this.activeRelease = undefined;
			release();
		}
	}

	private errorCode(error: unknown): string {
		const value = error as { code?: string; message?: string };
		const message = value.message ?? String(error);
		if (/target closed|targetcloseerror|session closed|websocket.*closed|connection.*closed|browser disconnected/i.test(message)) return "BROWSER_SESSION_LOST";
		if (/timed out|timeout/i.test(message)) return "CDP_COMMAND_TIMEOUT";
		if (value.code) return value.code;
		return "BROWSER_ERROR";
	}

	private async handleDialogOutOfBand(request: SessionRequest): Promise<SessionResult> {
		const input = request.input ?? {};
		const page = this.pendingDialogPage;
		const browser = this.pendingDialogBrowser;
		const resolveDialog = this.pendingDialogResolver;
		if (page && browser && resolveDialog) {
			const activeSessionId = await this.storedSessionId();
			if (this.pendingDialogSessionId && activeSessionId !== this.pendingDialogSessionId) {
				throw Object.assign(new Error("The browser session changed while a JavaScript dialog was pending."), { code: "DIALOG_SESSION_MISMATCH" });
			}
			if (input.tabId && String(input.tabId) !== getTabId(page)) {
				throw Object.assign(new Error(`A JavaScript dialog is pending in tab ${getTabId(page)}.`), { code: "DIALOG_TAB_MISMATCH" });
			}
			let persistenceWarning: string | undefined;
			try {
				await resolveDialog(Boolean(input.accept), input.promptText === undefined ? undefined : String(input.promptText));
				try { await this.persistState(browser); }
				catch (error) { persistenceWarning = (error as Error).message; }
				return { structuredContent: { handled: true, tabId: getTabId(page), url: page.url(), ...(persistenceWarning ? { persistenceWarning } : {}) } };
			} finally {
				const session = this.pendingDialogSession;
				this.pendingDialogSession = undefined;
				this.pendingDialogResolver = undefined;
				this.pendingDialogPage = undefined;
				this.pendingDialogBrowser = undefined;
				this.pendingDialogSessionId = undefined;
				if (session) await session.detach().catch(() => undefined);
				browser.disconnect();
			}
		}
		throw Object.assign(new Error("The CDP connection for this dialog is no longer available. Close the browser session and resume it before continuing."), { code: "DIALOG_CONNECTION_LOST" });
	}

	private holdDialogSession(page: Page, session: CDPSession): void {
		this.pendingDialogSession = session;
		this.pendingDialogPage = page;
		this.pendingDialogResolver = (accept, promptText) => (session as any).send("Page.handleJavaScriptDialog", {
			accept,
			...(promptText !== undefined ? { promptText } : {}),
		}, { timeout: 10_000 });
	}

	private holdPuppeteerDialog(page: Page, dialog: { accept(promptText?: string): Promise<void>; dismiss(): Promise<void> }): void {
		if (this.pendingDialogResolver) return;
		this.pendingDialogPage = page;
		this.pendingDialogResolver = (accept, promptText) => accept ? dialog.accept(promptText) : dialog.dismiss();
	}

	private async closePendingDialogBrowser(): Promise<void> {
		const session = this.pendingDialogSession;
		const browser = this.pendingDialogBrowser;
		try {
			if (this.pendingDialogResolver) await withTimeout(this.pendingDialogResolver(false), 2_000, "Dismissing pending browser dialog");
		} catch { /* The Browser Run binding closes the session out of band. */ }
		this.pendingDialogSession = undefined;
		this.pendingDialogResolver = undefined;
		this.pendingDialogPage = undefined;
		this.pendingDialogBrowser = undefined;
		this.pendingDialogSessionId = undefined;
		if (session) await withTimeout(session.detach(), 1_000, "Detaching pending dialog session").catch(() => undefined);
		browser?.disconnect();
	}

	private async storedSessionId() { return await this.ctx.storage.get<string>("browserSessionId"); }

	private browserEndpoint(connection: { webSocket: Fetcher }) {
		// Browser Run's session-pinned Fetcher opens CDP at this documented URL.
		// Puppeteer's Workers transport supplies its own fake.host path, which is
		// intended for the unpinned BROWSER binding and must not be forwarded here.
		return { fetch: (_input: RequestInfo | URL, init?: RequestInit) => connection.webSocket.fetch("https://browser-binding.invalid", init) };
	}

	private async connectToBrowserSession(sessionId: string) {
		const connection = await withTimeout(this.env.BROWSER.connectSession(sessionId), BROWSER_API_TIMEOUT_MS, "Creating session-pinned CDP connection");
		return await withTimeout(puppeteer.connect(this.browserEndpoint(connection) as any, sessionId), CDP_CONNECT_TIMEOUT_MS, "Connecting to Browser Run session");
	}

	private async closeBrowserRunSession(sessionId: string): Promise<{ closed: boolean; status: "closed" | "closing" | "unknown"; warning?: string }> {
		try {
			const result = await withTimeout(this.env.BROWSER.closeSession(sessionId), BROWSER_API_TIMEOUT_MS, "Requesting Browser Run session close");
			if (result.status === "closed") return { closed: true, status: "closed" };
		} catch (error) {
			try {
				const current = await withTimeout(this.env.BROWSER.getSession(sessionId), BROWSER_API_TIMEOUT_MS, "Checking Browser Run session after close request");
				if (!current) return { closed: true, status: "closed" };
			} catch { /* Report the bounded close failure below. */ }
			return { closed: false, status: "unknown", warning: String((error as Error)?.message ?? error).slice(0, 300) };
		}

		const deadline = Date.now() + BROWSER_CLOSE_CONFIRM_TIMEOUT_MS;
		while (Date.now() < deadline) {
			await delay(250);
			try {
				const remainingMs = Math.max(1, Math.min(BROWSER_API_TIMEOUT_MS, deadline - Date.now()));
				const current = await withTimeout(this.env.BROWSER.getSession(sessionId), remainingMs, "Waiting for Browser Run session close");
				if (!current) return { closed: true, status: "closed" };
			} catch (error) {
				if (Date.now() >= deadline) break;
				return { closed: false, status: "unknown", warning: String((error as Error)?.message ?? error).slice(0, 300) };
			}
		}
		return { closed: false, status: "closing", warning: "Cloudflare accepted the close request, but the session is still shutting down." };
	}

	private async closeSessionOutOfBand(requestId: string, requestStartedAt: number): Promise<Response> {
		try { if (this.closeBarrier) await withTimeout(this.closeBarrier, 45_000, "Waiting for the previous session close"); }
		catch (error) { return jsonResponse({ isError: true, requestId, code: "BROWSER_CLOSE_PENDING", message: String((error as Error)?.message ?? error), durationMs: Date.now() - requestStartedAt }); }
		const previousOperation = this.activeOperation;
		const sessionId = await this.storedSessionId().catch(() => undefined) ?? this.pendingDialogSessionId;
		this.lockEpoch++;
		const closeEpoch = this.lockEpoch;
		let releaseCloseBarrier!: () => void;
		const closeBarrier = new Promise<void>((resolve) => { releaseCloseBarrier = resolve; });
		this.closeBarrier = closeBarrier;
		this.lock = closeBarrier;
		// Let operations waiting behind the interrupted CDP call unwind. They carry
		// the previous epoch and will return BROWSER_OPERATION_CANCELED.
		const releaseActive = this.activeRelease;
		this.activeRelease = undefined;
		releaseActive?.();
		this.activeOperation = undefined;
		this.activeOperationEpoch = undefined;
		this.closeOperation = { requestId, op: "close_session", startedAt: Date.now() };
		let persistenceWarning: string | undefined;
		try {
			if (this.pendingDialogBrowser) {
				await this.closePendingDialogBrowser();
				persistenceWarning = "The latest state was not snapshotted because a JavaScript dialog was pending; the previous saved state was preserved.";
			}
			else if (sessionId && !previousOperation) {
				let browser: Browser | undefined;
				try { browser = await this.connectToBrowserSession(sessionId); }
				catch (error) { persistenceWarning = `Could not connect to save the latest browser state: ${String((error as Error)?.message ?? error).slice(0, 250)}`; }
				if (browser) {
					try { await withTimeout(this.persistState(browser), STATE_PERSIST_TIMEOUT_MS, "Saving browser state before close"); }
					catch (error) { persistenceWarning = `The last saved browser state was kept, but the latest state could not be saved: ${String((error as Error)?.message ?? error).slice(0, 250)}`; }
					finally { browser.disconnect(); }
				}
			} else if (sessionId && previousOperation) {
				persistenceWarning = `The latest state was not snapshotted because ${previousOperation.op} was still running; the previous saved state was preserved.`;
			}

			if (!sessionId) {
				const durationMs = Date.now() - requestStartedAt;
				return jsonResponse({ structuredContent: { closed: false, closeRequested: false, persistenceWarning, requestId, durationMs }, requestId, durationMs });
			}
			const close = await this.closeBrowserRunSession(sessionId);
			if (close.closed) {
				await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
				this.lastCdpCheck = undefined;
			} else {
				await this.ctx.storage.put("browserClosePending", { sessionId, requestId, startedAt: Date.now() } satisfies BrowserClosePending);
			}
			const durationMs = Date.now() - requestStartedAt;
			return jsonResponse({ structuredContent: { closed: close.closed, closeRequested: true, closeStatus: close.status, ...(persistenceWarning ? { persistenceWarning } : {}), ...(close.warning ? { closeWarning: close.warning } : {}), requestId, durationMs }, requestId, durationMs });
		} catch (error) {
			const value = error as { message?: string };
			return jsonResponse({ isError: true, requestId, code: "BROWSER_CLOSE_FAILED", message: value.message ?? String(error), durationMs: Date.now() - requestStartedAt });
		} finally {
			if (this.closeOperation?.requestId === requestId) this.closeOperation = undefined;
			if (this.closeBarrier === closeBarrier) {
				this.closeBarrier = undefined;
				if (this.lockEpoch === closeEpoch) releaseCloseBarrier();
			}
		}
	}

	private async clearSavedStateOutOfBand(requestId: string, requestStartedAt: number): Promise<Response> {
		try { if (this.closeBarrier) await withTimeout(this.closeBarrier, 45_000, "Waiting for the previous session close"); }
		catch (error) { return jsonResponse({ isError: true, requestId, code: "BROWSER_CLOSE_PENDING", message: String((error as Error)?.message ?? error), durationMs: Date.now() - requestStartedAt }); }
		const sessionId = await this.storedSessionId().catch(() => undefined) ?? this.pendingDialogSessionId;
		this.lockEpoch++;
		const clearEpoch = this.lockEpoch;
		let releaseClearBarrier!: () => void;
		const clearBarrier = new Promise<void>((resolve) => { releaseClearBarrier = resolve; });
		this.closeBarrier = clearBarrier;
		this.lock = clearBarrier;
		const releaseActive = this.activeRelease;
		this.activeRelease = undefined;
		releaseActive?.();
		this.activeOperation = undefined;
		this.activeOperationEpoch = undefined;
		this.closeOperation = { requestId, op: "clear_saved_state", startedAt: Date.now() };
		try {
			if (this.pendingDialogBrowser) await this.closePendingDialogBrowser();
			const close = sessionId ? await this.closeBrowserRunSession(sessionId) : { closed: false, status: "unknown" as const };
			await this.ctx.storage.delete(["browserStateRecord", "browserConnectionFailure"]);
			if (sessionId && !close.closed) {
				await this.ctx.storage.put("browserSessionId", sessionId);
				await this.ctx.storage.put("browserClosePending", { sessionId, requestId, startedAt: Date.now() } satisfies BrowserClosePending);
			} else {
				await this.ctx.storage.delete(["browserSessionId", "browserClosePending"]);
			}
			this.lastCdpCheck = undefined;
			const durationMs = Date.now() - requestStartedAt;
			return jsonResponse({ structuredContent: { cleared: true, browserClosed: close.closed, closeRequested: Boolean(sessionId), ...(close.warning ? { closeWarning: close.warning } : {}), requestId, durationMs }, requestId, durationMs });
		} catch (error) {
			const value = error as { message?: string };
			return jsonResponse({ isError: true, requestId, code: "BROWSER_CLEAR_FAILED", message: value.message ?? String(error), durationMs: Date.now() - requestStartedAt });
		} finally {
			if (this.closeOperation?.requestId === requestId) this.closeOperation = undefined;
			if (this.closeBarrier === clearBarrier) {
				this.closeBarrier = undefined;
				if (this.lockEpoch === clearEpoch) releaseClearBarrier();
			}
		}
	}

	private async recordCdpFailure(sessionId: string, requestId: string, op: string, code: string, message: string): Promise<void> {
		const failure: BrowserConnectionFailure = { sessionId, requestId, op, code, message: message.slice(0, 300), at: Date.now() };
		await this.ctx.storage.put("browserConnectionFailure", failure);
		this.lastCdpCheck = undefined;
	}

	private async clearCdpFailure(sessionId: string): Promise<void> {
		const failure = await this.ctx.storage.get<BrowserConnectionFailure>("browserConnectionFailure");
		if (failure?.sessionId === sessionId) await this.ctx.storage.delete("browserConnectionFailure");
		this.lastCdpCheck = { sessionId, status: "reachable", at: Date.now() };
	}

	private async forgetSavedTab(input: Record<string, unknown>): Promise<SessionResult> {
		const previousTabId = typeof input.previousTabId === "string" ? input.previousTabId.trim() : "";
		if (!previousTabId) throw Object.assign(new Error("previousTabId is required."), { code: "INVALID_INPUT" });

		const status = await browserStatus(this.env, await this.storedSessionId());
		if (status.active !== false) {
			throw Object.assign(new Error("Saved tabs can only be forgotten while the Browser Run session is inactive."), { code: status.active === true ? "BROWSER_SESSION_ACTIVE" : "BROWSER_SESSION_STATUS_UNKNOWN" });
		}

		const state = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
		if (!state?.tabs?.some((tab) => tab.tabId === previousTabId)) {
			throw Object.assign(new Error(`Saved tab ${previousTabId} was not found.`), { code: "SAVED_TAB_NOT_FOUND" });
		}
		const tabs = state.tabs.filter((tab) => tab.tabId !== previousTabId);
		await this.saveStateRecord({ ...state, tabs });
		return { structuredContent: { forgotten: true, previousTabId, remainingRestorableTabs: tabs.filter((tab) => /^https?:\/\//i.test(tab.url)).length, cookiesPreserved: true, localStoragePreserved: true } };
	}

	private async saveStateRecord(state: PersistedBrowserState): Promise<void> {
		state = {
			...state,
			tabs: state.tabs.map((tab) => ({ ...tab, viewport: tab.viewport ? normalizeViewport(tab.viewport) : null })),
		};
		let serialized = JSON.stringify(state);
		if (new TextEncoder().encode(serialized).byteLength > 1_500_000) {
			state = { ...state, localStorage: {}, tabs: state.tabs.slice(0, 15) };
			serialized = JSON.stringify(state);
		}
		if (new TextEncoder().encode(serialized).byteLength > 1_800_000) throw Object.assign(new Error("Browser state exceeds the 1.8 MB durable persistence limit; close tabs or clear oversized site data before continuing."), { code: "STATE_TOO_LARGE" });
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(serialized)));
		const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
		const saved = await this.ctx.storage.get<{ hash: string }>("browserStateRecord");
		if (saved?.hash === hash) return;
		await this.ctx.storage.put("browserStateRecord", { state, hash });
	}

	private async restoreState(browser: Browser): Promise<Array<{ previousTabId: string; tabId: string; url: string }>> {
		const state = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
		if (!state || state.version !== 1) {
			for (const page of await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Listing restored browser tabs")) if (page.url() === "about:blank") await page.close().catch(() => undefined);
			return [];
		}
		const pages = await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Listing tabs before browser restore");
		const anchor = pages[0] ?? await withTimeout(browser.newPage(), CDP_COMMAND_TIMEOUT_MS, "Opening browser restore tab");
		const urls = state.tabs.filter((tab) => /^https?:\/\//i.test(tab.url)).slice(0, 30);
		if (state.cookies.length) {
			const session = await anchor.createCDPSession();
			try { await (session as any).send("Network.setCookies", { cookies: state.cookies as any }, { timeout: CDP_COMMAND_TIMEOUT_MS }); }
			finally { await session.detach().catch(() => undefined); }
		}
		const restoreTargets: Array<{ page: Page; tab: PersistedBrowserTab }> = [];
		for (const [index, tabState] of urls.entries()) {
			const page = index === 0 ? anchor : await withTimeout(browser.newPage(), CDP_COMMAND_TIMEOUT_MS, "Opening restored browser tab");
			if (tabState.viewport) await applyViewport(page, {
				width: Number(tabState.viewport.width ?? 800),
				height: Number(tabState.viewport.height ?? 600),
				deviceScaleFactor: Number(tabState.viewport.deviceScaleFactor ?? 1),
				mobile: Boolean(tabState.viewport.mobile),
			});
			await page.evaluateOnNewDocument((origins: Record<string, Record<string, string>>) => {
				const values = origins[location.origin];
				if (!values) return;
				try { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); } catch { /* The page may disable storage. */ }
			}, state.localStorage);
			restoreTargets.push({ page, tab: tabState });
		}
		for (let offset = 0; offset < restoreTargets.length; offset += 5) {
			await Promise.all(restoreTargets.slice(offset, offset + 5).map(async ({ page, tab }) => {
				try { await page.goto(tab.url, { waitUntil: "domcontentloaded", timeout: 15_000 }); } catch { /* Keep the tab even when the site is temporarily unavailable. */ }
			}));
		}
		const mappings = restoreTargets.flatMap(({ page, tab }) => tab.tabId ? [{ previousTabId: tab.tabId, tabId: getTabId(page), url: tab.url }] : []);
		if (restoreTargets.length) {
			const restoredState: PersistedBrowserState = {
				...state,
				tabs: restoreTargets.map(({ page, tab }) => ({ tabId: getTabId(page), url: tab.url, viewport: tab.viewport ?? null })),
			};
			await this.saveStateRecord(restoredState);
		}
		const restoredPages = new Set(restoreTargets.map(({ page }) => page));
		for (const page of await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Listing tabs after browser restore")) if (!restoredPages.has(page) && page.url() === "about:blank") await page.close().catch(() => undefined);
		return mappings;
	}

	private async persistState(browser: Browser): Promise<void> {
		const pages = await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Listing browser pages for persistence");
		const anchor = pages[0] ?? await withTimeout(browser.newPage(), CDP_COMMAND_TIMEOUT_MS, "Opening persistence page");
		const temporaryAnchor = pages.length === 0;
		const previousState = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
		let cookies: Json[] = previousState?.cookies ?? [];
		try {
			const cookieSession = await withTimeout(anchor.createCDPSession(), CDP_COMMAND_TIMEOUT_MS, "Opening cookie persistence session");
			let result: { cookies?: Json[] };
			try {
				result = await (cookieSession as any).send("Network.getAllCookies", {}, { timeout: CDP_COMMAND_TIMEOUT_MS }) as { cookies?: Json[] };
			} finally {
				await cookieSession.detach().catch(() => undefined);
			}
			cookies = (result.cookies ?? []).slice(0, 3000).map((cookie) => {
				const { session, ...cookieParam } = cookie;
				if (session || Number(cookieParam.expires) < 0) delete cookieParam.expires;
				return cookieParam;
			});
		} catch (error) {
			console.warn("Browser state cookie snapshot skipped", { message: String((error as Error)?.message ?? error).slice(0, 300) });
		} finally {
			if (temporaryAnchor) await withTimeout(anchor.close(), CDP_COMMAND_TIMEOUT_MS, "Closing persistence page").catch(() => undefined);
		}
		const previousViewports = new Map((previousState?.tabs ?? []).filter((tab) => tab.tabId && tab.viewport).map((tab) => [tab.tabId!, tab.viewport!]));
		const localStorage: Record<string, Record<string, string>> = {};
		const failedOrigins = new Set<string>();
		const tabs: PersistedBrowserState["tabs"] = [];
		const pagesToPersist = pages.slice(0, 30);
		for (let offset = 0; offset < pagesToPersist.length; offset += 5) {
			const batch = pagesToPersist.slice(offset, offset + 5);
			const snapshots = await Promise.all(batch.map(async (page) => {
				const url = page.url();
				const tabId = getTabId(page);
				const viewport = previousViewports.get(tabId) ?? null;
				const values = await withTimeout(page.evaluate(() => {
					const result: Record<string, string> = {};
					try { for (let i = 0; i < Math.min(window.localStorage.length, 500); i++) { const key = window.localStorage.key(i); if (key) result[key] = String(window.localStorage.getItem(key) ?? "").slice(0, 10_000); } } catch { /* The page may disable storage. */ }
					return result;
				}), STATE_READ_TIMEOUT_MS, "Reading page localStorage").catch((error) => {
					console.warn("Browser state localStorage snapshot skipped", { tabId, message: String((error as Error)?.message ?? error).slice(0, 300) });
					return null;
				});
				return { tabId, url, viewport, values };
			}));
			for (const snapshot of snapshots) {
				if (/^https?:\/\//i.test(snapshot.url) || snapshot.viewport) tabs.push({ tabId: snapshot.tabId, url: snapshot.url, viewport: snapshot.viewport });
				if (/^https?:\/\//i.test(snapshot.url)) {
					const origin = new URL(snapshot.url).origin;
					if (snapshot.values) {
						localStorage[origin] = snapshot.values;
						failedOrigins.delete(origin);
					} else if (!localStorage[origin]) failedOrigins.add(origin);
				}
			}
		}
		for (const origin of failedOrigins) {
			const previousValues = previousState?.localStorage[origin];
			if (previousValues) localStorage[origin] = previousValues;
		}
		const state: PersistedBrowserState = { version: 1, cookies, localStorage, tabs };
		await this.saveStateRecord(state);
	}

	private async saveViewportOverride(page: Page, viewport: PersistedViewport): Promise<void> {
		const record = await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord");
		const state: PersistedBrowserState = record?.state ?? { version: 1, cookies: [], localStorage: {}, tabs: [] };
		const tabId = getTabId(page);
		const url = page.url();
		const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
		tabs.push({ tabId, url, viewport });
		await this.saveStateRecord({ ...state, tabs });
	}

	private async applySavedViewport(browser: Browser, tabId?: string): Promise<void> {
		const state = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
		if (!state?.tabs.length) return;
		const pages = await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Finding tab for saved viewport");
		const page = tabId ? pages.find((candidate) => getTabId(candidate) === tabId) : pages[0];
		if (!page) return;
		const saved = state.tabs.find((tab) => tab.tabId === getTabId(page))?.viewport;
		if (saved) await applyViewport(page, saved);
	}

	private async reconcileTabIds(browser: Browser): Promise<Array<{ previousTabId: string; tabId: string; url: string }>> {
		const record = await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord");
		const state = record?.state;
		if (!state?.tabs.length) return [];
		const pages = await withTimeout(browser.pages(), CDP_COMMAND_TIMEOUT_MS, "Reconciling restored browser tabs");
		const usedPages = new Set<Page>();
		const replacements = new Map<string, Page>();
		for (const saved of state.tabs) {
			if (!saved.tabId || !/^https?:\/\//i.test(saved.url)) continue;
			const exact = pages.find((page) => getTabId(page) === saved.tabId);
			if (exact) { usedPages.add(exact); continue; }
			const sameUrl = pages.find((page) => !usedPages.has(page) && page.url() === saved.url);
			if (sameUrl) { usedPages.add(sameUrl); replacements.set(saved.tabId, sameUrl); }
		}
		if (!replacements.size) return [];
		const mappings = [...replacements].map(([previousTabId, page]) => ({ previousTabId, tabId: getTabId(page), url: page.url() }));
		const tabs = state.tabs.map((tab) => {
			const replacement = tab.tabId ? replacements.get(tab.tabId) : undefined;
			return replacement ? { ...tab, tabId: getTabId(replacement), url: replacement.url() } : tab;
		});
		await this.saveStateRecord({ ...state, tabs });
		return mappings;
	}

	private async connectBrowser(allowLaunch: boolean, operationEpoch?: number): Promise<{ browser?: Browser; sessionId?: string; created: boolean; tabIdMappings?: Array<{ previousTabId: string; tabId: string; url: string }> }> {
		let sessionId = await this.storedSessionId();
		if (sessionId) {
			const pendingClose = await this.ctx.storage.get<BrowserClosePending>("browserClosePending");
			if (pendingClose?.sessionId === sessionId) {
				const close = await this.closeBrowserRunSession(sessionId);
				if (!close.closed) throw Object.assign(new Error(close.warning ?? "The Browser Run session is still closing; retry after it shuts down."), { code: "BROWSER_SESSION_CLOSING" });
				await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
				sessionId = undefined;
			}
		}
		if (sessionId) {
			let sessionActive: boolean | undefined;
			try {
				sessionActive = Boolean(await withTimeout(this.env.BROWSER.getSession(sessionId), BROWSER_API_TIMEOUT_MS, "Checking Browser Run session"));
			} catch (error) {
				console.warn("Browser Run session check failed", { message: String((error as Error)?.message ?? error).slice(0, 300) });
			}
			if (sessionActive === false) {
				console.info("Stored Browser Run session is no longer active", { op: allowLaunch ? "launch_allowed" : "read_only" });
				await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
				sessionId = undefined;
			} else {
				try {
					const browser = await this.connectToBrowserSession(sessionId);
					if (operationEpoch !== undefined && operationEpoch !== this.lockEpoch) { browser.disconnect(); throw Object.assign(new Error("This browser operation was canceled because the session was closed."), { code: "BROWSER_OPERATION_CANCELED" }); }
					await this.clearCdpFailure(sessionId);
					return { browser, sessionId, created: false };
				} catch (error) {
					if (operationEpoch !== undefined && operationEpoch !== this.lockEpoch) throw Object.assign(new Error("This browser operation was canceled because the session was closed."), { code: "BROWSER_OPERATION_CANCELED" });
					const message = String((error as Error)?.message ?? error).slice(0, 300);
					const requestId = this.activeOperation?.requestId ?? crypto.randomUUID();
					const failureCode = (error as { code?: string })?.code === "CDP_COMMAND_TIMEOUT" ? "CDP_COMMAND_TIMEOUT" : "BROWSER_CONNECTION_FAILED";
					await this.recordCdpFailure(sessionId, requestId, this.activeOperation?.op ?? "connect", failureCode, message).catch(() => undefined);
					console.warn("Browser Run reconnect failed", { requestId, timedOut: (error as { code?: string })?.code === "CDP_COMMAND_TIMEOUT", message });
					let sessionStillActive: boolean | undefined = sessionActive as boolean | undefined;
					if (sessionStillActive === undefined) {
						try { sessionStillActive = Boolean(await withTimeout(this.env.BROWSER.getSession(sessionId), BROWSER_API_TIMEOUT_MS, "Rechecking Browser Run session")); }
						catch { /* Keep the result unknown. */ }
					}
					if (sessionStillActive === false) {
						await this.ctx.storage.delete(["browserSessionId", "browserClosePending"]);
						sessionId = undefined;
					} else if (allowLaunch) {
						const close = await this.closeBrowserRunSession(sessionId);
						if (!close.closed) {
							await this.ctx.storage.put("browserClosePending", { sessionId, requestId, startedAt: Date.now() } satisfies BrowserClosePending);
							throw Object.assign(new Error(`The CDP connection failed and Cloudflare could not confirm session shutdown: ${close.warning ?? close.status}. Retry browser_resume after the session closes.`), { code: "BROWSER_CONNECTION_FAILED" });
						}
						await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
						sessionId = undefined;
					} else {
						throw Object.assign(new Error(sessionStillActive === true
							? "The Browser Run session exists, but its CDP connection failed or timed out. Call browser_resume to close the broken session and restore saved tabs."
							: "The Browser Run session could not be checked or reconnected. Retry the operation; its saved session state was preserved."), { code: "BROWSER_CONNECTION_FAILED" });
					}
				}
			}
		}
		if (!allowLaunch) return { created: false };
		const launched = await withTimeout(this.env.BROWSER.launch({ keepAlive: DEFAULT_KEEP_ALIVE_MS }), BROWSER_API_TIMEOUT_MS, "Launching Browser Run session");
		sessionId = launched.sessionId;
		if (operationEpoch !== undefined && operationEpoch !== this.lockEpoch) {
			const close = await this.closeBrowserRunSession(sessionId);
			if (!close.closed) {
				await this.ctx.storage.put("browserSessionId", sessionId);
				await this.ctx.storage.put("browserClosePending", { sessionId, requestId: this.activeOperation?.requestId ?? crypto.randomUUID(), startedAt: Date.now() } satisfies BrowserClosePending);
			}
			throw Object.assign(new Error("This browser operation was canceled because the session was closed."), { code: "BROWSER_OPERATION_CANCELED" });
		}
		let browser: Browser | undefined;
		let tabIdMappings: Array<{ previousTabId: string; tabId: string; url: string }> = [];
		try {
			await this.ctx.storage.put("browserSessionId", sessionId);
			browser = await withTimeout(puppeteer.connect(this.browserEndpoint(launched) as any, sessionId), CDP_CONNECT_TIMEOUT_MS, "Connecting to new Browser Run session");
			await this.clearCdpFailure(sessionId);
			tabIdMappings = await this.restoreState(browser);
			console.info("Browser session started", { tabIdMappingCount: tabIdMappings.length });
		} catch (error) {
			browser?.disconnect();
			const close = await this.closeBrowserRunSession(sessionId);
			if (close.closed) await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
			else {
				await this.ctx.storage.put("browserSessionId", sessionId);
				await this.ctx.storage.put("browserClosePending", { sessionId, requestId: this.activeOperation?.requestId ?? crypto.randomUUID(), startedAt: Date.now() } satisfies BrowserClosePending);
			}
			throw Object.assign(new Error(`Could not restore the saved browser state: ${(error as Error).message}`), { code: "RESTORE_FAILED" });
		}
		return { browser, sessionId, created: true, tabIdMappings };
	}

	private operationTimeoutMs(op: string, input: Json): number {
		const numberOr = (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback;
		if (["navigate", "new_tab", "back", "forward", "reload"].includes(op)) return Math.min(Math.max(numberOr(input.timeoutMs, 30_000), 1_000), 120_000) + 10_000;
		if (op === "wait") return Math.min(Math.max(numberOr(input.timeoutMs, 10_000), 1_000), 30_000) + 5_000;
		if (op === "evaluate") return Math.min(Math.max(numberOr(input.timeoutMs, 10_000), 1_000), 30_000) + 5_000;
		if (op === "sequence") return Math.min(Math.max(numberOr(input.maxDurationMs, MAX_SEQUENCE_MS), 1_000), MAX_SEQUENCE_MS) + 10_000;
		if (op === "network_requests" || op === "debug_capture") {
			const action = (input.action ?? {}) as Json;
			return Math.min(Math.max(numberOr(action.timeoutMs, 30_000), 1_000), 60_000) + Math.min(Math.max(numberOr(input.settleMs, 250), 0), 5_000) + 10_000;
		}
		if (op === "handoff") return Math.min(Math.max(numberOr(input.timeoutMs, 300_000), 1_000), 1_800_000) + 10_000;
		if (op === "fill_form") return Math.min(30_000 + (Array.isArray(input.fields) ? input.fields.length * 1_000 : 0), 120_000);
		return BROWSER_OPERATION_TIMEOUT_MS;
	}

	private async dispatch(request: SessionRequest, operationEpoch?: number): Promise<SessionResult> {
		const { op, input = {} } = request;
		const assertCurrentEpoch = () => {
			if (operationEpoch !== undefined && operationEpoch !== this.lockEpoch) throw Object.assign(new Error("This browser operation was canceled because the session was closed."), { code: "BROWSER_OPERATION_CANCELED" });
		};
		if (op === "status") {
			const sessionId = await this.storedSessionId();
			const status = await browserStatus(this.env, sessionId);
			const saved = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
			const failure = await this.ctx.storage.get<BrowserConnectionFailure>("browserConnectionFailure");
			const closePending = await this.ctx.storage.get<BrowserClosePending>("browserClosePending");
			const lastCheck = sessionId && this.lastCdpCheck?.sessionId === sessionId ? this.lastCdpCheck : undefined;
			const lastFailure = sessionId && failure?.sessionId === sessionId ? failure : undefined;
			return { structuredContent: {
				...status,
				cdpStatus: lastFailure ? "last_operation_failed" : lastCheck ? "last_operation_succeeded" : status.cdpStatus,
				...(lastFailure ? { lastCdpFailure: { requestId: lastFailure.requestId, op: lastFailure.op, code: lastFailure.code, message: lastFailure.message, at: lastFailure.at } } : {}),
				...(closePending ? { closePending: true, closeRequestId: closePending.requestId, closeElapsedMs: Date.now() - closePending.startedAt } : { closePending: false }),
				sessionOperation: this.closeOperation ? { requestId: this.closeOperation.requestId, op: this.closeOperation.op, elapsedMs: Date.now() - this.closeOperation.startedAt } : this.activeOperation ? { requestId: this.activeOperation.requestId, op: this.activeOperation.op, elapsedMs: Date.now() - this.activeOperation.startedAt } : null,
				queuedOperations: this.queuedOperations,
				restorableTabs: saved?.tabs.filter((tab) => /^https?:\/\//i.test(tab.url)).map((tab) => ({ previousTabId: tab.tabId, url: tab.url })) ?? [],
			} };
		}
		if (this.pendingDialogResolver && op !== "close_session" && op !== "clear_saved_state") {
			throw Object.assign(new Error("A JavaScript dialog is open. Call browser_handle_dialog before other browser operations."), { code: "JAVASCRIPT_DIALOG_OPEN", dialogPending: true });
		}
		if (op === "close_session") throw Object.assign(new Error("close_session must use the out-of-band close handler."), { code: "BROWSER_CLOSE_INTERNAL_ERROR" });
		const readOnlyOps = new Set(["list_tabs", "activate_tab", "page_info", "handoff_status"]);
		const allowLaunch = !readOnlyOps.has(op);
		assertCurrentEpoch();
		const connection = await this.connectBrowser(allowLaunch, operationEpoch);
		try { assertCurrentEpoch(); }
		catch (error) {
			connection.browser?.disconnect();
			if (connection.sessionId) {
				const close = await this.closeBrowserRunSession(connection.sessionId);
				if (close.closed) await this.ctx.storage.delete(["browserSessionId", "browserClosePending", "browserConnectionFailure"]);
				else {
					await this.ctx.storage.put("browserSessionId", connection.sessionId);
					await this.ctx.storage.put("browserClosePending", { sessionId: connection.sessionId, requestId: this.activeOperation?.requestId ?? crypto.randomUUID(), startedAt: Date.now() } satisfies BrowserClosePending);
				}
			}
			throw error;
		}
		if (!connection.browser) {
			const saved = (await this.ctx.storage.get<{ state: PersistedBrowserState }>("browserStateRecord"))?.state;
			return { structuredContent: { active: false, tabs: [], tabsKnown: true, restorableTabs: saved?.tabs.filter((tab) => /^https?:\/\//i.test(tab.url)).map((tab) => ({ previousTabId: tab.tabId, url: tab.url })) ?? [] }, content: [{ type: "text", text: saved?.tabs.length ? "Browser is idle; saved cookies and site storage will be restored when the next browser operation starts." : "Browser session has not started. Call browser_navigate or browser_new_tab to start one." }] };
		}
		const browser = connection.browser;
		if (!connection.created) {
			const liveMappings = await this.reconcileTabIds(browser);
			if (liveMappings.length) connection.tabIdMappings = [...(connection.tabIdMappings ?? []), ...liveMappings];
		}
		let operationInput = input;
		if (typeof input.tabId === "string") {
			const remapped = connection.tabIdMappings?.find((mapping) => mapping.previousTabId === input.tabId);
			if (remapped) operationInput = { ...input, tabId: remapped.tabId };
		}
		if (op !== "resume" && op !== "list_tabs" && op !== "new_tab" && op !== "close_tab") {
			await this.applySavedViewport(browser, typeof operationInput.tabId === "string" ? operationInput.tabId : undefined);
		}
		if (op === "resume") {
			try {
			const tabs = await listTabs(browser);
			assertCurrentEpoch();
			return { structuredContent: { active: true, restored: connection.created, tabs, ...(connection.tabIdMappings?.length ? { tabIdMappings: connection.tabIdMappings } : {}) } };
			}
			finally { browser.disconnect(); }
		}
		let result: SessionResult | undefined;
		let operationError: unknown;
		try {
			result = await withTimeout(this.runOperation(browser, op, operationInput), this.operationTimeoutMs(op, operationInput), `Browser ${op}`);
			assertCurrentEpoch();
			if (connection.tabIdMappings?.length && result.structuredContent) result.structuredContent = { ...result.structuredContent, tabIdMappings: connection.tabIdMappings };
		} catch (error) {
			operationError = error;
			if ((error as { code?: string })?.code === "CDP_COMMAND_TIMEOUT") browser.disconnect();
		} finally {
			if ((operationEpoch === undefined || operationEpoch === this.lockEpoch) && (operationError as { code?: string } | undefined)?.code !== "CDP_COMMAND_TIMEOUT" && MUTATING_OPS.has(op) && result?.structuredContent?.dialogPending !== true && !(operationError as Json | undefined)?.dialogPending) {
				try { await this.persistState(browser); }
				catch (error) {
					if (!operationError && result) result.structuredContent = { ...(result.structuredContent ?? {}), persistenceWarning: (error as Error).message };
					else if (operationError && typeof operationError === "object") (operationError as Json).persistenceWarning = (error as Error).message;
				}
			}
			const operationHasDialog = result?.structuredContent?.dialogPending === true || Boolean((operationError as Json | undefined)?.dialogPending);
			if (operationHasDialog && this.pendingDialogResolver && connection.sessionId) {
				this.pendingDialogBrowser = browser;
				this.pendingDialogSessionId = connection.sessionId;
			} else browser.disconnect();
		}
		if (operationError) {
			if (connection.tabIdMappings?.length && operationError && typeof operationError === "object") (operationError as Json).tabIdMappings = connection.tabIdMappings;
			throw operationError;
		}
		return result!;
	}

	private async runOperation(browser: Browser, op: string, input: Json): Promise<SessionResult> {
		if (op === "list_tabs") return { structuredContent: { tabs: await listTabs(browser) } };
		if (op === "activate_tab") {
			const page = await pickPage(browser, String(input.tabId ?? ""));
			await page.bringToFront();
			return { structuredContent: { active: true, page: await pageSummary(page) } };
		}
		if (op === "new_tab") {
			const page = await browser.newPage();
			if (typeof input.url === "string" && input.url) await page.goto(input.url, { waitUntil: input.waitUntil ?? "domcontentloaded", timeout: Number(input.timeoutMs ?? 30_000) });
			return { structuredContent: { tab: await pageSummary(page), tabs: await listTabs(browser) } };
		}
		if (op === "close_tab") {
			const page = await pickPage(browser, String(input.tabId ?? ""));
			const tabId = getTabId(page);
			const wasLastRealTab = page.url() !== "about:blank" && (await browser.pages()).filter((candidate) => candidate.url() !== "about:blank").length === 1;
			await page.close();
			if (wasLastRealTab) for (const remaining of await browser.pages()) if (remaining.url() === "about:blank") await remaining.close().catch(() => undefined);
			return { structuredContent: { closed: true, tabId, tabs: await listTabs(browser) } };
		}
		const page = await pickPage(browser, input.tabId ? String(input.tabId) : undefined, true);
		if (op === "page_info") return { structuredContent: await pageSummary(page) };
		if (op === "navigate") {
			const response = await page.goto(String(input.url), { waitUntil: input.waitUntil ?? "domcontentloaded", timeout: Number(input.timeoutMs ?? 30_000) });
			return { structuredContent: { page: await pageSummary(page), status: response?.status() ?? null, responseUrl: response?.url() ?? null } };
		}
		if (op === "back" || op === "forward") {
			const response = op === "back" ? await page.goBack({ waitUntil: input.waitUntil ?? "domcontentloaded", timeout: Number(input.timeoutMs ?? 30_000) }) : await page.goForward({ waitUntil: input.waitUntil ?? "domcontentloaded", timeout: Number(input.timeoutMs ?? 30_000) });
			return { structuredContent: { page: await pageSummary(page), status: response?.status() ?? null } };
		}
		if (op === "reload") {
			const response = await page.reload({ waitUntil: input.waitUntil ?? "domcontentloaded", timeout: Number(input.timeoutMs ?? 30_000) });
			return { structuredContent: { page: await pageSummary(page), status: response?.status() ?? null } };
		}
		if (op === "wait") {
			if (input.selector) await page.waitForSelector(String(input.selector), { timeout: Number(input.timeoutMs ?? 10_000), visible: input.visible !== false });
			else if (input.text) await page.waitForFunction((needle) => document.body?.innerText.includes(needle), { timeout: Number(input.timeoutMs ?? 10_000) }, String(input.text));
			else await new Promise((resolve) => setTimeout(resolve, Math.min(Number(input.timeoutMs ?? 1000), 30_000)));
			return { structuredContent: { page: await pageSummary(page) } };
		}
		if (op === "snapshot") return { structuredContent: await snapshot(page, input) };
		if (op === "find") {
			const result = await snapshot(page, { maxNodes: 1000, maxChars: 500 });
			const exact = input.exact !== false;
			const nodes = (result.nodes as Json[]).filter((node) => {
				const roleMatch = !input.role || node.role === input.role;
				const query = String(input.query ?? input.name ?? "").toLocaleLowerCase();
				const name = String(node.name ?? "").toLocaleLowerCase();
				return roleMatch && (!query || (exact ? name === query : name.includes(query)));
			}).slice(0, Math.min(Number(input.limit ?? 50), 100));
			return { structuredContent: { tabId: result.tabId, url: result.url, snapshotId: result.snapshotId, matches: nodes } };
		}
		if (op === "screenshot") {
			const options: Json = { type: input.type === "jpeg" ? "jpeg" : "png", fullPage: Boolean(input.fullPage) };
			if (input.quality != null) options.quality = Math.min(Math.max(Number(input.quality), 1), 100);
			if (input.clip && typeof input.clip === "object") options.clip = input.clip;
			const shot = await page.screenshot(options) as unknown as Uint8Array;
			if (shot.byteLength > 5_000_000) throw Object.assign(new Error("Screenshot exceeds the 5 MB MCP image limit. Use a smaller viewport, a clip rectangle, or JPEG."), { code: "OUTPUT_TOO_LARGE" });
			const data = bytesToBase64(shot);
			const mimeType = options.type === "jpeg" ? "image/jpeg" : "image/png";
			return { content: [{ type: "text", text: JSON.stringify({ tabId: getTabId(page), url: page.url(), mimeType }) }, { type: "image", data, mimeType }], structuredContent: { tabId: getTabId(page), url: page.url(), mimeType } };
		}
		if (op === "evaluate") {
			const evaluation = await evaluatePageWithDialog(page, String(input.expression), Number(input.timeoutMs ?? 10_000));
			if (evaluation.dialogPending) {
				if (evaluation.session) this.holdDialogSession(page, evaluation.session);
				const prompt = "A JavaScript dialog is open. Call browser_handle_dialog to accept or dismiss it.";
				return { structuredContent: { dialogPending: true, dialog: evaluation.dialog, page: { tabId: getTabId(page), url: page.url() } }, content: [{ type: "text", text: prompt }] };
			}
			const value = evaluation.result;
			const serialized = JSON.stringify(value ?? null);
			const truncated = serialized.length > MAX_TEXT;
			const bounded = truncated ? serialized.slice(0, MAX_TEXT) : value ?? null;
			return { structuredContent: { result: bounded, truncated, page: await pageSummary(page) }, content: [{ type: "text", text: safeText(value ?? null) }] };
		}
		if (op === "viewport") {
			const viewport: PersistedViewport = {
				width: Number(input.width),
				height: Number(input.height),
				deviceScaleFactor: Number(input.deviceScaleFactor ?? 1),
				mobile: Boolean(input.mobile),
			};
			await applyViewport(page, viewport);
			await this.saveViewportOverride(page, viewport);
			return { structuredContent: { viewport, page: await pageSummary(page) } };
		}
		if (op === "mouse") {
			const session = await page.createCDPSession();
			let keepSessionOpen = false;
			let dialogInfo: DialogInfo | undefined;
			let resolveDialog!: (value: DialogInfo) => void;
			const dialogOpened = new Promise<DialogInfo>((resolve) => { resolveDialog = resolve; });
			const onDialog = (event: { type?: string; message?: string; defaultPrompt?: string }) => {
				dialogInfo = { type: String(event.type ?? "unknown"), message: String(event.message ?? ""), ...(event.defaultPrompt ? { defaultPrompt: String(event.defaultPrompt) } : {}) };
				resolveDialog(dialogInfo);
			};
			session.on("Page.javascriptDialogOpening", onDialog);
			try {
				await session.send("Page.enable");
				const action = String(input.action ?? "move");
				const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => ({ width: 1280, height: 720 }));
				const x = Number(input.x ?? Math.floor(dimensions.width / 2)), y = Number(input.y ?? Math.floor(dimensions.height / 2));
				if (![x, y].every(Number.isFinite)) throw Object.assign(new Error("Mouse coordinates must be finite numbers."), { code: "INVALID_INPUT" });
				const dispatchStartedAt = Date.now();
				if (action === "click") {
					await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
					await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: input.button ?? "left", clickCount: Number(input.clickCount ?? 1) });
					await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: input.button ?? "left", clickCount: Number(input.clickCount ?? 1) });
				} else if (action === "move") await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
				else if (action === "down" || action === "up") await session.send("Input.dispatchMouseEvent", { type: action === "down" ? "mousePressed" : "mouseReleased", x, y, button: input.button ?? "left" });
				else if (action === "wheel") await session.send("Input.dispatchMouseEvent", { type: "mouseWheel", x, y, deltaX: Number(input.deltaX ?? 0), deltaY: Number(input.deltaY ?? 0) });
				else if (action === "drag") {
					const endX = Number(input.endX), endY = Number(input.endY);
					if (![endX, endY].every(Number.isFinite)) throw Object.assign(new Error("Drag needs finite endX and endY."), { code: "INVALID_INPUT" });
					await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
					await session.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1 });
					for (let step = 1; step <= 6; step++) await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + (endX - x) * step / 6, y: y + (endY - y) * step / 6, button: "left", buttons: 1 });
					await session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: endX, y: endY, button: "left" });
				} else throw Object.assign(new Error(`Unknown mouse action: ${action}`), { code: "INVALID_ACTION" });
				const inputDispatchMs = Date.now() - dispatchStartedAt;
				const settleStartedAt = Date.now();
				await Promise.race([delay(action === "click" ? 250 : 50), dialogOpened]);
				const timings: Json = { inputDispatchMs, settleMs: Date.now() - settleStartedAt };
				if (dialogInfo) {
					this.holdDialogSession(page, session); keepSessionOpen = true;
					return { structuredContent: { action, x, y, dialog: dialogInfo, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
				}
				const metadataStartedAt = Date.now();
				const metadata = pageSummary(page).then((value) => ({ kind: "metadata" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
				const outcome = await Promise.race([metadata, dialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
				timings.metadataMs = Date.now() - metadataStartedAt;
				if (outcome.kind === "dialog") {
					this.holdDialogSession(page, session); keepSessionOpen = true;
					return { structuredContent: { action, x, y, dialog: outcome.dialog, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
				}
				if (outcome.kind === "error") throw outcome.error;
				return { structuredContent: { action, x, y, page: outcome.value, timings } };
			} finally {
				session.off("Page.javascriptDialogOpening", onDialog);
				if (!keepSessionOpen) await session.detach().catch(() => undefined);
			}
		}
		if (op === "keyboard") {
			const session = await page.createCDPSession();
			let keepSessionOpen = false;
			let dialogInfo: DialogInfo | undefined;
			let resolveDialog!: (value: DialogInfo) => void;
			const dialogOpened = new Promise<DialogInfo>((resolve) => { resolveDialog = resolve; });
			const onDialog = (event: { type?: string; message?: string; defaultPrompt?: string }) => {
				dialogInfo = { type: String(event.type ?? "unknown"), message: String(event.message ?? ""), ...(event.defaultPrompt ? { defaultPrompt: String(event.defaultPrompt) } : {}) };
				resolveDialog(dialogInfo);
			};
			session.on("Page.javascriptDialogOpening", onDialog);
			try {
				await session.send("Page.enable");
				const action = String(input.action ?? "press");
				const dispatchStartedAt = Date.now();
				if (action === "type") await session.send("Input.insertText", { text: String(input.text ?? "") });
				else {
					const key = String(input.key ?? "Enter");
					const modifierMap: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Shift: 8 };
					const modifiers = (Array.isArray(input.modifiers) ? input.modifiers : []).reduce((bits: number, name: unknown) => bits | (modifierMap[String(name)] ?? 0), 0);
					if (!["press", "down", "up"].includes(action)) throw Object.assign(new Error(`Unknown keyboard action: ${action}`), { code: "INVALID_ACTION" });
					const eventType = action === "down" ? "keyDown" : action === "up" ? "keyUp" : "keyDown";
					const code = String(input.code ?? keyCode(key));
					const vkey = virtualKeyCode(key);
					await session.send("Input.dispatchKeyEvent", { type: eventType, key, code, modifiers, ...(input.text ? { text: String(input.text) } : {}), ...(vkey !== undefined ? { windowsVirtualKeyCode: vkey } : {}) });
					if (action === "press") await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers, ...(vkey !== undefined ? { windowsVirtualKeyCode: vkey } : {}) });
				}
				const inputDispatchMs = Date.now() - dispatchStartedAt;
				const settleStartedAt = Date.now();
				await Promise.race([delay(150), dialogOpened]);
				const timings: Json = { inputDispatchMs, settleMs: Date.now() - settleStartedAt };
				if (dialogInfo) {
					this.holdDialogSession(page, session); keepSessionOpen = true;
					return { structuredContent: { action, dialog: dialogInfo, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
				}
				const metadataStartedAt = Date.now();
				const metadata = pageSummary(page).then((value) => ({ kind: "metadata" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
				const outcome = await Promise.race([metadata, dialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
				timings.metadataMs = Date.now() - metadataStartedAt;
				if (outcome.kind === "dialog") {
					this.holdDialogSession(page, session); keepSessionOpen = true;
					return { structuredContent: { action, dialog: outcome.dialog, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
				}
				if (outcome.kind === "error") throw outcome.error;
				return { structuredContent: { action, page: outcome.value, timings } };
			} finally {
				session.off("Page.javascriptDialogOpening", onDialog);
				if (!keepSessionOpen) await session.detach().catch(() => undefined);
			}
		}
		if (op === "handle_dialog") {
			const session = await page.createCDPSession();
			try { await session.send("Page.handleJavaScriptDialog", { accept: Boolean(input.accept), ...(input.promptText ? { promptText: String(input.promptText) } : {}) }); return { structuredContent: { handled: true, page: await pageSummary(page) } }; }
			finally { await session.detach().catch(() => undefined); }
		}
		if (op === "action") return this.performAction(page, input);
		if (op === "fill_form") return this.fillForm(page, input);
		if (op === "cdp") {
			const method = String(input.method ?? "");
			if (!/^[A-Z][A-Za-z0-9]+\.[A-Za-z][A-Za-z0-9]+$/.test(method)) throw Object.assign(new Error("CDP method must use Domain.command syntax."), { code: "INVALID_CDP_METHOD" });
			const session = input.scope === "browser" ? await browser.target().createCDPSession() : await page.createCDPSession();
			try {
				const result = await (session as any).send(method, (input.params ?? {}) as any);
				const serialized = JSON.stringify(result ?? null);
				const truncated = new TextEncoder().encode(serialized).byteLength > MAX_CDP_BYTES;
				const text = truncated ? `${serialized.slice(0, MAX_CDP_BYTES)}\n… CDP output truncated` : serialized;
				return { structuredContent: truncated ? { resultPreview: serialized.slice(0, MAX_CDP_BYTES), truncated: true, scope: input.scope === "browser" ? "browser" : "page", tabId: getTabId(page) } : { result: result ?? null, scope: input.scope === "browser" ? "browser" : "page", tabId: getTabId(page) }, content: [{ type: "text", text }] };
			} finally { await session.detach().catch(() => undefined); }
		}
		if (op === "network_requests" || op === "debug_capture") return this.captureDuringAction(page, input, op === "debug_capture");
		if (op === "sequence") return this.sequence(browser, page, input);
		if (op === "live_view" || op === "handoff" || op === "handoff_status" || op === "handoff_complete") return this.handoff(browser, page, op, input);
		throw Object.assign(new Error(`Unknown browser operation: ${op}`), { code: "UNKNOWN_OPERATION" });
	}

	private async performAction(page: Page, input: Json): Promise<SessionResult> {
		const action = String(input.action ?? "");
		const session = await page.createCDPSession();
		let keepSessionOpen = false;
		let dialogInfo: DialogInfo | undefined;
		let resolveDialog!: (value: DialogInfo) => void;
		const dialogOpened = new Promise<DialogInfo>((resolve) => { resolveDialog = resolve; });
		const onDialog = (event: { type?: string; message?: string; defaultPrompt?: string }) => {
			dialogInfo = { type: String(event.type ?? "unknown"), message: String(event.message ?? ""), ...(event.defaultPrompt ? { defaultPrompt: String(event.defaultPrompt) } : {}) };
			resolveDialog(dialogInfo);
		};
		session.on("Page.javascriptDialogOpening", onDialog);
		try {
			await session.send("Page.enable");
			const sendInput = (method: string, params: Json) => (session as any).send(method, params, { timeout: 5_000 });
			const targetStartedAt = Date.now();
			const target = await elementByTarget(page, input, session);
			const targetResolutionMs = Date.now() - targetStartedAt;
			let result: unknown;
			const dispatchStartedAt = Date.now();
			try {
			if (action === "click" || action === "hover") {
				const center = await elementCenter(session, target.backendDOMNodeId);
				if (action === "click") {
					await sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", ...center });
					await sendInput("Input.dispatchMouseEvent", { type: "mousePressed", ...center, button: input.button ?? "left", clickCount: Number(input.clickCount ?? 1) });
					await sendInput("Input.dispatchMouseEvent", { type: "mouseReleased", ...center, button: input.button ?? "left", clickCount: Number(input.clickCount ?? 1) });
				} else await sendInput("Input.dispatchMouseEvent", { type: "mouseMoved", ...center });
			} else if (action === "fill") {
				result = await callElement(session, target.objectId, `function(value){const e=this;const proto=e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:e instanceof HTMLInputElement?HTMLInputElement.prototype:null;const setter=proto&&Object.getOwnPropertyDescriptor(proto,'value')?.set;if(setter)setter.call(e,value);else if(e.isContentEditable)e.textContent=value;else throw new Error('Target is not an editable field');e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));e.dispatchEvent(new Event('change',{bubbles:true}));return {tag:e.tagName,value:e.value??e.textContent};}`, [String(input.value ?? "")]);
			} else if (action === "type") {
				await callElement(session, target.objectId, "function(){this.focus();}");
				await sendInput("Input.insertText", { text: String(input.text ?? "") });
			} else if (action === "press_key") {
				await callElement(session, target.objectId, "function(){this.focus();}");
				const key = String(input.key ?? "Enter");
				await sendInput("Input.dispatchKeyEvent", { type: "keyDown", key, code: keyCode(key), windowsVirtualKeyCode: virtualKeyCode(key) });
				if (key.length === 1) await sendInput("Input.dispatchKeyEvent", { type: "char", text: key, key });
				await sendInput("Input.dispatchKeyEvent", { type: "keyUp", key, code: keyCode(key), windowsVirtualKeyCode: virtualKeyCode(key) });
			} else if (action === "select_option") {
				result = await callElement(session, target.objectId, `function(value){if(!(this instanceof HTMLSelectElement))throw new Error('Target is not a select');const values=Array.isArray(value)?value.map(String):[String(value)];for(const option of this.options)option.selected=values.includes(option.value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {value:this.value,selected:[...this.selectedOptions].map(o=>({value:o.value,text:o.text}))};}`, [input.value]);
			} else if (action === "check" || action === "uncheck") {
				result = await callElement(session, target.objectId, `function(checked){if(!(this instanceof HTMLInputElement)||!['checkbox','radio'].includes(this.type))throw new Error('Target is not a checkbox or radio');this.checked=checked;this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return {checked:this.checked};}`, [action === "check"]);
			} else if (action === "focus") await callElement(session, target.objectId, "function(){this.focus();}");
			else if (action === "scroll_into_view") await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: target.backendDOMNodeId });
			else throw Object.assign(new Error(`Unsupported action: ${action}`), { code: "INVALID_ACTION" });
			} catch (error) {
				const value = error as { dialogPending?: boolean; dialog?: DialogInfo };
				if (!dialogInfo && !value.dialogPending) throw error;
				dialogInfo ??= value.dialog;
				this.holdDialogSession(page, session); keepSessionOpen = true;
				return { structuredContent: { action, result, dialog: dialogInfo, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings: { targetResolutionMs, inputDispatchMs: Date.now() - dispatchStartedAt } } };
			}
			const inputDispatchMs = Date.now() - dispatchStartedAt;
			const requestedSettleMs = Math.max(Number(input.afterMs ?? 100), action === "click" ? 250 : 0);
			const settleStartedAt = Date.now();
			await Promise.race([delay(requestedSettleMs), dialogOpened]);
			const settleMs = Date.now() - settleStartedAt;
			const timings: Json = { targetResolutionMs, inputDispatchMs, settleMs };
			if (dialogInfo) {
				this.holdDialogSession(page, session); keepSessionOpen = true;
				return { structuredContent: { action, result, dialog: dialogInfo, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
			}
			const metadataStartedAt = Date.now();
			const metadata = (async () => ({ page: await pageSummary(page), snapshot: input.includeSnapshot ? await snapshot(page, {}) : undefined }))()
				.then((value) => ({ kind: "metadata" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
			const metadataOutcome = await Promise.race([metadata, dialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
			timings.metadataMs = Date.now() - metadataStartedAt;
			if (metadataOutcome.kind === "dialog") {
				this.holdDialogSession(page, session); keepSessionOpen = true;
				return { structuredContent: { action, result, dialog: metadataOutcome.dialog, dialogPending: true, page: { tabId: getTabId(page), url: page.url() }, timings } };
			}
			if (metadataOutcome.kind === "error") throw metadataOutcome.error;
			return { structuredContent: { action, result, ...metadataOutcome.value, timings } };
		} finally {
			session.off("Page.javascriptDialogOpening", onDialog);
			if (!keepSessionOpen) await session.detach().catch(() => undefined);
		}
	}

	private async fillForm(page: Page, input: Json): Promise<SessionResult> {
		if (!Array.isArray(input.fields) || input.fields.length > 100) throw Object.assign(new Error("fields must contain at most 100 field definitions."), { code: "INVALID_INPUT" });
		const session = await page.createCDPSession();
		try {
			await session.send("Page.enable");
			const resolved = [];
			for (const field of input.fields) resolved.push({ field, target: await elementByTarget(page, field, session) });
			const results = [];
			for (const { field, target } of resolved) {
				const op = field.action === "select_option" ? "select_option" : field.action === "check" ? "check" : field.action === "uncheck" ? "uncheck" : "fill";
				let result: unknown;
				if (op === "select_option") result = await callElement(session, target.objectId, `function(value){if(!(this instanceof HTMLSelectElement))throw new Error('Target is not a select');const values=Array.isArray(value)?value.map(String):[String(value)];for(const option of this.options)option.selected=values.includes(option.value);this.dispatchEvent(new Event('input',{bubbles:true}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value;}`, [field.value]);
				else if (op === "check" || op === "uncheck") result = await callElement(session, target.objectId, "function(value){if(!(this instanceof HTMLInputElement))throw new Error('Target is not an input');this.checked=value;this.dispatchEvent(new Event('change',{bubbles:true}));return this.checked;}", [op === "check"]);
				else result = await callElement(session, target.objectId, `function(value){const p=this instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:this instanceof HTMLInputElement?HTMLInputElement.prototype:null;const s=p&&Object.getOwnPropertyDescriptor(p,'value')?.set;if(s)s.call(this,value);else if(this.isContentEditable)this.textContent=value;else throw new Error('Target is not editable');this.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:value}));this.dispatchEvent(new Event('change',{bubbles:true}));return this.value??this.textContent;}`, [String(field.value ?? "")]);
				results.push({ result });
			}
			return { structuredContent: { count: results.length, results, page: await pageSummary(page) } };
		} finally { await session.detach().catch(() => undefined); }
	}

	private async captureDuringAction(page: Page, input: Json, debug: boolean): Promise<SessionResult> {
		const requests: Json[] = [];
		const consoles: Json[] = [];
		const errors: Json[] = [];
		const filters = (input.filters ?? {}) as Json;
		const resourceTypes = Array.isArray(filters.resourceTypes) ? new Set(filters.resourceTypes.map((value: unknown) => String(value).toLowerCase())) : undefined;
		const urlContains = String(filters.urlContains ?? "");
		const includeHeaders = filters.includeHeaders !== false;
		const maxRequests = Math.min(Math.max(Number(filters.maxRequests ?? 100), 1), 500);
		let droppedRequests = 0;
		const requestsByUrl = new Map<any, Json>();
		const onRequest = (request: any) => {
			if ((resourceTypes && !resourceTypes.has(request.resourceType().toLowerCase())) || (urlContains && !request.url().includes(urlContains))) return;
			if (requests.length >= maxRequests) { droppedRequests++; return; }
			const item: Json = { url: request.url(), method: request.method(), resourceType: request.resourceType() };
			if (includeHeaders) item.requestHeaders = safeHeaders(request.headers());
			requests.push(item);
			requestsByUrl.set(request, item);
		};
		const onResponse = (response: any) => {
			const item = requestsByUrl.get(response.request());
			if (item) Object.assign(item, { status: response.status(), ...(includeHeaders ? { responseHeaders: safeHeaders(response.headers()) } : {}), fromCache: response.fromCache() });
		};
		const onRequestFailed = (request: any) => { const item = requestsByUrl.get(request); if (item) item.failure = request.failure()?.errorText ?? "Request failed"; };
		const onConsole = (message: any) => consoles.push({ type: message.type(), text: message.text().slice(0, 4000), location: message.location() });
		const onPageError = (error: Error) => errors.push({ message: error.message.slice(0, 4000) });
		page.on("request", onRequest); page.on("response", onResponse); page.on("requestfailed", onRequestFailed);
		if (debug) { page.on("console", onConsole); page.on("pageerror", onPageError); }
		try {
			const action = input.action as Json | undefined;
			if (!action) throw Object.assign(new Error("Provide one bounded action to capture, such as {type:'navigate', url} or {type:'reload'}."), { code: "INVALID_INPUT" });
			if (action.type === "navigate") await page.goto(String(action.url), { waitUntil: action.waitUntil ?? "domcontentloaded", timeout: Number(action.timeoutMs ?? 30_000) });
			else if (action.type === "reload") await page.reload({ waitUntil: action.waitUntil ?? "domcontentloaded", timeout: Number(action.timeoutMs ?? 30_000) });
			else if (action.type === "click") {
				const outcome = await this.performAction(page, { ...action, action: "click" });
				if (outcome.structuredContent?.dialogPending) return { structuredContent: { ...outcome.structuredContent, requests, droppedRequests } };
			}
			else if (action.type === "evaluate") {
				const outcome = await evaluatePageWithDialog(page, String(action.expression), Number(action.timeoutMs ?? 10_000));
				if (outcome.dialogPending) {
					if (outcome.session) this.holdDialogSession(page, outcome.session);
					return { structuredContent: { dialogPending: true, dialog: outcome.dialog, page: { tabId: getTabId(page), url: page.url() }, requests, droppedRequests } };
				}
			}
			else throw Object.assign(new Error("Capture supports navigate, reload, click, or evaluate actions."), { code: "INVALID_ACTION" });
			await delay(Math.min(Number(input.settleMs ?? 250), 5000));
			return { structuredContent: { page: await pageSummary(page), requests, requestCount: requests.length, droppedRequests, ...(debug ? { console: consoles.slice(0, 200), errors: errors.slice(0, 100) } : {}) } };
		} finally {
			page.off("request", onRequest); page.off("response", onResponse); page.off("requestfailed", onRequestFailed);
			if (debug) { page.off("console", onConsole); page.off("pageerror", onPageError); }
		}
	}

	private async sequence(browser: Browser, initialPage: Page, input: Json): Promise<SessionResult> {
		if (!Array.isArray(input.steps) || input.steps.length < 1 || input.steps.length > MAX_SEQUENCE_STEPS) throw Object.assign(new Error(`steps must contain 1 to ${MAX_SEQUENCE_STEPS} operations.`), { code: "INVALID_INPUT" });
		const maxMs = Math.min(Math.max(Number(input.maxDurationMs ?? MAX_SEQUENCE_MS), 1000), MAX_SEQUENCE_MS);
		const deadline = Date.now() + maxMs;
		const outcomes: Json[] = [];
		let outputChars = 0;
		let dialogPending = false;
		let pendingDialog: DialogInfo | undefined;
		let resolveSequenceDialog!: (value: DialogInfo) => void;
		const sequenceDialogOpened = new Promise<DialogInfo>((resolve) => { resolveSequenceDialog = resolve; });
		const watchedPages: Page[] = [];
		const pageDialogHandlers = new Map<Page, (dialog: any) => void>();
		const onPageDialog = (candidate: Page, dialog: any) => {
			pendingDialog = { type: String(dialog.type()), message: String(dialog.message()), ...(dialog.defaultValue() ? { defaultPrompt: String(dialog.defaultValue()) } : {}) };
			this.holdPuppeteerDialog(candidate, dialog);
			resolveSequenceDialog(pendingDialog);
		};
		const watchPage = (candidate: Page) => {
			const handler = (dialog: any) => onPageDialog(candidate, dialog);
			pageDialogHandlers.set(candidate, handler);
			candidate.on("dialog", handler);
			watchedPages.push(candidate);
		};
		const boundedResult = (value: unknown) => {
			const serialized = JSON.stringify(value ?? null);
			const remaining = Math.max(0, 80_000 - outputChars);
			const limit = Math.min(20_000, remaining);
			if (serialized.length > limit) {
				outputChars += limit;
				return { resultPreview: serialized.slice(0, limit), truncated: true };
			}
			outputChars += serialized.length;
			return value ?? null;
		};
		let page = initialPage;
		watchPage(page);
		for (const [index, step] of input.steps.entries()) {
			if (Date.now() > deadline) { outcomes.push({ index, error: { code: "SEQUENCE_TIMEOUT", message: "Sequence duration limit reached." } }); break; }
			try {
				let stepResult: unknown;
				if (step.type === "navigate") {
					const response = await page.goto(String(step.url), { waitUntil: step.waitUntil ?? "domcontentloaded", timeout: Math.min(Number(step.timeoutMs ?? 20_000), deadline - Date.now()) });
					stepResult = { status: response?.status() ?? null, responseUrl: response?.url() ?? null };
				} else if (step.type === "reload") {
					const response = await page.reload({ waitUntil: step.waitUntil ?? "domcontentloaded", timeout: Math.min(Number(step.timeoutMs ?? 20_000), deadline - Date.now()) });
					stepResult = { status: response?.status() ?? null };
				} else if (step.type === "back" || step.type === "forward") {
					const response = step.type === "back"
						? await page.goBack({ waitUntil: "domcontentloaded", timeout: Math.min(Number(step.timeoutMs ?? 20_000), deadline - Date.now()) })
						: await page.goForward({ waitUntil: "domcontentloaded", timeout: Math.min(Number(step.timeoutMs ?? 20_000), deadline - Date.now()) });
					stepResult = { status: response?.status() ?? null, url: page.url() };
				} else if (step.type === "wait") {
					const waitedMs = Math.min(Number(step.ms ?? 250), Math.max(deadline - Date.now(), 0));
					await new Promise((resolve) => setTimeout(resolve, waitedMs));
					stepResult = { waitedMs };
				} else if (step.type === "action") {
					const actionResult = await this.performAction(page, step);
					stepResult = actionResult.structuredContent ?? actionResult;
					if (actionResult.structuredContent?.dialogPending) {
						outcomes.push({ index, ok: true, result: boundedResult(stepResult), dialogPending: true, page: { tabId: getTabId(page), url: page.url() } });
						dialogPending = true;
						break;
					}
				} else if (step.type === "evaluate") {
					const evaluation = await evaluatePageWithDialog(page, String(step.expression), Math.min(Number(step.timeoutMs ?? 10_000), Math.max(deadline - Date.now(), 1)));
					if (evaluation.dialogPending) {
						if (evaluation.session) this.holdDialogSession(page, evaluation.session);
						stepResult = { dialogPending: true, dialog: evaluation.dialog };
						outcomes.push({ index, ok: true, result: boundedResult(stepResult), dialogPending: true, page: { tabId: getTabId(page), url: page.url() } });
						dialogPending = true;
						break;
					}
					stepResult = { result: evaluation.result };
				} else if (step.type === "new_tab") {
					page = await browser.newPage();
					watchPage(page);
					if (typeof step.url === "string" && step.url) await page.goto(step.url, { waitUntil: step.waitUntil ?? "domcontentloaded", timeout: Math.min(Number(step.timeoutMs ?? 20_000), deadline - Date.now()) });
					stepResult = { created: true, url: page.url(), tabId: getTabId(page) };
				}
				else throw Object.assign(new Error(`Unsupported sequence step type: ${step.type}`), { code: "INVALID_SEQUENCE_STEP" });
				if (pendingDialog) {
					outcomes.push({ index, ok: true, result: boundedResult(stepResult), dialogPending: true, dialog: pendingDialog, page: { tabId: getTabId(page), url: page.url() } });
					dialogPending = true;
					break;
				}
				const pageResult = pageSummary(page).then((value) => ({ kind: "page" as const, value }), (error: unknown) => ({ kind: "error" as const, error }));
				const pageOutcome = await Promise.race([pageResult, sequenceDialogOpened.then((dialog) => ({ kind: "dialog" as const, dialog }))]);
				if (pageOutcome.kind === "dialog") {
					outcomes.push({ index, ok: true, result: boundedResult(stepResult), dialogPending: true, dialog: pageOutcome.dialog, page: { tabId: getTabId(page), url: page.url() } });
					dialogPending = true;
					break;
				}
				if (pageOutcome.kind === "error") throw pageOutcome.error;
				const state = pageOutcome.value;
				if (step.expect) await this.checkExpectation(page, step.expect);
				outcomes.push({ index, ok: true, result: boundedResult(stepResult), page: state });
			} catch (error) {
				const value = error as { code?: string; message?: string };
				outcomes.push({ index, ok: false, error: { code: value.code ?? "STEP_FAILED", message: value.message ?? String(error) }, page: { tabId: getTabId(page), url: page.url() } });
				if (input.stopOnError !== false) break;
			}
		}
		for (const watchedPage of watchedPages) {
			const handler = pageDialogHandlers.get(watchedPage);
			if (handler) watchedPage.off("dialog", handler);
		}
		return { structuredContent: { outcomes, ...(dialogPending ? { dialogPending: true } : { tabs: await listTabs(browser) }), durationMs: maxMs - Math.max(deadline - Date.now(), 0), stopOnError: input.stopOnError !== false } };
	}

	private async checkExpectation(page: Page, expect: Json) {
		if (expect.urlContains && !page.url().includes(String(expect.urlContains))) throw Object.assign(new Error(`Expected URL to include ${expect.urlContains}.`), { code: "EXPECTATION_FAILED" });
		if (expect.titleContains && !(await page.title()).includes(String(expect.titleContains))) throw Object.assign(new Error(`Expected title to include ${expect.titleContains}.`), { code: "EXPECTATION_FAILED" });
		if (expect.textVisible) {
			const visible = await page.evaluate((text) => document.body?.innerText.includes(text) ?? false, String(expect.textVisible));
			if (!visible) throw Object.assign(new Error(`Expected text to be visible: ${expect.textVisible}`), { code: "EXPECTATION_FAILED" });
		}
		if (expect.selectorVisible) {
			const visible = await evaluatePage(page, `(()=>{const e=document.querySelector(${JSON.stringify(String(expect.selectorVisible))});if(!e)return false;const s=getComputedStyle(e);return !!(e.getClientRects().length&&s.visibility!=='hidden'&&s.display!=='none')})()`);
			if (!visible) throw Object.assign(new Error(`Expected selector to be visible: ${expect.selectorVisible}`), { code: "EXPECTATION_FAILED" });
		}
	}

	private async handoff(browser: Browser, page: Page, op: string, input: Json): Promise<SessionResult> {
		const session = op === "live_view" ? await page.createCDPSession() : await browser.target().createCDPSession();
		try {
			let result: unknown;
			let liveView: unknown;
			if (op === "live_view") result = await session.send("Cloudflare.getLiveView", { targetId: getTabId(page), mode: input.mode ?? "tab", expiresInMs: Math.min(Math.max(Number(input.expiresInMs ?? 300_000), 60_000), 1_800_000) });
			else if (op === "handoff") {
				if (input.url) await page.goto(String(input.url), { waitUntil: "domcontentloaded", timeout: Math.min(Number(input.timeoutMs ?? 300_000), 120_000) });
				result = await session.send("Cloudflare.handoff", { targetId: getTabId(page), timeout: Math.min(Number(input.timeoutMs ?? 300_000), 1_800_000), instructions: String(input.reason ?? "Please inspect and operate the browser, then complete the handoff.") });
				const viewSession = await page.createCDPSession();
				try { liveView = await viewSession.send("Cloudflare.getLiveView", { targetId: getTabId(page), mode: "tab", expiresInMs: Math.min(Math.max(Number(input.timeoutMs ?? 300_000), 60_000), 300_000) }); }
				catch { liveView = undefined; }
				finally { await viewSession.detach().catch(() => undefined); }
			}
			else if (op === "handoff_status") result = await session.send("Cloudflare.getHandoffState", { targetId: getTabId(page) });
			else result = await session.send("Cloudflare.handoffComplete", { targetId: getTabId(page), success: input.success !== false, ...(input.reason ? { reason: String(input.reason) } : {}) });
			return { structuredContent: { result, ...(liveView ? { liveView } : {}), page: await pageSummary(page) } };
		} catch (error) {
			throw Object.assign(new Error(`Cloudflare live-view or handoff command failed: ${(error as Error).message}`), { code: "HANDOFF_UNAVAILABLE" });
		} finally { await session.detach().catch(() => undefined); }
	}
}
