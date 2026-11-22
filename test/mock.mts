import type { IExecuteFunctions, IWebhookFunctions } from 'n8n-workflow';

export interface Recorded {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: any;
}
export interface Canned {
	status: number;
	body?: unknown;
	headers?: Record<string, string>;
}
export interface Transport {
	prefer?: number; // ask Prism for this documented status
	canned?: Canned | ((req: Recorded) => Canned);
	fail?: string; // simulate no response, with this error code
	calls: Recorded[];
}

const BASE = process.env.PRISM_URL ?? 'http://127.0.0.1:4519';
const TEST_KEY = 'test-' + 'bearer';

export function executeContext(
	params: Record<string, unknown>[],
	transport: Transport,
	continueOnFail = false,
): IExecuteFunctions {
	const ctx = {
		getInputData: () => params.map(() => ({ json: {} })),
		getNodeParameter: (name: string, i: number, fallback?: unknown) =>
			name in params[i] ? params[i][name] : fallback,
		getCredentials: async () => ({ baseUrl: BASE, channelId: 'chan1', apiKey: TEST_KEY }),
		getNode: () => ({ name: 'HelloHop', type: 'helloHop', typeVersion: 1, id: 'x', position: [0, 0], parameters: {} }),
		continueOnFail: () => continueOnFail,
		helpers: {
			httpRequestWithAuthentication: async (_cred: string, o: any) => {
				const url = new URL(o.url);
				if (o.qs) for (const [k, v] of Object.entries(o.qs)) url.searchParams.set(k, String(v));
				const headers: Record<string, string> = {
					Authorization: `Bearer ${TEST_KEY}`,
					'Content-Type': 'application/json',
					...(o.headers ?? {}),
				};
				const rec: Recorded = { method: o.method, url: url.toString(), headers, body: o.body };
				transport.calls.push(rec);
				if (transport.fail) throw Object.assign(new Error('network'), { code: transport.fail });
				if (transport.canned) {
					const c = typeof transport.canned === 'function' ? transport.canned(rec) : transport.canned;
					return { statusCode: c.status, body: c.body ?? {}, headers: c.headers ?? {} };
				}
				if (transport.prefer) headers.Prefer = `code=${transport.prefer}`;
				const res = await fetch(url, {
					method: o.method,
					headers,
					body: o.body ? JSON.stringify(o.body) : undefined,
				});
				const text = await res.text();
				return {
					statusCode: res.status,
					body: text ? JSON.parse(text) : {},
					headers: Object.fromEntries(res.headers.entries()),
				};
			},
		},
	};
	return ctx as unknown as IExecuteFunctions;
}

export function webhookContext(opts: {
	rawBody?: Buffer;
	signature?: string;
	secret?: string;
	events?: string[];
	ignoreFromMe?: boolean;
}) {
	const out = { status: 0, sent: undefined as unknown };
	const res = {
		status(code: number) {
			out.status = code;
			return res;
		},
		json(body: unknown) {
			out.sent = body;
			return res;
		},
	};
	const ctx = {
		getRequestObject: () => ({
			rawBody: opts.rawBody,
			headers: opts.signature === undefined ? {} : { 'x-hellohop-signature': opts.signature },
		}),
		getResponseObject: () => res,
		getCredentials: async () => ({ webhookSecret: opts.secret ?? '' }),
		getNodeParameter: (name: string, fallback?: unknown) =>
			name === 'events' ? (opts.events ?? ['message']) : name === 'ignoreFromMe' ? !!opts.ignoreFromMe : fallback,
		helpers: { returnJsonArray: (j: unknown) => [{ json: j }] },
	};
	return { ctx: ctx as unknown as IWebhookFunctions, out };
}
