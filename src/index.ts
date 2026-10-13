import OAuthProvider, { AuthorizationError, CimdFetchError } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "@modelcontextprotocol/server";
import projectInfo from "../source-info.json" with { type: "json" };
import { createBrowserMcpServer } from "./mcp.js";
import type { Env } from "./types.js";

const OAUTH_SCOPES = ["browser:control"];

function htmlEscape(value: unknown): string {
	return String(value ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function projectInfoResponse(request: Request, origin: string): Response {
	if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
	const endpoints = Object.fromEntries(Object.entries(projectInfo.endpoints).map(([name, path]) => [name, new URL(path, origin).toString()]));
	return new Response(request.method === "HEAD" ? null : JSON.stringify({ ...projectInfo, endpoints }, null, 2), {
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "public, max-age=300",
			"x-content-type-options": "nosniff",
		},
	});
}

function page(title: string, body: string, status = 200, allowedFormOrigin?: string): Response {
	const formAction = allowedFormOrigin ? `'self' ${allowedFormOrigin}` : "'self'";
	return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(title)}</title><style>body{font:16px/1.55 system-ui,sans-serif;max-width:620px;margin:9vh auto;padding:0 22px;color:#18202a}main{border:1px solid #d8dee8;border-radius:14px;padding:26px}label{display:block;margin:18px 0 8px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #98a2b3;border-radius:8px;font:inherit}button{padding:10px 16px;border:0;border-radius:8px;background:#1458d4;color:white;font:inherit;cursor:pointer}button.secondary{background:#e9edf4;color:#18202a}.error{color:#a32222}</style></head><body><main>${body}</main></body></html>`, {
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; base-uri 'none'; frame-ancestors 'none'`,
			"referrer-policy": "no-referrer",
		}, status,
	});
}

function constantTimeEqual(left: string, right: string): boolean {
	const a = new TextEncoder().encode(left);
	const b = new TextEncoder().encode(right);
	let diff = a.length ^ b.length;
	const length = Math.max(a.length, b.length);
	for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
	return diff === 0;
}

async function rateLimitKey(request: Request): Promise<string> {
	const address = request.headers.get("cf-connecting-ip") ?? "unknown";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(address));
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return `auth-fail:${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

async function handleAuthorize(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET" && request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });
	if (!env.MCP_AUTH_SECRET) return new Response("MCP_AUTH_SECRET is not configured", { status: 503 });
	const oauth = env.OAUTH_PROVIDER;
	if (request.method === "GET") {
		try {
			const authRequest = await oauth.parseAuthRequest(request);
			const details = await oauth.describeConsent(authRequest);
			const consent = await oauth.beginConsent(authRequest);
			const requestedScopes = details.scope.length ? details.scope : OAUTH_SCOPES;
			const scopes = requestedScopes.map((scope) => `<li>${htmlEscape(scope)}</li>`).join("");
			const scopeInputs = requestedScopes.map((scope) => `<input type="hidden" name="scope" value="${htmlEscape(scope)}">`).join("");
			const clientPublisher = details.clientDomain ? `<p>客户端域名：<strong>${htmlEscape(details.clientDomain)}</strong></p>` : `<p>此客户端没有已验证的域名，显示名称由客户端自行提供。</p>`;
			const callbackOrigin = new URL(authRequest.redirectUri).origin;
			const formActionUrl = new URL(request.url);
			const content = `<h1>授权浏览器访问</h1><p><strong>${htmlEscape(details.clientName)}</strong> 正在请求访问你的浏览器会话。</p>${clientPublisher}<p>OAuth 回调主机：<strong>${htmlEscape(details.redirectHost)}</strong></p>${details.redirectIsLoopback ? `<p>此客户端将在这台电脑上接收 OAuth 令牌。</p>` : ""}<p>请求的权限：</p><ul>${scopes}</ul><form method="post" action="${htmlEscape(`${formActionUrl.pathname}${formActionUrl.search}`)}"><input type="hidden" name="handle" value="${htmlEscape(consent.handle)}">${scopeInputs}<label for="secret">授权密钥</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><p><button name="decision" value="approve">继续授权</button> <button class="secondary" name="decision" value="deny" formnovalidate>取消</button></p></form>`;
			const response = page("授权 cf-browser-mcp", content, 200, callbackOrigin);
			for (const [name, value] of consent.headers) response.headers.append(name, value);
			return response;
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	const form = await request.formData();
	const handle = String(form.get("handle") ?? "");
	if (!handle) return page("授权失败", "<h1>授权已过期</h1><p>请从 MCP 客户端重新开始连接。</p>");
	if (form.get("decision") !== "approve") {
		try {
			const denied = await oauth.denyConsent(request, handle);
			return new Response(null, { status: 302, headers: denied.headers });
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	const attemptsKey = await rateLimitKey(request);
	const attempts = Number(await env.OAUTH_KV.get(attemptsKey) ?? "0");
	if (attempts >= 8) return page("授权已暂停", "<h1>尝试次数过多</h1><p>请稍后重新发起授权。</p>");
	const provided = String(form.get("secret") ?? "");
	if (!constantTimeEqual(provided, env.MCP_AUTH_SECRET)) {
		await env.OAUTH_KV.put(attemptsKey, String(attempts + 1), { expirationTtl: 3600 });
		try {
			const authRequest = await oauth.parseAuthRequest(request);
			const details = await oauth.describeConsent(authRequest);
			const requestedScopes = details.scope.length ? details.scope : OAUTH_SCOPES;
			const scopes = requestedScopes.map((scope) => `<li>${htmlEscape(scope)}</li>`).join("");
			const scopeInputs = requestedScopes.map((scope) => `<input type="hidden" name="scope" value="${htmlEscape(scope)}">`).join("");
			const callbackOrigin = new URL(authRequest.redirectUri).origin;
			const formActionUrl = new URL(request.url);
			return page("授权密钥不正确", `<h1>授权密钥不正确</h1><p class="error">密钥不匹配，请重试或取消。</p><p><strong>${htmlEscape(details.clientName)}</strong> 正在请求访问 <strong>${htmlEscape(details.redirectHost)}</strong>。</p><p>请求的权限：</p><ul>${scopes}</ul><form method="post" action="${htmlEscape(`${formActionUrl.pathname}${formActionUrl.search}`)}"><input type="hidden" name="handle" value="${htmlEscape(handle)}">${scopeInputs}<label for="secret">授权密钥</label><input id="secret" name="secret" type="password" autocomplete="current-password" required autofocus><p><button name="decision" value="approve">继续授权</button> <button class="secondary" name="decision" value="deny" formnovalidate>取消</button></p></form>`, 200, callbackOrigin);
		} catch (error) {
			return oauthErrorResponse(error);
		}
	}

	try {
		const approved = await oauth.approveConsent(request, handle, { scope: form.getAll("scope").map(String) });
		const { redirectTo } = await oauth.completeAuthorization({
			request: approved.request,
			userId: "owner",
			metadata: {},
			scope: approved.request.scope,
			props: { browserSessionKey: crypto.randomUUID() },
		});
		await env.OAUTH_KV.delete(attemptsKey);
		approved.headers.set("location", redirectTo);
		return new Response(null, { status: 302, headers: approved.headers });
	} catch (error) {
		return oauthErrorResponse(error);
	}
}

function oauthErrorResponse(error: unknown): Response {
	if (error instanceof AuthorizationError) {
		if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
		return page("授权失败", `<h1>无法继续授权</h1><p>${htmlEscape(error.description)}</p>`, 400);
	}
	if (error instanceof CimdFetchError) return page("客户端验证失败", "<h1>无法验证客户端</h1><p>请从 MCP 客户端重新开始连接。</p>", 400);
	throw error;
}

function makeProvider(env: Env, request: Request) {
	const apiHandler = {
		async fetch(request: Request, requestEnv: Env, ctx: ExecutionContext & { props?: unknown; auth?: { scope?: string[] } }) {
			if (new URL(request.url).pathname !== "/mcp") return new Response("Not found", { status: 404 });
			if (!ctx.auth?.scope?.includes("browser:control")) return Response.json(
				{ error: "insufficient_scope", error_description: "The browser:control scope is required." },
				{ status: 403, headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope="browser:control"' } },
			);
			const props = ctx.props && typeof ctx.props === "object" && !Array.isArray(ctx.props)
				? ctx.props as Record<string, unknown>
				: {};
			const handler = createMcpHandler(() => createBrowserMcpServer(requestEnv, props), { legacy: "stateless" });
			return await handler.fetch(request);
		},
	};
	const configuredBase = (env.MCP_BASE_URL ?? "").trim();
	const origin = configuredBase ? new URL(configuredBase).origin : new URL(request.url).origin;
	const defaultHandler = {
		fetch(request: Request, requestEnv: Env) {
			const pathname = new URL(request.url).pathname;
			if (pathname === "/" || pathname === "/source-info.json") return projectInfoResponse(request, origin);
			if (pathname === "/authorize") return handleAuthorize(request, requestEnv);
			return new Response("Not found", { status: 404 });
		},
	};
	return new OAuthProvider<Env>({
		apiRoute: "/mcp",
		apiHandler,
		defaultHandler,
		authorizeEndpoint: "/authorize",
		tokenEndpoint: "/oauth/token",
		clientRegistrationEndpoint: "/oauth/register",
		scopesSupported: OAUTH_SCOPES,
		requiredScopes: OAUTH_SCOPES,
		resourceMetadata: {
			resource: `${origin}/mcp`,
			authorization_servers: [origin],
			resource_name: "cf-browser-mcp",
		},
		clientIdMetadataDocumentEnabled: true,
		refreshTokenTTL: 90 * 24 * 60 * 60,
		refreshTokenIdleTTL: 30 * 24 * 60 * 60,
	});
}

export { BrowserSession } from "./browser-session.js";

export default {
	fetch(request: Request, env: Env, ctx: ExecutionContext) {
		return makeProvider(env, request).fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
