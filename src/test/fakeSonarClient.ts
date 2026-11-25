// A scripted `SonarClient`, shaped like `fakeProcessRunner.ts`: a script, not a
// mock framework. It records every request and answers by route, so no test in
// this repo ever touches a network — which is the whole reason `sonarApi.ts`
// exists as a seam rather than as bare `fetch` calls scattered through the
// provider.
//
// Routes are matched on `METHOD path`, most-recently-registered first, so a test
// can override one call of a sequence without re-declaring the rest.

import type { SonarClient, SonarRequest, SonarResponse } from '../scan/sonarqube/sonarApi';

export type SonarRoute = (request: SonarRequest) => SonarResponse | undefined;

export interface RecordedSonarRequest extends SonarRequest {
	/** The `Authorization` value the real client would have sent. */
	authorization?: string;
}

export class FakeSonarClient implements SonarClient {
	/** Every request, in order — what the provisioning suite asserts on. */
	readonly requests: RecordedSonarRequest[] = [];

	private readonly routes: SonarRoute[] = [];
	/** What an unmatched route answers. 404 rather than a throw: a real server would. */
	private fallback: SonarResponse = { status: 404, text: 'not scripted' };

	/** `on('POST api/users/change_password', …)` — later registrations win. */
	on(match: string, respond: (request: SonarRequest) => SonarResponse): this {
		this.routes.unshift((request) =>
			`${request.method} ${request.path}` === match ? respond(request) : undefined
		);
		return this;
	}

	/** Answers `status` for a route, with an optional JSON body. */
	reply(match: string, status: number, body?: unknown): this {
		const text = body === undefined ? '' : JSON.stringify(body);
		return this.on(match, () => ({ status, body, text }));
	}

	/** Answers differently on each successive call to one route; the last repeats. */
	sequence(match: string, replies: { status: number; body?: unknown }[]): this {
		let index = 0;
		return this.on(match, () => {
			const reply = replies[Math.min(index, replies.length - 1)];
			index += 1;
			return {
				status: reply.status,
				body: reply.body,
				text: reply.body === undefined ? '' : JSON.stringify(reply.body)
			};
		});
	}

	setFallback(response: SonarResponse): this {
		this.fallback = response;
		return this;
	}

	/** How many times a route was asked. */
	countOf(match: string): number {
		return this.requests.filter((request) => `${request.method} ${request.path}` === match).length;
	}

	/** The routes asked, in order — the sequence a provisioning test pins. */
	get calls(): string[] {
		return this.requests.map((request) => `${request.method} ${request.path}`);
	}

	async request(request: SonarRequest): Promise<SonarResponse> {
		this.requests.push({ ...request, authorization: describeAuth(request) });
		for (const route of this.routes) {
			const response = route(request);
			if (response) {
				return response;
			}
		}
		return this.fallback;
	}
}

/**
 * A readable stand-in for the header, so a test can assert *which* credential a
 * call used without decoding base64 — and so a token never appears verbatim in
 * an assertion message.
 */
function describeAuth(request: SonarRequest): string | undefined {
	const auth = request.auth;
	if (!auth || auth.kind === 'none') {
		return undefined;
	}
	return auth.kind === 'token' ? `token:${auth.token}` : `password:${auth.login}:${auth.password}`;
}
