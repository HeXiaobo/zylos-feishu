const OPTION_FIELDS = new Set(['intentRevision', 'timeZone']);
const INPUT_FIELDS = new Set([
  'messageId',
  'chatId',
  'chatType',
  'threadId',
  'senderId',
  'text',
  'mentionedBot',
  'receivedAt',
  'mentions',
]);
const MENTION_FIELDS = new Set(['name', 'id', 'candidateIds', 'kind', 'isBot']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.size || keys.some((key) => !fields.has(key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeMention(input, index) {
  const mention = requireRecord(input, `mentions[${index}]`);
  requireExactFields(mention, MENTION_FIELDS, `mentions[${index}]`);
  if (typeof mention.isBot !== 'boolean') throw new TypeError(`mentions[${index}].isBot must be boolean`);
  if (!Array.isArray(mention.candidateIds)) throw new TypeError(`mentions[${index}].candidateIds must be an array`);
  return {
    name: requireText(mention.name, `mentions[${index}].name`),
    id: mention.id === null ? null : requireText(mention.id, `mentions[${index}].id`),
    candidateIds: [...new Set(mention.candidateIds.map((id) => requireText(id, `mentions[${index}].candidateIds`)))],
    kind: mention.kind === 'agent' ? 'agent' : 'human',
    isBot: mention.isBot,
  };
}

export function hasExactBotMention(mentions, { botOpenId, botAppId }) {
  if (!Array.isArray(mentions)) return false;
  const trustedIds = new Set([botOpenId, botAppId]
    .filter((id) => typeof id === 'string' && id !== '')
    .map(String));
  if (trustedIds.size === 0) return false;
  return mentions.some((mention) => {
    const mentionId = mention?.id?.open_id || mention?.id?.app_id || null;
    return mentionId !== null && trustedIds.has(String(mentionId));
  });
}

export function createFeishuWorkIntakeInboundAdapter(input) {
  const options = requireRecord(input, 'Feishu WorkIntake adapter options');
  requireExactFields(options, OPTION_FIELDS, 'Feishu WorkIntake adapter options');
  if (!Number.isSafeInteger(options.intentRevision) || options.intentRevision < 1) {
    throw new TypeError('intentRevision must be a positive integer');
  }
  requireText(options.timeZone, 'timeZone');

  return Object.freeze({
    toEnvelope(input) {
      const message = requireRecord(input, 'Feishu WorkIntake input');
      requireExactFields(message, INPUT_FIELDS, 'Feishu WorkIntake input');
      if (message.chatType !== 'p2p' && message.chatType !== 'group') {
        throw new TypeError('Feishu WorkIntake chatType is unsupported');
      }
      if (typeof message.mentionedBot !== 'boolean') {
        throw new TypeError('Feishu WorkIntake mentionedBot must be boolean');
      }
      if (message.chatType === 'group' && !message.mentionedBot) return null;
      if (!Array.isArray(message.mentions)) {
        throw new TypeError('Feishu WorkIntake mentions must be an array');
      }
      const people = message.mentions
        .map(normalizeMention)
        .filter((mention) => !mention.isBot)
        .map(({ name, id, candidateIds, kind }) => ({ name, id, candidateIds, kind }));
      return {
        source: {
          channel: 'feishu',
          messageId: requireText(message.messageId, 'Feishu WorkIntake messageId'),
          conversationId: requireText(message.chatId, 'Feishu WorkIntake chatId'),
          conversationType: message.chatType === 'p2p' ? 'direct' : 'group',
          threadId: message.threadId === null
            ? null
            : requireText(message.threadId, 'Feishu WorkIntake threadId'),
        },
        sender: {
          id: requireText(message.senderId, 'Feishu WorkIntake senderId'),
          kind: 'human',
        },
        text: requireText(message.text, 'Feishu WorkIntake text'),
        intentRevision: options.intentRevision,
        receivedAt: message.receivedAt === null
          ? null
          : requireText(message.receivedAt, 'Feishu WorkIntake receivedAt'),
        timeZone: options.timeZone,
        people,
      };
    },
  });
}
