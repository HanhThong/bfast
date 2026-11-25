// Getting a SonarQube BFAST deployed into a state a scan can use, without the
// user logging in, changing a password and copying a token by hand.
//
// Pure orchestration over an injected `SonarClient`, so the whole sequence is
// testable with no network — the `generateChildren.ts` posture. The only
// non-injected dependency is `node:crypto`, for the password.
//
// The sequence is ordered **cheapest-first and least-destructive-first**, which
// is not a micro-optimisation but the thing that makes it safe to run at any
// time: on a healthy instance it costs one HTTP call and writes nothing, and a
// user who changed the admin password by hand still gets a working scan,
// because SonarQube does not revoke tokens when a password changes and step 1
// runs before step 2.
//
// docs/scan/sonarqube.md#provisioning is the contract.

import { randomInt } from 'crypto';
import { ScanError, type ScanCredentials } from '../scanProvider';
import { sonarErrorFor, type SonarAuth, type SonarClient, type SonarResponse } from './sonarApi';

/** SonarQube's factory account. */
export const DEFAULT_ADMIN_LOGIN = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'admin';

/**
 * Fixed token names, one per purpose.
 *
 * Not unique names. The value is shown once, so a token BFAST cannot read is
 * dead weight that has to be replaced regardless — uniquifying only postpones
 * that. And unique names *accumulate*: after ten provisions the user's Security
 * page has ten indistinguishable rows and "revoke BFAST's access" stops being
 * one obvious click.
 */
export const ANALYSIS_TOKEN_NAME = 'BFAST analysis';
export const RESULTS_TOKEN_NAME = 'BFAST results';

/**
 * SonarQube's own policy, read off `ChangePasswordAction`: at least 12
 * characters with at least one of each class.
 */
export const MIN_PASSWORD_LENGTH = 12;
const GENERATED_PASSWORD_LENGTH = 32;

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const LOWER = 'abcdefghijklmnopqrstuvwxyz';
const DIGIT = '0123456789';
/**
 * Deliberately narrow: no quote, backslash, backtick, `$`, `&` or `;`. The
 * password should never reach a shell, a URL or a log — but it costs nothing to
 * make it survive if it ever does, and it removes a whole class of bug.
 */
const SPECIAL = '-_.~!@#%^*+=';

/**
 * A password that satisfies the policy, from `node:crypto` only.
 *
 * One character from each class, the rest from the union, then a Fisher–Yates
 * shuffle so the guaranteed four are not always in front. Every draw is
 * `randomInt`, which is unbiased and needs no rejection loop — and never
 * `Math.random`, which is not a source anyone should generate a credential from.
 */
export function generatePassword(length = GENERATED_PASSWORD_LENGTH): string {
	const classes = [UPPER, LOWER, DIGIT, SPECIAL];
	const alphabet = classes.join('');
	const characters = classes.map((set) => set[randomInt(0, set.length)]);
	while (characters.length < Math.max(length, MIN_PASSWORD_LENGTH)) {
		characters.push(alphabet[randomInt(0, alphabet.length)]);
	}
	for (let index = characters.length - 1; index > 0; index -= 1) {
		const swap = randomInt(0, index + 1);
		[characters[index], characters[swap]] = [characters[swap], characters[index]];
	}
	return characters.join('');
}

/** True when the password would satisfy SonarQube. Exported so a test can assert it. */
export function satisfiesPasswordPolicy(password: string): boolean {
	return (
		password.length >= MIN_PASSWORD_LENGTH &&
		/[A-Z]/.test(password) &&
		/[a-z]/.test(password) &&
		/\d/.test(password) &&
		/[^A-Za-z0-9]/.test(password)
	);
}

export interface ProvisionDeps {
	client: SonarClient;
	/** Already-stored credentials; the cheapest probe uses them first. */
	current: ScanCredentials;
	/** Written **before** the password change is sent. See `changeAdminPassword`. */
	rememberPassword: (password: string) => Promise<void>;
	onProgress?: (label: string) => void;
	/** Injected so a test is deterministic. */
	makePassword?: () => string;
}

/**
 * Mints or verifies what a scan needs, and **returns** it — storing is the
 * store's job, because a provider must not learn where a secret lives.
 *
 * Idempotent by contract. The four steps, in order:
 *
 *   1. Both tokens stored and the results one works → return, having written
 *      nothing. This is the common case and it costs one call.
 *   2. The admin password works → the tokens are missing or were revoked:
 *      revoke by name and mint both again.
 *   3. `admin`/`admin` works → a fresh instance: change the password and mint
 *      both tokens.
 *   4. None of the above → stop and say so. Never guess, never try a list of
 *      candidate passwords, never touch the data.
 *
 * The **project is not created here** — see `ensureProject`. Provisioning is
 * about the server and runs before any scan has said what it will analyse;
 * the key is the scan's, read off the checkout's own properties file, and a
 * project created from a guess would sit empty on the dashboard beside the
 * real one.
 */
export async function provisionSonarQube(deps: ProvisionDeps): Promise<ScanCredentials> {
	const { client, current } = deps;

	// 1 — the cheapest thing that could possibly work.
	if (current.analysisToken && current.resultsToken) {
		if (await tokenWorks(client, current.resultsToken)) {
			deps.onProgress?.('Credentials are already in place');
			return {};
		}
	}

	// 2 — the stored admin password, if there is one.
	if (current.adminPassword) {
		const auth: SonarAuth = {
			kind: 'password',
			login: DEFAULT_ADMIN_LOGIN,
			password: current.adminPassword
		};
		if (await authWorks(client, auth)) {
			deps.onProgress?.('Renewing the analysis tokens');
			return mintTokens(deps, auth);
		}
		// Not fatal: changing a password does not revoke tokens, so a user who
		// changed it by hand still has a working scan. Step 1 already proved the
		// tokens are gone, though, so fall through and see if this is a fresh
		// instance rather than pretending.
		deps.onProgress?.('The stored admin password no longer works');
	}

	// 3 — a fresh instance still on the factory credentials.
	const factory: SonarAuth = {
		kind: 'password',
		login: DEFAULT_ADMIN_LOGIN,
		password: DEFAULT_ADMIN_PASSWORD
	};
	if (await authWorks(client, factory)) {
		const password = (deps.makePassword ?? generatePassword)();
		deps.onProgress?.('Setting the SonarQube admin password');
		await changeAdminPassword(deps, password);

		const auth: SonarAuth = {
			kind: 'password',
			login: DEFAULT_ADMIN_LOGIN,
			password
		};
		deps.onProgress?.('Creating the analysis tokens');
		const tokens = await mintTokens(deps, auth);
		return { ...tokens, adminPassword: password };
	}

	// 4 — someone else set this instance up. Two ways out, and no third.
	throw new ScanError(
		'unauthorized',
		'This SonarQube is already set up and BFAST does not have its admin password. ' +
			'Either create a Global Analysis Token in its UI and run BFAST: Set SonarQube Token, ' +
			'or run BFAST: Remove Scan Server to delete this instance and start fresh.'
	);
}

/**
 * `POST api/users/change_password`.
 *
 * The password is written to storage **before** it is sent, and only cleared if
 * the send fails. Changing a password is an irreversible effect on a server; a
 * crash between "the server accepted it" and "the extension wrote it down"
 * would lock the user out of their own instance. Write-then-act is the only
 * safe order for an irreversible remote effect.
 */
async function changeAdminPassword(deps: ProvisionDeps, password: string): Promise<void> {
	await deps.rememberPassword(password);
	const response = await deps.client.request({
		method: 'POST',
		path: 'api/users/change_password',
		params: {
			login: DEFAULT_ADMIN_LOGIN,
			previousPassword: DEFAULT_ADMIN_PASSWORD,
			password
		},
		auth: {
			kind: 'password',
			login: DEFAULT_ADMIN_LOGIN,
			password: DEFAULT_ADMIN_PASSWORD
		}
	});
	if (!ok(response)) {
		// It never took effect, so the stored value would be a lie.
		await deps.rememberPassword('');
		throw sonarErrorFor(response);
	}
}

/** Revoke-then-generate, both tokens. See the note on the fixed names. */
async function mintTokens(
	deps: ProvisionDeps,
	auth: SonarAuth
): Promise<{ analysisToken: string; resultsToken: string }> {
	const analysisToken = await regenerate(deps, auth, ANALYSIS_TOKEN_NAME, 'GLOBAL_ANALYSIS_TOKEN');
	const resultsToken = await regenerate(deps, auth, RESULTS_TOKEN_NAME, 'USER_TOKEN');
	return { analysisToken, resultsToken };
}

/**
 * One token, replaced.
 *
 * `revoke` is safe to call for a name that does not exist, and the ordering
 * hazard — revoke succeeds, generate fails, BFAST destroyed its own working
 * token — is covered by the caller: this path is only reached when the stored
 * token was absent or proven dead, so there was nothing to lose.
 *
 * **Two token types on purpose.** `GLOBAL_ANALYSIS_TOKEN` is the only credential
 * that enters the scanner container: if it leaks, an attacker can push a bogus
 * analysis and essentially nothing else. `USER_TOKEN` never leaves the extension
 * host, and it has to be a user token because `api/issues/search` and
 * `api/projects/create` answer 403 to an analysis token — a design that works
 * for two of four calls is a design that 403s in production.
 */
async function regenerate(
	deps: ProvisionDeps,
	auth: SonarAuth,
	name: string,
	type: 'GLOBAL_ANALYSIS_TOKEN' | 'USER_TOKEN'
): Promise<string> {
	await deps.client.request({
		method: 'POST',
		path: 'api/user_tokens/revoke',
		// `name`, not `token` — the parameter a live instance's own web_api
		// listing gets wrong and the server source gets right.
		params: { name },
		auth
	});

	const response = await deps.client.request({
		method: 'POST',
		path: 'api/user_tokens/generate',
		// No `expirationDate`: a token that silently expires turns a working
		// feature into a 401 months later, and re-provisioning already replaces it.
		params: { name, type },
		auth
	});
	if (!ok(response)) {
		throw sonarErrorFor(response);
	}

	const token = readString(response.body, 'token');
	if (token === undefined) {
		throw new ScanError(
			'server-error',
			`SonarQube created the token “${name}” but did not return its value.`
		);
	}
	return token;
}

export interface EnsureProjectOptions {
	client: SonarClient;
	/** The results token — a user token; an analysis token answers 403 here. */
	token: string;
	projectKey: string;
	projectName?: string;
	/** SonarQube Cloud, where `api/projects/create` requires it. */
	organization?: string;
	onProgress?: (label: string) => void;
}

/**
 * Makes sure the project a scan will file under exists, **before** the scanner
 * runs. Returns whether it was created now.
 *
 * Not strictly required: a first analysis with an unknown key auto-provisions
 * the project. BFAST does it anyway for two reasons that both pay. It sets a
 * readable display **name** — the one the checkout's `sonar.projectName` gives,
 * where auto-provisioning names the project after the key. And it fails in one
 * second when the credential cannot create projects, instead of after a
 * four-minute scan that dies at report submission.
 *
 * `GET api/components/show` first, because it needs only *Browse* — the
 * permission every usable token has — where `api/projects/search` needs
 * *Administer System*; an existing project then costs one call and writes
 * nothing. `POST api/projects/create` takes **`project`**, not `key`, and
 * "key already exists" from a race is success, not a failure.
 */
export async function ensureProject(options: EnsureProjectOptions): Promise<boolean> {
	const auth: SonarAuth = { kind: 'token', token: options.token };
	const existing = await options.client.request({
		method: 'GET',
		path: 'api/components/show',
		params: { component: options.projectKey },
		auth
	});
	if (ok(existing)) {
		return false;
	}
	if (existing.status !== 404) {
		throw sonarErrorFor(existing);
	}

	options.onProgress?.(`Creating the project ${options.projectKey}`);
	const response = await options.client.request({
		method: 'POST',
		path: 'api/projects/create',
		params: {
			project: options.projectKey,
			name: options.projectName ?? options.projectKey,
			...(options.organization ? { organization: options.organization } : {})
		},
		auth
	});
	if (ok(response) || /already exists/i.test(response.text)) {
		return true;
	}
	throw sonarErrorFor(response);
}

/**
 * Checks a token the **user** supplied and mints nothing — the path for an
 * external server, and for a deployed one with `autoProvision: false`, where
 * the instance is the user's to manage and step 3 above must never run.
 *
 * The probe is `api/issues/search` on purpose: it is the endpoint an
 * analysis-only token answers 403 to, so pasting the wrong kind of token fails
 * here in a second with a message that says which kind is needed, rather than
 * four minutes into the first scan.
 */
export async function verifyResultsToken(
	client: SonarClient,
	token: string | undefined,
	onProgress?: (label: string) => void
): Promise<void> {
	if (!token) {
		throw new ScanError(
			'unauthorized',
			'No SonarQube token is stored for this workspace. Run BFAST: Set SonarQube Token.'
		);
	}
	onProgress?.('Checking the SonarQube token');
	const response = await client.request({
		method: 'GET',
		path: 'api/issues/search',
		params: { ps: '1' },
		auth: { kind: 'token', token }
	});
	if (response.status === 401 || response.status === 403) {
		throw new ScanError(
			'unauthorized',
			'That token can run an analysis but cannot read its results. BFAST needs a **user** token — an analysis token answers 403 to the Web API.'
		);
	}
	if (response.status >= 400) {
		throw sonarErrorFor(response);
	}
}

/**
 * Does this credential resolve a real user?
 *
 * **Not `api/authentication/validate`**: that answers `{"valid": true}` for an
 * *anonymous* request when `sonar.forceAuthentication` is off — it says yes
 * about credentials it never checked. `api/user_tokens/search` resolves a user
 * or 401s, and it tells us in the same call whether our token names already
 * exist.
 */
async function authWorks(client: SonarClient, auth: SonarAuth): Promise<boolean> {
	const response = await client.request({
		method: 'GET',
		path: 'api/user_tokens/search',
		auth
	});
	return ok(response);
}

async function tokenWorks(client: SonarClient, token: string): Promise<boolean> {
	return authWorks(client, { kind: 'token', token });
}

function ok(response: SonarResponse): boolean {
	return response.status >= 200 && response.status < 300;
}

function readString(body: unknown, key: string): string | undefined {
	if (typeof body !== 'object' || body === null) {
		return undefined;
	}
	const value = (body as Record<string, unknown>)[key];
	return typeof value === 'string' && value.length > 0 ? value : undefined;
}
