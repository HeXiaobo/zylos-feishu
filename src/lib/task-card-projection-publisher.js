import { createHash } from 'node:crypto';

import { createCardKitTaskCardDelivery } from './cardkit-task-card-delivery.js';
import { createTaskCardIdentityResolver } from './task-card-identity-resolver.js';
import { createTaskReviewCardRenderer } from './task-review-card.js';

const RECEIVE_ID_TYPES = new Set(['chat_id', 'open_id', 'user_id', 'union_id']);
const PUBLISHER_OPTION_FIELDS = Object.freeze([
  'sendMessage',
  'updateInteractiveCard',
  'issueTaskActionContext',
  'clock',
  'actionContextTtlMs',
  'resolveIdentityLabels',
]);
const SDK_OPTION_FIELDS = Object.freeze([
  'client',
  'issueTaskActionContext',
  'clock',
  'actionContextTtlMs',
  'agentLabels',
]);
const CREATE_REQUEST_FIELDS = Object.freeze(['target', 'task', 'idempotencyKey']);
const UPDATE_REQUEST_FIELDS = Object.freeze([
  'target',
  'externalId',
  'task',
  'idempotencyKey',
]);
const TARGET_FIELDS = Object.freeze(['receiveId', 'receiveIdType']);
const MAX_ID_LENGTH = 512;
const MAX_CARDKIT_SEQUENCE = 2_147_483_647;

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

function requireExactFields(value, fields, field) {
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(key => Object.hasOwn(value, key))) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireFieldsWithOptional(value, requiredFields, optionalFields, field) {
  const keys = Object.keys(value);
  if (
    requiredFields.some(key => !Object.hasOwn(value, key))
    || keys.some(key => !requiredFields.includes(key) && !optionalFields.includes(key))
  ) {
    throw new TypeError(`${field} contains unsupported or missing fields`);
  }
}

function requireBoundedText(value, field, maxLength = MAX_ID_LENGTH) {
  const text = requireText(value, field);
  if (Array.from(text).length > maxLength) {
    throw new TypeError(`${field} exceeds ${maxLength} characters`);
  }
  return text;
}

function stableFeishuUuid(idempotencyKey) {
  const key = requireBoundedText(idempotencyKey, 'idempotencyKey');
  return `ztc_${createHash('sha256').update(key).digest('hex').slice(0, 40)}`;
}

function taskVersionSequence(version) {
  if (
    !Number.isSafeInteger(version)
    || version < 1
    || version > Math.floor((MAX_CARDKIT_SEQUENCE - 9) / 10)
  ) {
    throw new TypeError('task.version cannot produce a positive 32-bit CardKit sequence');
  }
  return version * 10 + 9;
}

function isAlreadyAppliedSequence(response) {
  return response?.code === 300317
    && /sequence (?:number compare failed|is not increasing)/i.test(response?.msg || '');
}

function normalizeTarget(value) {
  const target = requireRecord(value, 'target');
  requireExactFields(target, TARGET_FIELDS, 'target');
  const receiveId = requireBoundedText(target.receiveId, 'target.receiveId');
  if (!RECEIVE_ID_TYPES.has(target.receiveIdType)) {
    throw new TypeError('target.receiveIdType is unsupported');
  }
  return { receiveId, receiveIdType: target.receiveIdType };
}

export function createTaskCardProjectionPublisher(input) {
  const options = requireRecord(input, 'task card projection publisher options');
  requireFieldsWithOptional(
    options,
    PUBLISHER_OPTION_FIELDS.filter(field => field !== 'resolveIdentityLabels'),
    ['resolveIdentityLabels'],
    'task card projection publisher options',
  );
  if (typeof options.sendMessage !== 'function') {
    throw new TypeError('sendMessage must be a function');
  }
  if (typeof options.updateInteractiveCard !== 'function') {
    throw new TypeError('updateInteractiveCard must be a function');
  }
  if (
    options.resolveIdentityLabels !== undefined
    && typeof options.resolveIdentityLabels !== 'function'
  ) {
    throw new TypeError('resolveIdentityLabels must be a function');
  }
  const renderer = createTaskReviewCardRenderer({
    issueTaskActionContext: options.issueTaskActionContext,
    clock: options.clock,
    actionContextTtlMs: options.actionContextTtlMs,
  });

  return Object.freeze({
    async createTask(input) {
      const request = requireRecord(input, 'create task projection request');
      requireExactFields(request, CREATE_REQUEST_FIELDS, 'create task projection request');
      const target = normalizeTarget(request.target);
      const identityLabels = await options.resolveIdentityLabels?.(request.task);
      const card = renderer.render(request.task, identityLabels);
      const result = await options.sendMessage(
        target.receiveId,
        card,
        target.receiveIdType,
        'interactive',
        {
          uuid: stableFeishuUuid(request.idempotencyKey),
          idempotencyKey: request.idempotencyKey,
          taskVersion: request.task.version,
        },
      );
      if (!result?.success) {
        throw new Error(result?.message || 'Feishu task card create failed');
      }
      return {
        externalId: requireText(result.messageId, 'Feishu task card messageId'),
      };
    },
    async updateTask(input) {
      const request = requireRecord(input, 'update task projection request');
      requireExactFields(request, UPDATE_REQUEST_FIELDS, 'update task projection request');
      normalizeTarget(request.target);
      const externalId = requireBoundedText(request.externalId, 'externalId');
      const identityLabels = await options.resolveIdentityLabels?.(request.task);
      const card = renderer.render(request.task, identityLabels);
      const result = await options.updateInteractiveCard(externalId, card, {
        uuid: stableFeishuUuid(request.idempotencyKey),
        sequence: taskVersionSequence(request.task.version),
      });
      if (!result?.success) {
        throw new Error(result?.message || 'Feishu task card update failed');
      }
      return { externalId };
    },
  });
}

export function createSdkTaskCardProjectionPublisher(input) {
  const options = requireRecord(input, 'SDK task card projection publisher options');
  requireFieldsWithOptional(
    options,
    SDK_OPTION_FIELDS.filter(field => field !== 'agentLabels'),
    ['agentLabels'],
    'SDK task card projection publisher options',
  );
  const client = requireRecord(options.client, 'client');
  const delivery = createCardKitTaskCardDelivery({ client });
  const identityResolver = createTaskCardIdentityResolver({
    client,
    agentLabels: options.agentLabels,
  });
  const sendMessage = async (receiveId, content, receiveIdType, msgType, sendOptions) => {
    if (msgType !== 'interactive') {
      throw new TypeError('task card message type must be interactive');
    }
    return delivery.send({
      target: { receiveId, receiveIdType },
      card: content,
      idempotencyKey: sendOptions.idempotencyKey,
      taskVersion: sendOptions.taskVersion,
    });
  };
  const updateInteractiveCard = async (messageId, card, updateOptions) => {
    const conversion = await client.cardkit.v1.card.idConvert({
      data: { message_id: messageId },
    });
    if (conversion?.code !== 0 || !conversion.data?.card_id) {
      return {
        success: false,
        message: conversion?.msg || 'Feishu card ID conversion failed',
        code: conversion?.code,
      };
    }
    const response = await client.cardkit.v1.card.update({
      path: { card_id: conversion.data.card_id },
      data: {
        card: { type: 'card_json', data: JSON.stringify(card) },
        uuid: updateOptions.uuid,
        sequence: updateOptions.sequence,
      },
    });
    // CardKit rejects an at-least-once replay after the first request already
    // advanced the card sequence. Under this Adapter's single-writer,
    // task-version-derived sequence contract, that rejection proves the same
    // version (or a newer one) already won and is safe to acknowledge.
    if (isAlreadyAppliedSequence(response)) {
      return { success: true, replayed: true };
    }
    if (response?.code !== 0) {
      return {
        success: false,
        message: response?.msg || 'Feishu task card update failed',
        code: response?.code,
      };
    }
    return { success: true };
  };
  return createTaskCardProjectionPublisher({
    sendMessage,
    updateInteractiveCard,
    issueTaskActionContext: options.issueTaskActionContext,
    clock: options.clock,
    actionContextTtlMs: options.actionContextTtlMs,
    resolveIdentityLabels: task => identityResolver.resolve(task),
  });
}
