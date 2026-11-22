import type {
	IAuthenticateGeneric,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

export class HelloHopApi implements ICredentialType {
	name = 'helloHopApi';

	displayName = 'HelloHop API';

	icon = 'file:hellohop.svg' as const;

	documentationUrl = 'https://github.com/socialgroundco/n8n-nodes-hellohop#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: 'https://api.hellohop.app/v1',
			description: 'The HelloHop API address, including /v1',
		},
		{
			displayName: 'Channel ID',
			name: 'channelId',
			type: 'string',
			default: '',
			required: true,
			description: 'The ID of the channel (one WhatsApp number) these nodes act on',
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'A channel key, or an account key. Both are sent as a bearer token.',
		},
		{
			displayName: 'Webhook Secret',
			name: 'webhookSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description:
				'Only for the HelloHop Trigger: the secret you set on the webhook receiver (at least 24 characters)',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.apiKey}}',
			},
		},
	};

	// Reads the channel state. It never sends anything.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl}}',
			url: '=/sessions/{{$credentials.channelId}}',
			method: 'GET',
		},
	};
}
