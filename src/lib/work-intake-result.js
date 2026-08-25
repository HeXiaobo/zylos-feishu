import { createHash } from 'node:crypto';

const OPTION_FIELDS = new Set([
  'sendConfirmationCard',
  'sendTaskReceipt',
  'startAssistantResponse',
]);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireSuccess(result, operation) {
  if (!result?.success) throw new Error(result?.message || `${operation} failed`);
  return result;
}

/**
 * Interpret Core WorkIntake results behind one delivery Interface. Confirm
 * decisions deliberately remain deliverable on a Core replay; callers attach
 * the stable deliveryKey to Feishu's UUID so a crash-safe retry converges on
 * the same card instead of suppressing the only confirmation opportunity.
 */
export function createWorkIntakeResultHandler(input) {
  const options = requireRecord(input, 'WorkIntake result handler options');
  const keys = Object.keys(options);
  if (keys.length !== OPTION_FIELDS.size || keys.some((key) => !OPTION_FIELDS.has(key))) {
    throw new TypeError('WorkIntake result handler options contain unsupported or missing fields');
  }
  for (const field of OPTION_FIELDS) {
    if (typeof options[field] !== 'function') throw new TypeError(`${field} must be a function`);
  }

  return Object.freeze({
    async handle(response, context) {
      const workIntake = response?.workIntake;
      if (!workIntake) return Object.freeze({ handled: false });
      const request = requireRecord(context, 'WorkIntake result context');
      if (workIntake.decision === 'chat_only') {
        const requestId = requireText(
          response?.assistantResponse?.requestId,
          'WorkIntake assistant response requestId',
        );
        const expectedRequest = requireRecord(
          request.assistantRequest,
          'WorkIntake assistant request',
        );
        if (requestId !== requireText(expectedRequest.requestId, 'WorkIntake assistant requestId')) {
          throw new Error('WorkIntake assistant response requestId mismatch');
        }
        const result = await options.startAssistantResponse({ requestId, context: request });
        requireSuccess(result, 'WorkIntake assistant response start');
        return Object.freeze({ handled: true, replayed: Boolean(workIntake.replayed) });
      }
      if (workIntake.decision === 'create_task') {
        const sourceKey = requireText(workIntake.sourceKey, 'WorkIntake sourceKey');
        const deliveryKey = `${sourceKey}:task-receipt`;
        const result = await options.sendTaskReceipt({
          title: requireText(workIntake.taskDraft?.title, 'WorkIntake task title'),
          deliveryKey,
          deliveryUuid: `zwi_${createHash('sha256')
            .update(deliveryKey)
            .digest('hex')
            .slice(0, 40)}`,
          context: request,
        });
        requireSuccess(result, 'WorkIntake task receipt delivery');
        return Object.freeze({ handled: true, replayed: Boolean(workIntake.replayed) });
      }
      if (workIntake.decision !== 'confirm') {
        return Object.freeze({ handled: false });
      }
      const sourceKey = requireText(workIntake.sourceKey, 'WorkIntake sourceKey');
      const { replayed: _replayed, ...decision } = workIntake;
      const result = await options.sendConfirmationCard({
        confirmation: {
          decision,
          inboundEnvelope: request.inboundEnvelope,
          endpoint: request.endpoint,
        },
        deliveryKey: `${sourceKey}:confirmation-card`,
        deliveryUuid: `zwi_${createHash('sha256')
          .update(`${sourceKey}:confirmation-card`)
          .digest('hex')
          .slice(0, 40)}`,
        context: request,
      });
      requireSuccess(result, 'WorkIntake confirmation delivery');
      return Object.freeze({ handled: true, replayed: Boolean(workIntake.replayed) });
    },
  });
}
