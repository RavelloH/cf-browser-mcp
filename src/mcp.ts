import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getSessionStub } from "./session-id.js";
import type { Env, SessionRequest, SessionResult } from "./types.js";

const tab = { tabId: z.string().optional().describe("Target browser tab ID. Omit to use the first open tab.") };
const target = {
	css: z.string().max(2000).optional().describe("CSS selector for the target."),
	ref: z.string().optional().describe("Element reference such as e3 from the latest snapshot/find."),
	snapshotId: z.string().optional().describe("Snapshot ID returned with the element ref; required to detect stale references."),
	role: z.string().optional().describe("Accessible role, such as button, textbox, link, or checkbox."),
	name: z.string().optional().describe("Accessible name. Use with role for exact accessible lookup."),
	exact: z.boolean().optional().describe("Match the accessible name exactly; defaults to true."),
};

function serializable(value: unknown): string {
	try { return JSON.stringify(value, null, 2); }
	catch { return String(value); }
}

async function callSession(env: Env, props: Record<string, unknown>, op: string, input: Record<string, unknown>): Promise<SessionResult> {
	const stub = await getSessionStub(env, props);
	const request: SessionRequest = { op, input };
	const response = await stub.fetch("https://browser-session.internal/action", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(request),
	});
	const result = await response.json() as SessionResult & { message?: string; code?: string };
	if (!response.ok && !result.isError) return { isError: true, content: [{ type: "text", text: `${result.code ?? "BROWSER_ERROR"}: ${result.message ?? response.statusText}` }] };
	if (result.isError) return { ...result, content: [{ type: "text", text: serializable({ code: result.code, message: result.message, snapshotId: result.snapshotId, matches: result.matches, durationMs: result.durationMs, persistenceWarning: result.persistenceWarning }) }] };
	if (!result.content?.length) result.content = [{ type: "text", text: serializable(result.structuredContent ?? {}) }];
	return result;
}

type Shape = Record<string, z.ZodTypeAny>;
type InputFromShape<S extends Shape> = z.infer<z.ZodObject<S>>;

export function createBrowserMcpServer(env: Env, props: Record<string, unknown>) {
	const server = new McpServer({ name: "cf-browser-mcp", version: "0.1.0" });
	const register = <S extends Shape>(name: string, description: string, inputSchema: S, op: string, mapInput?: (input: InputFromShape<S>) => Record<string, unknown>) => {
		server.registerTool(name, { description, inputSchema: z.object(inputSchema) }, async (raw) => {
			const input = raw as InputFromShape<S>;
			return await callSession(env, props, op, mapInput ? mapInput(input) : input as Record<string, unknown>) as any;
		});
	};

	register("browser_status", "Show whether this OAuth grant has an active Cloudflare Browser session and which saved tabs can be restored. Does not start Chromium or open a CDP connection.", {}, "status");
	register("browser_resume", "Start Chromium and restore saved cookies, localStorage, and tabs when the remote session is idle. Returns the current tab IDs, which may change after a restart.", {}, "resume");
	register("browser_list_tabs", "List open tabs with tabId, URL, title, and viewport. Does not start a browser.", {}, "list_tabs");
	register("browser_new_tab", "Open a new tab, optionally navigating to a URL.", { url: z.string().url().optional(), waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, "new_tab");
	register("browser_activate_tab", "Bring the selected tab to the front. Does not start Chromium if the tab is not active.", tab, "activate_tab");
	register("browser_close_tab", "Close a tab by tabId. If omitted, closes the first open tab.", tab, "close_tab");
	register("browser_close_session", "Close the current remote Chromium process after saving browser state. The next browser operation can restore cookies and reopen saved page URLs.", {}, "close_session");
	register("browser_clear_saved_state", "Permanently clear this OAuth grant's saved cookies, localStorage, tab URLs, viewport state, and active remote browser session.", {}, "clear_saved_state");
	register("browser_navigate", "Navigate a tab to a URL and return response status plus current page metadata.", { ...tab, url: z.string().url(), waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, "navigate");
	register("browser_back", "Navigate the selected tab back in its history.", { ...tab, waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, "back");
	register("browser_forward", "Navigate the selected tab forward in its history.", { ...tab, waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, "forward");
	register("browser_reload", "Reload the selected tab.", { ...tab, waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(120000).optional() }, "reload");
	register("browser_wait", "Wait for a CSS selector, visible text, or a bounded duration.", { ...tab, selector: z.string().optional(), text: z.string().optional(), visible: z.boolean().optional(), timeoutMs: z.number().int().min(1).max(30000).optional() }, "wait");
	register("browser_page_info", "Get URL, title, tabId, and viewport for the selected tab.", tab, "page_info");
	register("browser_snapshot", "Return an accessibility-backed page snapshot with short-lived element refs and a snapshotId. Re-snapshot after navigation or major page changes.", { ...tab, maxNodes: z.number().int().min(1).max(1000).optional(), maxChars: z.number().int().min(500).max(80000).optional() }, "snapshot");
	register("browser_find", "Find visible page elements by accessible role and/or accessible name. Returns refs tied to snapshotId; use these refs for actions.", { ...tab, query: z.string().optional(), name: z.string().optional(), role: z.string().optional(), exact: z.boolean().optional(), limit: z.number().int().min(1).max(100).optional() }, "find");
	register("browser_screenshot", "Capture the selected tab as an image. Supports viewport/full-page capture, a clip rectangle, PNG, or JPEG.", { ...tab, fullPage: z.boolean().optional(), type: z.enum(["png", "jpeg"]).optional(), quality: z.number().int().min(1).max(100).optional(), clip: z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive(), scale: z.number().positive().optional() }).optional() }, "screenshot");
	register("browser_click", "Click an element by CSS, accessible role/name, or a fresh snapshot ref. Returns current page metadata.", { ...tab, ...target, button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(3).optional(), afterMs: z.number().int().min(0).max(5000).optional(), includeSnapshot: z.boolean().optional() }, "action", (input) => ({ ...input, action: "click" }));
	register("browser_hover", "Move the pointer over an element by CSS, role/name, or fresh snapshot ref.", { ...tab, ...target, afterMs: z.number().int().min(0).max(5000).optional() }, "action", (input) => ({ ...input, action: "hover" }));
	register("browser_fill", "Set an input, textarea, or contenteditable value and dispatch input/change events.", { ...tab, ...target, value: z.string(), afterMs: z.number().int().min(0).max(5000).optional() }, "action", (input) => ({ ...input, action: "fill" }));
	register("browser_type", "Type text into the focused/located element using browser input events. Use browser_fill for replacing field contents.", { ...tab, ...target, text: z.string(), afterMs: z.number().int().min(0).max(5000).optional() }, "action", (input) => ({ ...input, action: "type" }));
	register("browser_press_key", "Send one key press to the selected element, such as Enter, Tab, Escape, or a single character.", { ...tab, ...target, key: z.string().min(1).max(40), afterMs: z.number().int().min(0).max(5000).optional() }, "action", (input) => ({ ...input, action: "press_key" }));
	register("browser_select_option", "Select one or more option values on a select element.", { ...tab, ...target, value: z.union([z.string(), z.array(z.string())]) }, "action", (input) => ({ ...input, action: "select_option" }));
	register("browser_check", "Check a checkbox or radio input.", { ...tab, ...target }, "action", (input) => ({ ...input, action: "check" }));
	register("browser_uncheck", "Uncheck a checkbox or radio input.", { ...tab, ...target }, "action", (input) => ({ ...input, action: "uncheck" }));
	register("browser_focus", "Focus a page element.", { ...tab, ...target }, "action", (input) => ({ ...input, action: "focus" }));
	register("browser_scroll_into_view", "Scroll an element into view.", { ...tab, ...target }, "action", (input) => ({ ...input, action: "scroll_into_view" }));
	register("browser_fill_form", "Fill or select up to 100 fields in one browser call. Resolve all refs from the same current snapshot before applying changes.", { ...tab, fields: z.array(z.object({ ...target, action: z.enum(["fill", "select_option", "check", "uncheck"]).optional(), value: z.union([z.string(), z.array(z.string())]).optional() })).min(1).max(100) }, "fill_form");
	register("browser_handle_dialog", "Accept or dismiss the currently open JavaScript alert, confirm, or prompt dialog.", { ...tab, accept: z.boolean(), promptText: z.string().optional() }, "handle_dialog");
	register("browser_evaluate", "Run JavaScript in the selected page context and return its JSON-serializable result. This has full page privileges and does not run in the Worker.", { ...tab, expression: z.string().min(1).max(100000), timeoutMs: z.number().int().min(1).max(30000).optional() }, "evaluate");
	register("browser_set_viewport", "Set the selected tab's viewport dimensions and device scale factor.", { ...tab, width: z.number().int().min(100).max(7680), height: z.number().int().min(100).max(4320), deviceScaleFactor: z.number().min(0.5).max(4).optional(), mobile: z.boolean().optional() }, "viewport");
	register("browser_mouse", "Control the page pointer with viewport coordinates: move, click, press/release a button, wheel, or drag.", { ...tab, action: z.enum(["move", "click", "down", "up", "wheel", "drag"]), x: z.number(), y: z.number(), button: z.enum(["left", "right", "middle"]).optional(), clickCount: z.number().int().min(1).max(3).optional(), deltaX: z.number().optional(), deltaY: z.number().optional(), endX: z.number().optional(), endY: z.number().optional() }, "mouse");
	register("browser_keyboard", "Send keyboard input to the focused page: type text, press a key, or hold/release a key. Supports Control, Alt, Shift, and Meta modifiers.", { ...tab, action: z.enum(["type", "press", "down", "up"]), key: z.string().optional(), code: z.string().optional(), text: z.string().optional(), modifiers: z.array(z.enum(["Alt", "Control", "Ctrl", "Meta", "Shift"])).optional() }, "keyboard");
	register("browser_scroll", "Scroll the selected tab at viewport coordinates using wheel deltas.", { ...tab, x: z.number().optional(), y: z.number().optional(), deltaX: z.number().optional(), deltaY: z.number() }, "mouse", (input) => ({ ...input, action: "wheel" }));
	register("browser_cdp", "Send a raw Chrome DevTools Protocol command to the selected page or browser target. Use page scope by default; browser scope is for Browser/Target domains.", { ...tab, scope: z.enum(["page", "browser"]).optional(), method: z.string(), params: z.record(z.string(), z.unknown()).optional() }, "cdp");
	register("browser_network_requests", "Capture request/response metadata while performing one bounded navigation, reload, click, or page evaluation. No background/retroactive capture is kept.", { ...tab, action: z.object({ type: z.enum(["navigate", "reload", "click", "evaluate"]), url: z.string().optional(), expression: z.string().optional(), ...target, waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() }), settleMs: z.number().int().min(0).max(5000).optional() }, "network_requests");
	register("browser_debug_capture", "Capture console messages, page errors, and request metadata during a bounded page action.", { ...tab, action: z.object({ type: z.enum(["navigate", "reload", "click", "evaluate"]), url: z.string().optional(), expression: z.string().optional(), ...target, waitUntil: z.enum(["load", "domcontentloaded", "networkidle0", "networkidle2"]).optional(), timeoutMs: z.number().int().min(1000).max(60000).optional() }), settleMs: z.number().int().min(0).max(5000).optional() }, "debug_capture");
	register("browser_sequence", "Run a bounded sequence of navigation, wait, action, page evaluation, and new-tab steps in one CDP connection. Up to 30 steps/60 seconds. This is not transactional and never auto-replays side effects.", { ...tab, steps: z.array(z.record(z.string(), z.unknown())).min(1).max(30), maxDurationMs: z.number().int().min(1000).max(60000).optional(), stopOnError: z.boolean().optional() }, "sequence");
	register("browser_live_view", "Create a short-lived Cloudflare Live View URL for a human to inspect the active browser tab.", { ...tab, mode: z.enum(["devtools", "tab", "full"]).optional(), expiresInMs: z.number().int().min(1000).max(1800000).optional() }, "live_view");
	register("browser_request_human", "Request a human takeover of the browser, optionally opening a URL and setting a bounded timeout. Browser runtime remains active during the handoff.", { ...tab, url: z.string().url().optional(), timeoutMs: z.number().int().min(1000).max(1800000).optional(), reason: z.string().max(1000).optional() }, "handoff");
	register("browser_handoff_status", "Check whether a requested human handoff is still active.", tab, "handoff_status");
	register("browser_handoff_complete", "Signal that the human has completed the current handoff.", { ...tab, success: z.boolean().optional(), reason: z.string().max(1024).optional() }, "handoff_complete");

	return server;
}
