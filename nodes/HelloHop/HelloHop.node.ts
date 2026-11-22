import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import type { ApiResult, Classified } from './GenericFunctions';
import {
	buildIdempotencyKey,
	chunk,
	classify,
	describeError,
	encodePart,
	hellohopRequest,
	normalizeRecipient,
	toList,
} from './GenericFunctions';

const BATCH_SIZE = 50;

export class HelloHop implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'HelloHop',
		name: 'helloHop',
		icon: { light: 'file:hellohop.svg', dark: 'file:hellohop.dark.svg' },
		group: ['output'],
		version: 1,
		subtitle: '={{$parameter["resource"] + ": " + $parameter["operation"]}}',
		description: 'Send WhatsApp messages and manage groups through HelloHop',
		defaults: { name: 'HelloHop' },
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		usableAsTool: true,
		credentials: [{ name: 'helloHopApi', required: true }],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Conversation', value: 'conversation' },
					{ name: 'Group', value: 'group' },
					{ name: 'Message', value: 'message' },
				],
				default: 'message',
			},

			// Message
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{ name: 'Send Media', value: 'sendMedia', action: 'Send media' },
					{ name: 'Send Text', value: 'sendText', action: 'Send a text message' },
				],
				default: 'sendText',
			},
			{
				displayName: 'To',
				name: 'to',
				type: 'string',
				required: true,
				default: '',
				placeholder: '66XXXXXXXXX',
				description: 'Phone number with country code, or a JID',
				displayOptions: { show: { resource: ['message'] } },
			},
			{
				displayName: 'Text',
				name: 'text',
				type: 'string',
				typeOptions: { rows: 4 },
				required: true,
				default: '',
				displayOptions: { show: { resource: ['message'], operation: ['sendText'] } },
			},
			{
				displayName: 'Media Type',
				name: 'mediaType',
				type: 'options',
				default: 'image',
				options: [
					{ name: 'Audio', value: 'audio' },
					{ name: 'Document', value: 'document' },
					{ name: 'Image', value: 'image' },
					{ name: 'Video', value: 'video' },
					{ name: 'Voice Note', value: 'voice' },
				],
				displayOptions: { show: { resource: ['message'], operation: ['sendMedia'] } },
			},
			{
				displayName: 'Media URL',
				name: 'url',
				type: 'string',
				required: true,
				default: '',
				description: 'A public address HelloHop fetches the file from',
				displayOptions: { show: { resource: ['message'], operation: ['sendMedia'] } },
			},
			{
				displayName: 'Caption',
				name: 'caption',
				type: 'string',
				default: '',
				description: 'Shown under an image, video or document',
				displayOptions: {
					show: { resource: ['message'], operation: ['sendMedia'], mediaType: ['image', 'video', 'document'] },
				},
			},
			{
				displayName: 'Options',
				name: 'options',
				type: 'collection',
				placeholder: 'Add option',
				default: {},
				displayOptions: { show: { resource: ['message'] } },
				options: [
					{
						displayName: 'Idempotency Key',
						name: 'idempotencyKey',
						type: 'string',
						default: '',
						placeholder: '={{ $json.order_id }}',
						description:
							'A value that is the same each time this send is repeated, such as an order number. Left empty, no key is sent and a repeat sends again.',
					},
					{
						displayName: 'Add Item Index to Key',
						name: 'keyWithIndex',
						type: 'boolean',
						default: true,
						description:
							'Whether to append the item index so two items with the same key value in one run stay separate',
					},
					{
						displayName: 'Quoted Message ID',
						name: 'quoted',
						type: 'string',
						default: '',
						description: 'Send the text as a reply to this message ID (Send Text only)',
					},
				],
			},

			// Conversation
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['conversation'] } },
				options: [{ name: 'Read', value: 'read', action: 'Read a conversation' }],
				default: 'read',
			},
			{
				displayName: 'Chat',
				name: 'chat',
				type: 'string',
				required: true,
				default: '',
				placeholder: '66XXXXXXXXX',
				description: 'Phone number with country code, or a chat JID such as a group JID',
				displayOptions: { show: { resource: ['conversation'] } },
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				typeOptions: { minValue: 1, maxValue: 500 },
				default: 50,
				description: 'Max number of results to return',
				displayOptions: { show: { resource: ['conversation'] } },
			},
			{
				displayName: 'Before',
				name: 'before',
				type: 'string',
				default: '',
				description: 'The next_before value of the previous page, exactly as returned',
				displayOptions: { show: { resource: ['conversation'] } },
			},
			{
				displayName: 'Split Messages Into Items',
				name: 'split',
				type: 'boolean',
				default: false,
				description:
					'Whether to output one item per message instead of one item for the page. One item for the page keeps next_before.',
				displayOptions: { show: { resource: ['conversation'] } },
			},

			// Group
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['group'] } },
				options: [
					{ name: 'Add Participants', value: 'addParticipants', action: 'Add participants to a group' },
					{ name: 'Create', value: 'create', action: 'Create a group' },
					{
						name: 'Remove Participants',
						value: 'removeParticipants',
						action: 'Remove participants from a group',
					},
				],
				default: 'create',
			},
			{
				displayName: 'Subject',
				name: 'subject',
				type: 'string',
				required: true,
				default: '',
				description: 'The group name, 1 to 25 characters',
				displayOptions: { show: { resource: ['group'], operation: ['create'] } },
			},
			{
				displayName: 'Group ID',
				name: 'group',
				type: 'string',
				required: true,
				default: '',
				placeholder: '120363000000000001@g.us',
				displayOptions: {
					show: { resource: ['group'], operation: ['addParticipants', 'removeParticipants'] },
				},
			},
			{
				displayName: 'Participants',
				name: 'participants',
				type: 'string',
				default: '',
				placeholder: '66XXXXXXXXX, 66YYYYYYYYY',
				description:
					'Phone numbers or JIDs, separated by commas or new lines. Create allows at most 50. Add and Remove send batches of 50.',
				displayOptions: { show: { resource: ['group'] } },
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const out: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const pair = { item: i };

				if (resource === 'message') {
					const result = await sendMessage(this, i, operation);
					out.push(...finish(this, result, 'send', i));
				} else if (resource === 'conversation') {
					out.push(...(await readConversation(this, i)));
				} else if (resource === 'group' && operation === 'create') {
					const body: IDataObject = { subject: this.getNodeParameter('subject', i) as string };
					const people = toList(this.getNodeParameter('participants', i, ''));
					if (people.length > BATCH_SIZE) {
						throw new NodeOperationError(
							this.getNode(),
							`A group can be created with at most ${BATCH_SIZE} participants. Create it, then add the rest.`,
							{ itemIndex: i },
						);
					}
					if (people.length) body.participants = people;
					out.push(...finish(this, await hellohopRequest(this, 'POST', '/groups', { body }), 'write', i));
				} else if (resource === 'group') {
					out.push(...(await changeParticipants(this, i, operation === 'addParticipants' ? 'add' : 'remove')));
				} else {
					throw new NodeOperationError(this.getNode(), `Unknown operation: ${resource}/${operation}`, {
						itemIndex: i,
					});
				}
				void pair;
			} catch (error) {
				if (this.continueOnFail()) {
					out.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof NodeApiError) {
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}

async function sendMessage(ctx: IExecuteFunctions, i: number, operation: string): Promise<ApiResult> {
	const options = ctx.getNodeParameter('options', i, {}) as IDataObject;
	const to = normalizeRecipient(ctx.getNodeParameter('to', i) as string);
	if (!to) throw new NodeOperationError(ctx.getNode(), 'To is empty', { itemIndex: i });

	let body: IDataObject;
	if (operation === 'sendText') {
		body = { type: 'text', to, text: ctx.getNodeParameter('text', i) as string };
		if (options.quoted) body.quoted = String(options.quoted);
	} else {
		const mediaType = ctx.getNodeParameter('mediaType', i) as string;
		body = { type: 'media', media_type: mediaType, to, url: ctx.getNodeParameter('url', i) as string };
		if (['image', 'video', 'document'].includes(mediaType)) {
			const caption = ctx.getNodeParameter('caption', i, '') as string;
			if (caption) body.caption = caption;
		}
	}

	const headers: IDataObject = {};
	const key = buildIdempotencyKey(
		String(options.idempotencyKey ?? ''),
		i,
		options.keyWithIndex !== false,
	);
	if (key) headers['Idempotency-Key'] = key;
	return hellohopRequest(ctx, 'POST', '/messages', { body, headers });
}

async function readConversation(ctx: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	let chat = normalizeRecipient(ctx.getNodeParameter('chat', i) as string);
	if (!chat) throw new NodeOperationError(ctx.getNode(), 'Chat is empty', { itemIndex: i });
	if (!chat.includes('@')) chat = `${chat}@s.whatsapp.net`;
	const qs: IDataObject = { limit: ctx.getNodeParameter('limit', i) as number };
	const before = ctx.getNodeParameter('before', i, '') as string;
	if (before) qs.before = before;

	const result = await hellohopRequest(ctx, 'GET', `/chats/${encodePart(chat)}/messages`, { qs });
	if (result.statusCode !== 200) return finish(ctx, result, 'write', i);
	if (ctx.getNodeParameter('split', i, false) as boolean) {
		const messages = (result.body.messages as IDataObject[]) ?? [];
		return messages.map((message) => ({ json: message, pairedItem: { item: i } }));
	}
	return [{ json: result.body, pairedItem: { item: i } }];
}

async function changeParticipants(
	ctx: IExecuteFunctions,
	i: number,
	action: 'add' | 'remove',
): Promise<INodeExecutionData[]> {
	const group = (ctx.getNodeParameter('group', i) as string).trim();
	const people = toList(ctx.getNodeParameter('participants', i, ''));
	if (!group || !people.length) {
		throw new NodeOperationError(ctx.getNode(), 'Group ID and at least one participant are required', {
			itemIndex: i,
		});
	}

	const rows: INodeExecutionData[] = [];
	const person = (jid: string, fields: IDataObject): INodeExecutionData => ({
		json: { group, action, jid, ...fields },
		pairedItem: { item: i },
	});
	const batches = chunk(people, BATCH_SIZE);

	for (let b = 0; b < batches.length; b++) {
		const result = await hellohopRequest(ctx, 'POST', `/groups/${encodePart(group)}/participants`, {
			body: { action, participants: batches[b] },
		});
		const verdict = classify(result, 'write');
		if (verdict.outcome === 'done') {
			const results = (result.body.results as IDataObject[]) ?? [];
			const byJid = new Map(results.map((r) => [String(r.jid), r]));
			for (const jid of batches[b]) {
				const r = byJid.get(jid);
				if (!r) {
					rows.push(person(jid, { batch: b, ok: false, status: 'unknown', outcome: 'unknown' }));
					continue;
				}
				const status = String(r.status);
				rows.push(person(jid, { ...r, jid, batch: b, ok: status === 'ok', outcome: status === 'ok' ? 'done' : status === 'unknown' ? 'unknown' : 'failed' }));
			}
			continue;
		}
		// The whole batch failed. A hard 4xx is a request problem, so fail the item.
		if (verdict.outcome === 'failed') return finish(ctx, result, 'write', i);
		const status = verdict.outcome === 'unknown' ? 'unknown' : 'not_applied';
		for (const jid of batches[b]) {
			rows.push(
				person(jid, {
					batch: b,
					ok: false,
					status,
					outcome: verdict.outcome,
					error: describeError(result),
					...(verdict.retryAfterSeconds ? { retryAfterSeconds: verdict.retryAfterSeconds } : {}),
				}),
			);
		}
		// Stop here: later batches would pile onto an unknown or throttled state.
		for (const later of batches.slice(b + 1).flat()) {
			rows.push(person(later, { ok: false, status: 'not_attempted', outcome: 'retry_later' }));
		}
		break;
	}
	return rows;
}

/** Turn one API answer into an output item, or fail the item when the write did not succeed. */
function finish(
	ctx: IExecuteFunctions,
	result: ApiResult,
	kind: 'send' | 'write',
	i: number,
): INodeExecutionData[] {
	const verdict: Classified = classify(result, kind);
	if (verdict.outcome === 'sent' || verdict.outcome === 'queued' || verdict.outcome === 'done') {
		const json: IDataObject = { ...result.body, outcome: verdict.outcome };
		if (verdict.replayed) json.replayed = true;
		return [{ json, pairedItem: { item: i } }];
	}

	const message = `${describeError(result)}. Outcome: ${verdict.outcome}.`;
	const failure: IDataObject = {
		outcome: verdict.outcome,
		statusCode: result.statusCode,
		code: (result.body.code as string) ?? null,
		error: describeError(result),
	};
	if (verdict.retryAfterSeconds) failure.retryAfterSeconds = verdict.retryAfterSeconds;
	if (verdict.outcome === 'unknown') {
		failure.hint = 'The write may have applied. Check before sending it again.';
	}
	if (ctx.continueOnFail()) return [{ json: failure, pairedItem: { item: i } }];
	throw new NodeApiError(ctx.getNode(), { ...failure, message } as unknown as JsonObject, {
		message,
		httpCode: String(result.statusCode),
		itemIndex: i,
	});
}
