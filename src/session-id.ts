import type { Env, GrantProps } from "./types.js";

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export async function getSessionStub(env: Env, props: unknown) {
	const key = (props as Partial<GrantProps> | undefined)?.browserSessionKey;
	if (!key || typeof key !== "string") throw new Error("OAUTH_GRANT_MISSING_SESSION_KEY");
	if (!env.SESSION_ID_SECRET) throw new Error("SESSION_ID_SECRET_NOT_CONFIGURED");
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(env.SESSION_ID_SECRET),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(key)));
	const id = env.BROWSER_SESSION.idFromName(toBase64Url(digest));
	return env.BROWSER_SESSION.get(id);
}
