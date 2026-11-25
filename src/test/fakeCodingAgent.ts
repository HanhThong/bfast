// A test-only `CodingAgent`, the `fakeAiProvider.ts` shape: a script, not a
// mock framework. It records every request and answers what it was told to.
// It is also the proof that the seam is in the right place — if satisfying
// `CodingAgent` needed a cast or a `vscode` import, the interface would be
// wrong.

import type {
	CodingAgent,
	CodingAgentAvailability,
	ImplementError,
	ImplementRequest
} from '../implement/codingAgent';

export interface FakeCodingAgentOptions {
	availability?: CodingAgentAvailability;
	/** What `open` rejects with; absent means it resolves. */
	failWith?: ImplementError;
	extensionId?: string;
}

export class FakeCodingAgent implements CodingAgent {
	readonly id = 'claude-code' as const;
	readonly label = 'Fake agent';
	readonly extensionId: string | undefined;

	/** Every request that reached the agent, in order. */
	readonly requests: ImplementRequest[] = [];

	constructor(private readonly options: FakeCodingAgentOptions = {}) {
		this.extensionId = options.extensionId;
	}

	availability(): Promise<CodingAgentAvailability> {
		return Promise.resolve(this.options.availability ?? { ok: true });
	}

	open(request: ImplementRequest): Promise<void> {
		this.requests.push(request);
		return this.options.failWith ? Promise.reject(this.options.failWith) : Promise.resolve();
	}
}
