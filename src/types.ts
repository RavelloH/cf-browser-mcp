import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { BrowserSession } from "./browser-session.js";

export interface Env {
	BROWSER: { fetch: typeof fetch };
	BROWSER_SESSION: DurableObjectNamespace<BrowserSession>;
	OAUTH_KV: KVNamespace;
	OAUTH_PROVIDER: OAuthHelpers;
	MCP_BASE_URL?: string;
	MCP_AUTH_SECRET: string;
	SESSION_ID_SECRET: string;
}

export interface GrantProps {
	browserSessionKey: string;
}

export interface SessionRequest {
	op: string;
	input?: Record<string, unknown>;
}

export interface SessionResult {
	content?: Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: boolean;
	code?: string;
	message?: string;
	durationMs?: number;
	persistenceWarning?: string;
	snapshotId?: string;
	matches?: unknown[];
	tabIdMappings?: Array<{ previousTabId: string; tabId: string; url: string }>;
	dialogPending?: boolean;
	dialog?: { type: string; message: string; defaultPrompt?: string };
}
