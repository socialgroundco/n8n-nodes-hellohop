import type { IDataObject, IExecuteFunctions, IHttpRequestMethods } from 'n8n-workflow';

/**
 * What a write did, in one word:
 * - sent: the API accepted the send (200)
 * - queued: accepted for later sending (202)
 * - done: a non-send write succeeded
 * - retry_later: refused before anything happened; retry after the hint
 * - unknown: the write may or may not have applied. Do not resend blindly.
 * - failed: refused for good; fix the request
 */
export type Outcome = 'sent' | 'queued' | 'done' | 'retry_later' | 'unknown' | 'failed';

export interface Classified {
	outcome: Outcome;
	retryAfterSeconds?: number;
	replayed?: boolean;
}

export interface ApiResult {
	statusCode: number;
	body: IDataObject;
	headers: IDataObject;
	/** Set when no response arrived (timeout or dropped connection). */
	networkError?: string;
}

// A 503 with these codes is documented as refused before anything was sent.
const REFUSED_BEFORE_SEND = new Set([
	'upstream_unavailable',
	'operator_unresolved',
	'hopsmart_settings_unavailable',
]);

function headerValue(headers: IDataObject, name: string): string | undefined {
	for (const header of Object.keys(headers)) {
		if (header.toLowerCase() === name) return String(headers[header]);
	}
	return undefined;
}

function retryAfter(result: ApiResult): number | undefined {
	const fromHeader = Number(headerValue(result.headers, 'retry-after'));
	if (Number.isFinite(fromHeader) && fromHeader > 0) return fromHeader;
	const fromBody = Number(result.body.retry_after);
	return Number.isFinite(fromBody) && fromBody > 0 ? fromBody : undefined;
}

/** Map one API answer to an outcome. `kind` says whether the write was a message send. */
export function classify(result: ApiResult, kind: 'send' | 'write'): Classified {
	if (result.networkError) return { outcome: 'unknown' };
	const { statusCode, body } = result;
	const replayed = headerValue(result.headers, 'idempotent-replayed') === 'true';
	const code = typeof body.code === 'string' ? body.code : '';
	const ok = kind === 'send' ? 'sent' : 'done';

	if (statusCode === 200 || statusCode === 201) return { outcome: ok, replayed };
	if (statusCode === 202) return { outcome: 'queued', replayed };
	if (statusCode === 429) return { outcome: 'retry_later', retryAfterSeconds: retryAfter(result) };
	if (statusCode === 503) {
		if (body.ambiguous === true) return { outcome: 'unknown' };
		if (body.ambiguous === false || REFUSED_BEFORE_SEND.has(code)) {
			return { outcome: 'retry_later', retryAfterSeconds: retryAfter(result) };
		}
		return { outcome: 'unknown' };
	}
	if (statusCode === 504) return { outcome: 'unknown' };
	if (statusCode === 409 && code === 'idempotency_uncertain') return { outcome: 'unknown' };
	// A failed upload to WhatsApp is documented as "nothing was sent, safe to retry".
	if (statusCode === 502 && code === 'media_upload_failed') return { outcome: 'retry_later' };
	// Other 5xx on a write: it may already have applied.
	if (statusCode >= 500) return { outcome: 'unknown' };
	return { outcome: 'failed' };
}

export function describeError(result: ApiResult): string {
	if (result.networkError) return `No response from HelloHop (${result.networkError})`;
	const code = typeof result.body.code === 'string' ? `${result.body.code}: ` : '';
	const text = typeof result.body.error === 'string' ? result.body.error : 'request failed';
	return `HelloHop answered ${result.statusCode}, ${code}${text}`;
}

/** Encode a path part but keep the `@` of a JID readable. */
export function encodePart(value: string): string {
	return encodeURIComponent(value).replace(/%40/g, '@');
}

/** One call to the HelloHop API. Never throws on an HTTP status; returns it for classification. */
export async function hellohopRequest(
	context: IExecuteFunctions,
	method: IHttpRequestMethods,
	path: string,
	options: { body?: IDataObject; qs?: IDataObject; headers?: IDataObject; timeoutMs?: number } = {},
): Promise<ApiResult> {
	const credentials = await context.getCredentials('helloHopApi');
	const base = String(credentials.baseUrl || 'https://api.hellohop.app/v1').replace(/\/+$/, '');
	const channel = encodePart(String(credentials.channelId));
	try {
		const response = (await context.helpers.httpRequestWithAuthentication.call(
			context,
			'helloHopApi',
			{
				method,
				url: `${base}/sessions/${channel}${path}`,
				body: options.body,
				qs: options.qs,
				headers: options.headers,
				json: true,
				returnFullResponse: true,
				ignoreHttpStatusErrors: true,
				timeout: options.timeoutMs ?? 30000,
			},
		)) as { statusCode: number; body?: unknown; headers?: IDataObject };
		const body =
			response.body && typeof response.body === 'object' ? (response.body as IDataObject) : {};
		return { statusCode: response.statusCode, body, headers: response.headers ?? {} };
	} catch (error) {
		// No HTTP answer at all: a timeout or a dropped connection. The outcome is not known.
		const err = error as { code?: string; message?: string };
		return {
			statusCode: 0,
			body: {},
			headers: {},
			networkError: err.code ?? err.message ?? 'error',
		};
	}
}

/** A phone number becomes digits only; a JID (contains `@`) is kept as is. */
export function normalizeRecipient(value: string): string {
	const trimmed = value.trim();
	return trimmed.includes('@') ? trimmed : trimmed.replace(/[\s+()-]/g, '');
}

/** Accepts a comma or newline separated string, or an array. Removes blanks and repeats. */
export function toList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map(String) : String(value ?? '').split(/[,\n]/);
	const seen = new Set<string>();
	for (const entry of raw) {
		const normalized = normalizeRecipient(entry);
		if (normalized) seen.add(normalized);
	}
	return [...seen];
}

export function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Deterministic key from a user field. An empty field means no key (an ordinary send).
 * The item index keeps two items with the same value apart inside one run.
 */
export function buildIdempotencyKey(
	userValue: string,
	itemIndex: number,
	withIndex: boolean,
): string | undefined {
	const base = userValue.trim();
	if (!base) return undefined;
	const key = withIndex ? `n8n-${base}-${itemIndex}` : `n8n-${base}`;
	return key.slice(0, 255);
}
