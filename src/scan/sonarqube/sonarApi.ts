// SonarQube's Web API, behind one interface.
//
// **The only file in the feature that calls `fetch`.** That is what lets
// `sonarProvisioning.ts` and the provider be driven by a scripted
// `FakeSonarClient` with no network at all — the `ProcessRunner` seam, applied
// to HTTP.
//
// No dependency: Node 22's global `fetch` is typed by `@types/node`'s
// `web-globals/fetch.d.ts`, which `index.d.ts` references and the root tsconfig
// already pulls in through `types: ["node"]`. The Agent SDK remains the host's
// only runtime dependency.
//
// Every path and parameter name here was read off SonarQube's own source rather
// than a blog post, because a wrong one is a 400 and a feature that never works.
// The ones worth naming: `api/user_tokens/revoke` takes **`name`**, not `token`;
// `api/projects/create` takes **`project`**, not `key`; and every POST is
// form-urlencoded — the Web API does not accept JSON bodies for these actions.

import { ScanError } from '../scanProvider';
import { errorMessage } from '../../platform/errors';

/** What one call came back with, before any interpretation. */
export interface SonarResponse {
	status: number;
	/** Parsed JSON when the body was JSON, else `undefined`. */
	body?: unknown;
	/** The raw text, for an error message when the body was not JSON. */
	text: string;
}

/**
 * How a call authenticates.
 *
 * Two Basic forms, and mixing them up is a 401: a login and password go in as
 * `login:password`, while a **token is the username and the password is empty**
 * — the trailing colon is required. `Bearer` also works on recent Servers, but
 * the token-as-username form works back to 5.x *and* on SonarQube Cloud, so
 * there is one code path.
 */
export type SonarAuth =
	| { kind: 'none' }
	| { kind: 'token'; token: string }
	| { kind: 'password'; login: string; password: string };

export interface SonarRequest {
	method: 'GET' | 'POST';
	/** Path only, e.g. `api/system/status`. */
	path: string;
	/** Query for a GET, form body for a POST. */
	params?: Record<string, string | undefined>;
	auth?: SonarAuth;
}

/** The injection seam: production passes `httpSonarClient`, tests pass a fake. */
export interface SonarClient {
	/**
	 * Never throws for an HTTP status — a 401 is a `SonarResponse`, because the
	 * caller has to tell "wrong credentials" from "wrong url" and both are
	 * answers. It throws only when the request could not be made at all.
	 */
	request(request: SonarRequest): Promise<SonarResponse>;
}

/** The header value for an auth mode, or `undefined` for an anonymous call. */
export function authorizationHeader(auth: SonarAuth | undefined): string | undefined {
	if (!auth || auth.kind === 'none') {
		return undefined;
	}
	const pair =
		auth.kind === 'token' ? `${auth.token}:` : `${auth.login}:${auth.password}`;
	return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/** `('https://x.com/sonar', 'api/system/status', {a: '1'})` → the full url. */
export function sonarUrl(
	baseUrl: string,
	path: string,
	params?: Record<string, string | undefined>
): string {
	const base = baseUrl.replace(/\/+$/, '');
	const url = new URL(`${base}/${path.replace(/^\/+/, '')}`);
	for (const [key, value] of Object.entries(params ?? {})) {
		if (value !== undefined) {
			url.searchParams.set(key, value);
		}
	}
	return url.toString();
}

/** `{a: '1', b: undefined}` → `a=1`, the form body every POST here uses. */
export function formBody(params: Record<string, string | undefined>): string {
	const body = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined) {
			body.set(key, value);
		}
	}
	return body.toString();
}

export interface HttpSonarClientOptions {
	baseUrl: string;
	/** Aborts one request. A wedged socket must not hold a whole scan open. */
	timeoutMs?: number;
	/** Injected so a test can assert without a network; production omits it. */
	fetchImpl?: typeof fetch;
	/**
	 * What VS Code's `http.proxy` says, when it says anything.
	 *
	 * Node's global `fetch` does **not** honour `HTTP_PROXY`, so behind a
	 * corporate proxy every call fails with a bare `TypeError: fetch failed` and
	 * nothing that explains it. BFAST cannot route through the proxy without a
	 * dependency it will not take, so it does the next best thing: names the
	 * proxy in the error, so the user is debugging the right problem.
	 */
	proxy?: string;
}

/** How long one API call gets. Generous: a busy server is slow, not broken. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function httpSonarClient(options: HttpSonarClientOptions): SonarClient {
	const call = options.fetchImpl ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

	return {
		async request(request: SonarRequest): Promise<SonarResponse> {
			const isPost = request.method === 'POST';
			const url = sonarUrl(options.baseUrl, request.path, isPost ? undefined : request.params);
			const authorization = authorizationHeader(request.auth);

			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await call(url, {
					method: request.method,
					headers: {
						...(authorization ? { Authorization: authorization } : {}),
						...(isPost ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
					},
					...(isPost ? { body: formBody(request.params ?? {}) } : {}),
					signal: controller.signal
				});

				const text = await response.text();
				let body: unknown;
				try {
					body = text.length > 0 ? JSON.parse(text) : undefined;
				} catch {
					// Not JSON — a proxy's error page, or a 204. `text` still carries it.
				}
				return { status: response.status, body, text };
			} catch (error) {
				throw new ScanError('server-error', unreachableMessage(options, error), error);
			} finally {
				clearTimeout(timer);
			}
		}
	};
}

function unreachableMessage(options: HttpSonarClientOptions, error: unknown): string {
	if (options.proxy) {
		return (
			`Could not reach the SonarQube server. VS Code is configured to use the proxy ` +
			`\`${options.proxy}\`, and BFAST's HTTP client does not route through it — ` +
			'set `NODE_EXTRA_CA_CERTS` / your proxy environment for the VS Code process, ' +
			'or use a server reachable directly.'
		);
	}
	const detail = errorMessage(error);
	return `Could not reach the SonarQube server: ${detail}`;
}

/** The message a non-2xx response carries, best effort. */
export function sonarErrorMessage(response: SonarResponse): string {
	const body = response.body;
	if (typeof body === 'object' && body !== null && Array.isArray((body as { errors?: unknown }).errors)) {
		const messages = ((body as { errors: unknown[] }).errors)
			.map((entry) =>
				typeof entry === 'object' && entry !== null && typeof (entry as { msg?: unknown }).msg === 'string'
					? (entry as { msg: string }).msg
					: undefined
			)
			.filter((message): message is string => message !== undefined);
		if (messages.length > 0) {
			return messages.join('; ');
		}
	}
	const text = response.text.trim();
	return text.length > 0 ? text.slice(0, 300) : `The server answered ${response.status}.`;
}

/** Maps a status onto the feature's own vocabulary, so callers switch on a code. */
export function sonarErrorFor(response: SonarResponse): ScanError {
	const message = sonarErrorMessage(response);
	if (response.status === 401 || response.status === 403) {
		return new ScanError('unauthorized', message);
	}
	return new ScanError('server-error', message);
}
