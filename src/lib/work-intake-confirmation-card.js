const ACTIONS = Object.freeze([
  Object.freeze({ action: 'work_intake_create_task', label: '创建任务', type: 'primary' }),
  Object.freeze({ action: 'work_intake_chat_only', label: '只当普通消息', type: 'default' }),
  Object.freeze({ action: 'work_intake_edit', label: '编辑', type: 'default' }),
]);
const ACTION_NAMES = new Set(ACTIONS.map((item) => item.action));
const RENDERER_OPTION_FIELDS = new Set(['issueContext', 'clock', 'contextTtlMs']);
const RENDER_INPUT_FIELDS = new Set(['decision', 'inboundEnvelope', 'endpoint']);
const DECISION_FIELDS = new Set([
  'decision',
  'reasonCode',
  'intentRevision',
  'sourceKey',
  'taskDraft',
]);
const ENVELOPE_FIELDS = new Set([
  'source',
  'sender',
  'text',
  'intentRevision',
  'receivedAt',
  'timeZone',
  'people',
]);
const CALLBACK_ACTION_FIELDS = new Set(['tag', 'value']);
const CALLBACK_VALUE_FIELDS = new Set(['action', 'context']);
const MAX_CARD_BYTES = 30_000;
const MAX_CONTEXT_TTL_MS = 24 * 60 * 60_000;

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

function requireText(value, field, maxLength = 4_000) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  if (Array.from(value).length > maxLength) throw new TypeError(`${field} is too long`);
  return value;
}

function normalizeDecision(input) {
  const decision = requireRecord(input, 'WorkIntake decision');
  requireExactFields(decision, DECISION_FIELDS, 'WorkIntake decision');
  if (decision.decision !== 'confirm') throw new TypeError('WorkIntake decision must require confirmation');
  if (!Number.isSafeInteger(decision.intentRevision) || decision.intentRevision < 1) {
    throw new TypeError('WorkIntake intentRevision must be a positive integer');
  }
  requireRecord(decision.taskDraft, 'WorkIntake TaskDraft');
  return decision;
}

function normalizeEnvelope(input) {
  const envelope = requireRecord(input, 'WorkIntake InboundEnvelope');
  requireExactFields(envelope, ENVELOPE_FIELDS, 'WorkIntake InboundEnvelope');
  if (envelope.intentRevision < 1 || !Number.isSafeInteger(envelope.intentRevision)) {
    throw new TypeError('InboundEnvelope intentRevision must be a positive integer');
  }
  return envelope;
}

function normalizeCallbackEvent(input) {
  const raw = requireRecord(input, 'Feishu WorkIntake callback');
  const event = raw.event && typeof raw.event === 'object' && !Array.isArray(raw.event)
    ? raw.event
    : raw;
  const actorId = requireText(
    event.operator?.open_id ?? event.open_id,
    'Feishu WorkIntake callback actorId',
    256,
  );
  const action = requireRecord(event.action, 'Feishu WorkIntake callback action');
  const normalizedAction = { tag: action.tag, value: action.value };
  requireExactFields(normalizedAction, CALLBACK_ACTION_FIELDS, 'Feishu WorkIntake callback action');
  if (normalizedAction.tag !== 'button') throw new TypeError('WorkIntake callback must be a button');
  const value = requireRecord(normalizedAction.value, 'Feishu WorkIntake callback value');
  requireExactFields(value, CALLBACK_VALUE_FIELDS, 'Feishu WorkIntake callback value');
  const actionName = requireText(value.action, 'WorkIntake callback action name', 64);
  if (!ACTION_NAMES.has(actionName)) throw new TypeError('WorkIntake callback action is unsupported');
  return { actorId, action: actionName, context: requireText(value.context, 'WorkIntake callback context', 8_192) };
}

function button(definition, context) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: definition.label },
    type: definition.type,
    behaviors: [{
      type: 'callback',
      value: { action: definition.action, context },
    }],
  };
}

export function createWorkIntakeConfirmationCardRenderer(input) {
  const options = requireRecord(input, 'WorkIntake confirmation renderer options');
  requireExactFields(options, RENDERER_OPTION_FIELDS, 'WorkIntake confirmation renderer options');
  if (typeof options.issueContext !== 'function') throw new TypeError('issueContext must be a function');
  if (typeof options.clock !== 'function') throw new TypeError('clock must be a function');
  if (!Number.isSafeInteger(options.contextTtlMs)
    || options.contextTtlMs < 1
    || options.contextTtlMs > MAX_CONTEXT_TTL_MS) {
    throw new TypeError(`contextTtlMs must be between 1 and ${MAX_CONTEXT_TTL_MS}`);
  }

  return Object.freeze({
    render(input) {
      const request = requireRecord(input, 'WorkIntake confirmation render input');
      requireExactFields(request, RENDER_INPUT_FIELDS, 'WorkIntake confirmation render input');
      const decision = normalizeDecision(request.decision);
      const envelope = normalizeEnvelope(request.inboundEnvelope);
      if (decision.intentRevision !== envelope.intentRevision) {
        throw new TypeError('WorkIntake decision and envelope revisions do not match');
      }
      const now = options.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('clock must return Unix epoch milliseconds');
      const context = options.issueContext({
        channel: envelope.source.channel,
        messageId: envelope.source.messageId,
        intentRevision: envelope.intentRevision,
        sourceKey: decision.sourceKey,
        senderId: envelope.sender.id,
        endpoint: requireText(request.endpoint, 'WorkIntake confirmation endpoint', 2_000),
        expiresAt: now + options.contextTtlMs,
      });
      const card = {
        schema: '2.0',
        config: { update_multi: true, width_mode: 'fill' },
        header: {
          template: 'orange',
          title: { tag: 'plain_text', content: '这条消息要创建任务吗？' },
        },
        body: {
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'plain_text',
                content: [
                  `任务：${decision.taskDraft.title}`,
                  `原因：${decision.reasonCode}`,
                  `负责人/验收人：${decision.taskDraft.ownerId}`,
                  `执行人：${decision.taskDraft.assigneeId ?? '未分配'}`,
                  decision.taskDraft.dueText ? `期限：${decision.taskDraft.dueText}` : null,
                ].filter(Boolean).join('\n'),
              },
            },
            ...ACTIONS.map((definition) => button(definition, context)),
          ],
        },
      };
      if (Buffer.byteLength(JSON.stringify(card), 'utf8') > MAX_CARD_BYTES) {
        throw new TypeError('WorkIntake confirmation card exceeds the size limit');
      }
      return card;
    },
  });
}

export function parseWorkIntakeConfirmationAction(input, { verifyContext }) {
  if (typeof verifyContext !== 'function') throw new TypeError('verifyContext must be a function');
  const callback = normalizeCallbackEvent(input);
  const claims = verifyContext(callback.context);
  if (callback.actorId !== claims.senderId) {
    const error = new Error('only the original human sender may confirm this WorkIntake');
    error.code = 'FORBIDDEN';
    throw error;
  }
  const action = callback.action.replace('work_intake_', '');
  return Object.freeze({
    kind: 'work-intake-confirmation',
    action,
    actorId: callback.actorId,
    claims,
    confirmationRequest: Object.freeze({
      sourceKey: claims.sourceKey,
      action,
      actorId: callback.actorId,
    }),
  });
}

export function isWorkIntakeConfirmationAction(input) {
  const event = input?.event && typeof input.event === 'object' ? input.event : input;
  return ACTION_NAMES.has(event?.action?.value?.action);
}

export function createWorkIntakeConfirmationRuntime({ verifyContext, executeDecision }) {
  if (typeof verifyContext !== 'function') throw new TypeError('verifyContext must be a function');
  if (typeof executeDecision !== 'function') throw new TypeError('executeDecision must be a function');
  return Object.freeze({
    async handle(input) {
      const route = parseWorkIntakeConfirmationAction(input, { verifyContext });
      const result = await executeDecision(route);
      return { route, result };
    },
  });
}
