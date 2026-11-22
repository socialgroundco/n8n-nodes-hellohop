# n8n-nodes-hellohop

n8n community nodes for [HelloHop](https://hellohop.app), a WhatsApp API gateway. Send messages, read conversations, manage groups and start workflows from signed webhook events.

Nodes: **HelloHop** (actions) and **HelloHop Trigger** (webhook trigger). One credential: **HelloHop API**.

## Install

In n8n, open **Settings > Community Nodes > Install** and enter `n8n-nodes-hellohop`. See the [n8n guide to community nodes](https://docs.n8n.io/integrations/community-nodes/installation-and-management).

## Credentials

Create a **HelloHop API** credential:

| Field | What to enter |
|---|---|
| Base URL | `https://api.hellohop.app/v1` (default) |
| Channel ID | The ID of the channel (one WhatsApp number) the nodes act on |
| API Key | A channel key, or an account key. Both are sent as a bearer token. |
| Webhook Secret | Only for the trigger: the secret you set on the webhook receiver (24 characters or more) |

The credential test reads the channel state (`GET /sessions/{channel}`). It sends nothing.

## HelloHop node

| Resource | Operation | What it does |
|---|---|---|
| Message | Send Text | Sends a text, with an optional quoted message and idempotency key |
| Message | Send Media | Sends an image, video, audio, voice note or document from a public URL |
| Conversation | Read | Reads one chat, newest first, with `limit` (1 to 500) and `before` |
| Group | Create | Creates a group with a subject and up to 50 participants |
| Group | Add Participants | Adds people in batches of 50, one output item per person |
| Group | Remove Participants | Removes people in batches of 50, one output item per person |

### Send outcomes

Every send and write returns a normalized `outcome`:

| outcome | Meaning |
|---|---|
| `sent` | The API accepted the send (200). `id` and `status` are in the output. |
| `queued` | Accepted for later sending (202). The result arrives as a `message.status` event. |
| `done` | A group create, add or remove succeeded. |
| `retry_later` | Refused before anything happened (429, or a 503 that says nothing was sent). `retryAfterSeconds` is set when the API gives one. |
| `unknown` | The write may have applied (504, a 409 `idempotency_uncertain`, an ambiguous 503, a timeout). Check before sending again. |
| `failed` | Refused for good. Fix the request. |

`sent`, `queued` and `done` pass through as normal items. The other outcomes fail the item and name the outcome in the error message. With **Continue On Fail** on, they come out as an item with `outcome`, `statusCode`, `code` and `error`.

### Idempotency

Set **Options > Idempotency Key** to a value that repeats when the same send repeats, for example `{{ $json.order_id }}`. The node sends the header `Idempotency-Key: n8n-<value>-<item index>` (turn off **Add Item Index to Key** to drop the index). A repeat within 24 hours returns the original result with `replayed: true` and sends nothing. With no value, no key is sent and a repeat sends again.

Use a key if you turn on n8n's **Retry On Fail**. Without one, a retry after an `unknown` outcome can send twice.

## HelloHop Trigger

Starts a workflow for `message`, `message.status`, `group.participants` or `session.status` events. It checks every delivery before the workflow runs:

- `X-HelloHop-Signature` is the lowercase hex HMAC-SHA256 of the raw request body, keyed with your receiver secret. The node compares it in constant time over the raw bytes.
- A missing or wrong signature, or a missing secret, is answered 401 and starts nothing.
- Events you did not select, and the `webhook.test` event, are answered 200 and dropped.
- The node does not deduplicate. A retry carries the same envelope `id`; deduplicate on it downstream.

The node does not change your receivers on HelloHop, because saving receivers replaces the whole list. Set the receiver once with the webhook URL shown on the trigger (use the Production URL for an active workflow):

```bash
curl -X PUT "https://api.hellohop.app/v1/sessions/<CHANNEL_ID>/webhooks" \
  -H "Authorization: Bearer <API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"receivers":[{"url":"<N8N_WEBHOOK_URL>","events":["message","message.status"],"secret":"<WEBHOOK_SECRET>"}]}'
```

Include your other receivers in the list. Then send a signed test event. The trigger answers 200 and does not start the workflow, so a `delivered` answer confirms the URL and secret:

```bash
curl -X POST "https://api.hellohop.app/v1/sessions/<CHANNEL_ID>/webhooks/test" \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"url":"<N8N_WEBHOOK_URL>"}'
```

## Example workflows

- **Order updates:** a Shopify or WooCommerce trigger feeds HelloHop > Send Text, with the order number as the idempotency key. See [shipping updates](https://hellohop.app/use-cases/whatsapp-order-shipping-updates-shopify-woocommerce).
- **Auto reply:** HelloHop Trigger (message, ignore messages from me) > IF on `payload.text` > HelloHop > Send Text with `quoted` set to `payload.id`. See [support auto reply](https://hellohop.app/use-cases/whatsapp-support-auto-reply-business-hours).
- **Chatbot:** HelloHop Trigger > an AI node > Send Text. See [AI chatbot](https://hellohop.app/use-cases/whatsapp-ai-chatbot-chatgpt-claude).
- **Sheet to group:** a Google Sheets row feeds Group > Add Participants, then a filter on `ok` is false lists who was not added. See [Google Sheets automation](https://hellohop.app/use-cases/whatsapp-google-sheets-automation) and the [group API](https://hellohop.app/use-cases/whatsapp-group-api).

Message and add only people who agreed to hear from you.

More use cases: https://hellohop.app. Full API reference: https://hellohop.app/docs

## Development

```bash
npm install
npm run lint
npm run build
npm test   # starts a Prism mock of the API spec, runs the tests, stops it
```

## License

[MIT](LICENSE)
