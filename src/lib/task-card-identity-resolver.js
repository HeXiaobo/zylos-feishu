const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_MAX_ENTRIES = 512;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_CACHE_ENTRIES = 10_000;
const MAX_DISPLAY_NAME_LENGTH = 128;
const OPTION_FIELDS = new Set(['client', 'clock', 'ttlMs', 'maxEntries', 'agentLabels']);

function requireRecord(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function readableSuffix(identity) {
  return identity
    .slice(-6)
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .slice(-6) || '未知';
}

function readableFallback(identity, agentLabels = new Map()) {
  if (identity === null) return '未分配';
  if (identity.startsWith('agent:')) {
    return agentLabels.get(identity) ?? `AI 员工（…${readableSuffix(identity)}）`;
  }
  return `飞书成员（…${readableSuffix(identity)}）`;
}

function feishuIdType(identity) {
  if (identity.startsWith('ou_')) return 'open_id';
  if (identity.startsWith('on_')) return 'union_id';
  return 'user_id';
}

function normalizedName(value) {
  if (typeof value !== 'string') return null;
  const name = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (name === '' || Array.from(name).length > MAX_DISPLAY_NAME_LENGTH) return null;
  return name;
}

async function fetchDisplayName(client, identity) {
  try {
    const response = await client.contact.user.get({
      path: { user_id: identity },
      params: { user_id_type: feishuIdType(identity) },
    });
    if (response?.code === 0) {
      const name = normalizedName(response.data?.user?.name);
      if (name !== null) return name;
    }
  } catch {
    // Identity enrichment must never prevent the task card from being delivered.
  }
  return readableFallback(identity);
}

function normalizeOptions(input) {
  const options = requireRecord(input, 'task card identity resolver options');
  if (
    !Object.hasOwn(options, 'client')
    || Object.keys(options).some(key => !OPTION_FIELDS.has(key))
  ) {
    throw new TypeError('task card identity resolver options contain unsupported or missing fields');
  }
  const client = requireRecord(options.client, 'client');
  const clock = options.clock ?? Date.now;
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_TTL_MS) {
    throw new TypeError(`ttlMs must be an integer from 1 to ${MAX_TTL_MS}`);
  }
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > MAX_CACHE_ENTRIES) {
    throw new TypeError(`maxEntries must be an integer from 1 to ${MAX_CACHE_ENTRIES}`);
  }
  const rawAgentLabels = options.agentLabels ?? {};
  requireRecord(rawAgentLabels, 'agentLabels');
  const agentLabels = new Map(Object.entries(rawAgentLabels).map(([identity, label]) => {
    if (!identity.startsWith('agent:')) throw new TypeError(`agentLabels contains invalid identity: ${identity}`);
    const normalized = normalizedName(label);
    if (normalized === null) throw new TypeError(`agentLabels.${identity} must be a readable name`);
    return [identity, normalized];
  }));
  return { client, clock, ttlMs, maxEntries, agentLabels };
}

export function createTaskCardIdentityResolver(input) {
  const { client, clock, ttlMs, maxEntries, agentLabels } = normalizeOptions(input);
  const cache = new Map();
  const inFlight = new Map();

  function readNow() {
    const now = clock();
    if (!Number.isFinite(now) || now < 0) throw new TypeError('clock must return a timestamp');
    return now;
  }

  function readCached(identity, now) {
    const entry = cache.get(identity);
    if (!entry) return null;
    cache.delete(identity);
    if (entry.expiresAt <= now) return null;
    cache.set(identity, entry);
    return entry.label;
  }

  function writeCached(identity, label, now) {
    cache.delete(identity);
    while (cache.size >= maxEntries) {
      cache.delete(cache.keys().next().value);
    }
    cache.set(identity, { label, expiresAt: now + ttlMs });
  }

  async function resolveIdentity(identity) {
    if (identity === null) return '未分配';
    if (typeof identity !== 'string' || identity.trim() === '') return '未知成员';
    if (identity.startsWith('agent:')) return readableFallback(identity, agentLabels);

    const now = readNow();
    const cached = readCached(identity, now);
    if (cached !== null) return cached;
    const pending = inFlight.get(identity);
    if (pending) return pending;

    const lookup = fetchDisplayName(client, identity)
      .then((label) => {
        writeCached(identity, label, readNow());
        return label;
      })
      .finally(() => {
        inFlight.delete(identity);
      });
    if (inFlight.size < maxEntries) inFlight.set(identity, lookup);
    return lookup;
  }

  return Object.freeze({
    async resolve(task) {
      const value = requireRecord(task, 'task');
      const [owner, acceptor, assignee] = await Promise.all([
        resolveIdentity(value.ownerId),
        resolveIdentity(value.acceptorId),
        resolveIdentity(value.assigneeId),
      ]);
      return Object.freeze({ owner, acceptor, assignee });
    },
  });
}
