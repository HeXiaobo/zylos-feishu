/**
 * Decide whether an outgoing text should be sent as an interactive card.
 *
 * Kept in its own module so the rule is unit-testable: scripts/send.js runs a
 * CLI at import time, so importing it from a test would execute the sender.
 */

/**
 * Check if text contains markdown formatting worth rendering as a card.
 * Returns true for code blocks, headers, bold, lists, tables, etc.
 */
export function hasMarkdownContent(text) {
  // Code blocks (``` or indented)
  if (/```/.test(text)) return true;
  // Headers (# at start of line)
  if (/^#{1,6}\s/m.test(text)) return true;
  // Bold (**text**)
  if (/\*\*[^*]+\*\*/.test(text)) return true;
  // Bullet or numbered lists (- item or 1. item at start of line)
  if (/^[\s]*[-*]\s/m.test(text) || /^[\s]*\d+\.\s/m.test(text)) return true;
  // Tables (| col | col |)
  if (/\|.+\|/.test(text) && /^[\s]*\|[\s]*[-:]+/m.test(text)) return true;
  return false;
}

/**
 * Should this text be sent as an interactive card?
 *
 * - message.useMarkdownCard is the master switch, as before
 * - then either message.alwaysCard === true (send everything as a card, even
 *   plain text) or the text actually contains markdown worth rendering
 *
 * alwaysCard defaults to false, so an unset config behaves exactly as before.
 */
export function shouldUseCard(messageConfig, text) {
  if (!messageConfig?.useMarkdownCard) return false;
  if (messageConfig?.alwaysCard === true) return true;
  return hasMarkdownContent(text);
}
