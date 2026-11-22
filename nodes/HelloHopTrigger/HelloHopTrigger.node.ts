import { createHmac, timingSafeEqual } from 'node:crypto';
import type {
	IDataObject,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';

/** Lowercase hex HMAC-SHA256 of the raw body, compared in constant time. */
export function isFromHelloHop(rawBody: Buffer, signature: string, secret: string): boolean {
	const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
	const given = Buffer.from(signature);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export class HelloHopTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HelloHop Trigger',
		name: 'helloHopTrigger',
		icon: { light: 'file:hellohop.svg', dark: 'file:hellohop.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description: 'Starts a workflow when HelloHop delivers a signed WhatsApp event',
		defaults: { name: 'HelloHop Trigger' },
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: 'helloHopApi', required: true }],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'hellohop',
			},
		],
		properties: [
			{
				displayName:
					'Copy the webhook URL above and set it as a receiver on your channel in HelloHop, with the same secret you saved as Webhook Secret in the credential. See the README for the exact request.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				default: ['message'],
				description:
					'Only these event types start the workflow. Other events are answered 200 and dropped.',
				options: [
					{ name: 'Group Participants', value: 'group.participants' },
					{ name: 'Message', value: 'message' },
					{ name: 'Message Status', value: 'message.status' },
					{ name: 'Session Status', value: 'session.status' },
				],
			},
			{
				displayName: 'Ignore Messages From Me',
				name: 'ignoreFromMe',
				type: 'boolean',
				default: false,
				description:
					'Whether to drop message events your own number sent, for example from the paired phone. Useful for chatbots.',
			},
		],
	};

	// HelloHop replaces the whole receiver list on every PUT, so this node never edits it. The
	// user sets the receiver once (README has the request); these hooks only report it as present.
	webhookMethods = {
		default: {
			async checkExists(): Promise<boolean> {
				return true;
			},
			async create(): Promise<boolean> {
				return true;
			},
			async delete(): Promise<boolean> {
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const res = this.getResponseObject();
		const reject = (): IWebhookResponseData => {
			res.status(401).json({ error: 'invalid signature' });
			return { noWebhookResponse: true };
		};

		const stored = await this.getCredentials('helloHopApi');
		const key = String(stored.webhookSecret ?? '');
		const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
		const header = req.headers['x-hellohop-signature'];
		const signature = typeof header === 'string' ? header : '';

		// Fail closed: a missing key, raw body or signature is a rejection.
		if (!key || !Buffer.isBuffer(rawBody) || !signature) return reject();
		if (!isFromHelloHop(rawBody, signature, key)) return reject();

		let envelope: IDataObject;
		try {
			envelope = JSON.parse(rawBody.toString('utf8')) as IDataObject;
		} catch {
			// Signed but not JSON: acknowledge so HelloHop does not retry it for two days.
			return { webhookResponse: 'ignored' };
		}

		const events = this.getNodeParameter('events', []) as string[];
		if (!events.includes(String(envelope.type))) return { webhookResponse: 'ignored' };

		const payload = (envelope.payload ?? {}) as IDataObject;
		if (
			envelope.type === 'message' &&
			payload.from_me === true &&
			(this.getNodeParameter('ignoreFromMe', false) as boolean)
		) {
			return { webhookResponse: 'ignored' };
		}

		// No deduplication here. A retry carries the same envelope id; dedupe on it downstream.
		return { workflowData: [this.helpers.returnJsonArray(envelope)] };
	}
}
