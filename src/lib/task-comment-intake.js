async function defaultLoadModules() {
  const [storeModule, eventModule] = await Promise.all([
    import('./task-comment-store.js'),
    import('./task-comment-event.js'),
  ]);
  return {
    openTaskCommentStore: storeModule.openTaskCommentStore,
    createTaskCommentEventHandlers: eventModule.createTaskCommentEventHandlers,
  };
}

/** Lazy production assembly so disabled ordinary chat never loads SQLite. */
export async function initializeTaskCommentIntake({
  enabled,
  appId,
  dbPath,
  onError,
  loadModules = defaultLoadModules,
} = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('Task comment intake enabled must be boolean');
  if (!enabled) return Object.freeze({ store: null, eventHandlers: Object.freeze({}) });
  if (typeof loadModules !== 'function') throw new TypeError('Task comment module loader must be a function');
  const modules = await loadModules();
  if (typeof modules?.openTaskCommentStore !== 'function') {
    throw new TypeError('Task comment store module is unavailable');
  }
  if (typeof modules?.createTaskCommentEventHandlers !== 'function') {
    throw new TypeError('Task comment event module is unavailable');
  }
  const store = modules.openTaskCommentStore({ dbPath });
  try {
    const eventHandlers = modules.createTaskCommentEventHandlers({ appId, store, onError });
    return Object.freeze({ store, eventHandlers });
  } catch (error) {
    store.close();
    throw error;
  }
}
