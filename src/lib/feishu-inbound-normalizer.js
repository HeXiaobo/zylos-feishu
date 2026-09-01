import { createHash } from 'node:crypto';

const DEFAULT_EVENT_TYPE = 'im.message.receive_v1';
const MAX_TEXT_LENGTH = 1024 * 1024;

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field, maximum = 512) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  const text = value.trim();
  if (Array.from(text).length > maximum) throw new TypeError(`${field} is too long`);
  return text;
}

function optionalText(value, field, maximum = 512) {
  if (value === undefined || value === null || value === '') return null;
  return requireText(value, field, maximum);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function sha256(value) {
  const serialized = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(serialized).digest('hex')}`;
}

function stableId(prefix, fields) {
  const digest = createHash('sha256').update(fields.join('\u0000')).digest('hex');
  return `${prefix}:${digest}`;
}

function opaqueRef(prefix, value) {
  if (value === null) return null;
  return `${prefix}:v1:${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
}

function walkPost(nodes, textParts, attachmentFacts) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (Array.isArray(node)) {
      walkPost(node, textParts, attachmentFacts);
      continue;
    }
    if (!node || typeof node !== 'object') continue;
    if (node.tag === 'text' && typeof node.text === 'string') textParts.push(node.text);
    if (node.tag === 'a' && typeof node.text === 'string') textParts.push(node.text);
    if (node.tag === 'img' && node.image_key) {
      attachmentFacts.push({ kind: 'image', key: String(node.image_key) });
    }
    if (node.content) walkPost(node.content, textParts, attachmentFacts);
  }
}

function parseContent(message) {
  let parsed;
  try {
    parsed = JSON.parse(message.content || '{}');
  } catch {
    throw new TypeError('Feishu inbound message.message.content must be valid JSON');
  }
  requireRecord(parsed, 'Feishu inbound message.message.content');
  if (message.message_type === 'text') {
    return { text: String(parsed.text ?? ''), attachmentFacts: [] };
  }
  if (message.message_type === 'post') {
    const textParts = [];
    const attachmentFacts = [];
    if (parsed.title) textParts.push(`[${parsed.title}]`);
    walkPost(parsed.content, textParts, attachmentFacts);
    return { text: textParts.join(' ').trim() || '[post message]', attachmentFacts };
  }
  if (message.message_type === 'image' && parsed.image_key) {
    return {
      text: '[image]',
      attachmentFacts: [{ kind: 'image', key: String(parsed.image_key) }],
    };
  }
  if (['file', 'audio', 'media', 'sticker'].includes(message.message_type)) {
    const key = parsed.file_key || parsed.image_key;
    const name = parsed.file_name ? String(parsed.file_name) : null;
    return {
      text: name ? `[${message.message_type}: ${name}]` : `[${message.message_type}]`,
      attachmentFacts: key ? [{ kind: message.message_type, key: String(key), name }] : [],
    };
  }
  return {
    text: `[${message.message_type || 'unknown'} message]`,
    attachmentFacts: [],
  };
}

function normalizeIssuedAt(data, clock) {
  const raw = data.create_time ?? data._timestamp ?? data.header?.create_time;
  const milliseconds = raw === undefined || raw === null || raw === ''
    ? clock()
    : Number(raw);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError('Feishu inbound message create time must be Unix epoch milliseconds');
  }
  return new Date(milliseconds).toISOString();
}

function laneKey({ accountRef, chatType, chatId, threadId, rootId }) {
  const prefix = ['feishu', accountRef, chatType, chatId].map(encodeURIComponent).join(':');
  if (threadId) return `${prefix}:thread:${encodeURIComponent(threadId)}`;
  if ((chatType === 'group' || chatType === 'topic_group') && rootId) {
    return `${prefix}:reply:${encodeURIComponent(rootId)}`;
  }
  return `${prefix}:chat`;
}

/** Normalize authenticated Feishu facts without applying Core context policy. */
export function normalizeFeishuInboundMessage(data, {
  accountRef,
  eventId: explicitEventId = null,
  eventType: explicitEventType = null,
  sourceOrder = null,
  clock = Date.now,
  priority = 2,
} = {}) {
  const input = requireRecord(data, 'Feishu inbound message');
  const message = requireRecord(input.message, 'Feishu inbound message.message');
  const sender = requireRecord(input.sender, 'Feishu inbound message.sender');
  const normalizedAccountRef = requireText(accountRef, 'Feishu accountRef');
  const eventId = requireText(
    explicitEventId || input.event_id || input.header?.event_id,
    'Feishu inbound eventId',
  );
  const eventType = requireText(
    explicitEventType || input.header?.event_type || DEFAULT_EVENT_TYPE,
    'Feishu inbound eventType',
  );
  const messageId = requireText(message.message_id, 'Feishu inbound message.message_id');
  const chatId = requireText(message.chat_id, 'Feishu inbound message.chat_id');
  const chatType = requireText(message.chat_type, 'Feishu inbound message.chat_type');
  if (!['p2p', 'group', 'topic_group'].includes(chatType)) {
    throw new TypeError(`unsupported Feishu chat type: ${chatType}`);
  }
  const threadId = optionalText(message.thread_id, 'Feishu inbound message.thread_id');
  const rootId = optionalText(message.root_id, 'Feishu inbound message.root_id');
  const parentId = optionalText(message.parent_id, 'Feishu inbound message.parent_id');
  const upperMessageId = optionalText(
    message.upper_message_id,
    'Feishu inbound message.upper_message_id',
  );
  const actorId = requireText(
    sender.sender_id?.open_id || sender.sender_id?.user_id || sender.sender_id?.union_id,
    'Feishu inbound sender identity',
  );
  const { text, attachmentFacts } = parseContent(message);
  if (Array.from(text).length > MAX_TEXT_LENGTH) {
    throw new TypeError('Feishu inbound message content is too long');
  }
  if (!Number.isSafeInteger(priority)) throw new TypeError('priority must be an integer');

  const conversationLaneKey = laneKey({
    accountRef: normalizedAccountRef,
    chatType,
    chatId,
    threadId,
    rootId,
  });
  const route = { chatType, chatId, messageId, threadId, rootId, parentId };
  const platformFacts = {
    chatType,
    chatId,
    messageId,
    threadId,
    rootId,
    parentId,
    upperMessageId,
    sender: { externalId: actorId, tenantRef: sender.tenant_key || normalizedAccountRef },
    content: { kind: 'text', text },
    mentions: Array.isArray(message.mentions) ? message.mentions : [],
    attachments: attachmentFacts,
  };
  const payloadHash = sha256(platformFacts);
  const logicalFields = ['feishu', normalizedAccountRef, eventType, messageId];
  const threadRef = opaqueRef('feishu-thread', threadId);
  const rootRef = opaqueRef('feishu-root', rootId);
  const parentRef = opaqueRef('feishu-message', parentId);
  const mentionRefs = (Array.isArray(message.mentions) ? message.mentions : []).map((mention) => (
    opaqueRef('feishu-mention', {
      key: mention?.key || null,
      name: mention?.name || null,
      externalId: mention?.id?.open_id || mention?.id?.user_id || mention?.id?.union_id || null,
    })
  ));
  const attachmentRefs = attachmentFacts.map((attachment) => (
    opaqueRef('feishu-attachment', attachment)
  ));

  return Object.freeze({
    adapterId: 'feishu',
    accountRef: normalizedAccountRef,
    eventType,
    eventId,
    messageId,
    payloadHash,
    conversationLaneKey,
    sourceOrder,
    message: Object.freeze({
      schemaVersion: 1,
      type: 'AcceptMessage',
      commandId: stableId('cmd:feishu', logicalFields),
      idempotencyKey: ['feishu', normalizedAccountRef, eventType, eventId].join(':'),
      traceId: stableId('trace:feishu', logicalFields),
      causationId: eventId,
      issuedAt: normalizeIssuedAt(input, clock),
      source: Object.freeze({
        adapterId: 'feishu',
        accountRef: normalizedAccountRef,
        targetRef: opaqueRef('feishu-source', route),
        conversationKey: opaqueRef('feishu-conversation', {
          chatType, chatId, threadId, rootId,
        }),
        messageId,
        eventId,
        eventType,
        payloadHash,
      }),
      actor: Object.freeze({
        provider: 'feishu',
        tenantRef: sender.tenant_key || normalizedAccountRef,
        externalId: actorId,
      }),
      content: Object.freeze({ kind: 'text', text }),
      contextHints: Object.freeze({
        threadRef,
        rootRef,
        parentRef,
        quoteRefs: parentRef ? [parentRef] : [],
        mentionRefs,
        attachmentRefs,
        platformHistoryRefs: [],
      }),
      reply: Object.freeze({
        mode: 'required',
        targetRef: opaqueRef('feishu-route', route),
      }),
      policy: Object.freeze({ priority, requireIdle: false }),
    }),
  });
}
