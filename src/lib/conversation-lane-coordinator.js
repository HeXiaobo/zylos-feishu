function requireText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, field, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${field} must be a positive integer no greater than ${maximum}`);
  }
  return value;
}

/**
 * Bound Core durable-accept work globally while allowing only one active item
 * per Conversation Lane. Submission order is the FIFO order for each lane.
 */
export function createConversationLaneCoordinator({ concurrency = 4 } = {}) {
  requirePositiveInteger(concurrency, 'Conversation Lane concurrency', 100);
  const lanes = new Map();
  const readyLanes = [];
  let active = 0;
  let pumpScheduled = false;

  function schedulePump() {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(pump);
  }

  function finish(laneKey, item, error, result) {
    active -= 1;
    const lane = lanes.get(laneKey);
    lane.active = false;
    lane.activeSequence = null;
    if (error) item.reject(error);
    else item.resolve(result);
    if (lane.queue.length > 0) readyLanes.push(laneKey);
    else lanes.delete(laneKey);
    schedulePump();
  }

  function pump() {
    pumpScheduled = false;
    while (active < concurrency && readyLanes.length > 0) {
      const laneKey = readyLanes.shift();
      const lane = lanes.get(laneKey);
      if (!lane || lane.active || lane.queue.length === 0) continue;
      const item = lane.queue.shift();
      lane.active = true;
      lane.activeSequence = item.laneSequence;
      active += 1;
      Promise.resolve()
        .then(item.run)
        .then(
          (result) => finish(laneKey, item, null, result),
          (error) => finish(laneKey, item, error),
        );
    }
  }

  return Object.freeze({
    submit(acceptance, run) {
      if (!acceptance || typeof acceptance !== 'object' || Array.isArray(acceptance)) {
        throw new TypeError('Conversation Lane acceptance must be an object');
      }
      const conversationLaneKey = requireText(
        acceptance.conversationLaneKey,
        'Conversation Lane key',
      );
      const laneSequence = requirePositiveInteger(
        acceptance.laneSequence,
        'Conversation Lane sequence',
      );
      if (typeof run !== 'function') throw new TypeError('Conversation Lane work must be a function');
      let lane = lanes.get(conversationLaneKey);
      if (!lane) {
        lane = { active: false, activeSequence: null, queue: [] };
        lanes.set(conversationLaneKey, lane);
      }
      const predecessorSequence = lane.queue.at(-1)?.laneSequence ?? lane.activeSequence;
      if (predecessorSequence !== null && laneSequence <= predecessorSequence) {
        throw new TypeError('Conversation Lane submissions must have increasing laneSequence');
      }
      const promise = new Promise((resolve, reject) => {
        lane.queue.push({ laneSequence, run, resolve, reject });
      });
      if (!lane.active && lane.queue.length === 1) {
        readyLanes.push(conversationLaneKey);
      }
      schedulePump();
      return promise;
    },
  });
}
