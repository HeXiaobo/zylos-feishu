import { extractInteractiveImageKeys, extractInteractiveText } from './card-text.js';
import { getInteractiveCardContent } from './message.js';

// Call only after the existing DM/group access checks have passed.
export async function readInteractiveCard(messageId, client, eventContent = {}) {
  const card = await getInteractiveCardContent(messageId, { client });
  if (!card.success) {
    return { text: extractInteractiveText(eventContent), imageKeys: [] };
  }
  return {
    text: extractInteractiveText(card.content),
    imageKeys: extractInteractiveImageKeys(card.content),
  };
}
