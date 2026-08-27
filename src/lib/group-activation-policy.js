/**
 * Decide whether an inbound message enters the group conversation path.
 * Smart mode preserves the legacy no-mention chat behavior, but task and
 * WorkIntake protocols remain mention-gated to avoid accidental task creation.
 */
export function decideGroupActivation({ chatType, mentionedBot, smartMode }) {
  if (chatType !== 'group') {
    return {
      process: true,
      smartMode: false,
      allowTaskIntake: true,
      showImmediateResponse: true,
    };
  }

  const mentioned = mentionedBot === true;
  const explicitSmartMode = smartMode === true;
  return {
    process: mentioned || explicitSmartMode,
    smartMode: !mentioned && explicitSmartMode,
    allowTaskIntake: mentioned,
    showImmediateResponse: mentioned,
  };
}
