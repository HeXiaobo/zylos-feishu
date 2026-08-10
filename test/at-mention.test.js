import test from 'node:test';
import assert from 'node:assert/strict';

import { convertAtMentionsForCard } from '../src/lib/at-mention.js';

// Feishu's two @-mention syntaxes are not interchangeable:
//   text        <at user_id="ou_xxx">Display Name</at>
//   interactive <at id=ou_xxx></at>
// send.js routes any markdown-bearing message down the card path, so a
// text-format mention reaches a builder that renders it as literal text and
// delivers no notification. These cover the conversion that fixes that.

test('converts the documented double-quoted text form to card form', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id="ou_abc123">张三</at> 看一下'),
    '<at id=ou_abc123></at> 看一下',
  );
});

test('converts a single-quoted id', () => {
  // The naive double-quote-only pattern leaves this untouched, i.e. the mention
  // stays silently broken — the exact failure being fixed.
  assert.equal(
    convertAtMentionsForCard("<at user_id='ou_abc123'>张三</at>"),
    '<at id=ou_abc123></at>',
  );
});

test('converts a bare (unquoted) id', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id=ou_abc123>张三</at>'),
    '<at id=ou_abc123></at>',
  );
});

test('converts when other attributes sit beside user_id', () => {
  assert.equal(
    convertAtMentionsForCard('<at class="x" user_id="ou_1" data-k="v">Bob</at>'),
    '<at id=ou_1></at>',
  );
});

test('converts every mention in a message, not just the first', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id="ou_1">A</at> and <at user_id="ou_2">B</at>'),
    '<at id=ou_1></at> and <at id=ou_2></at>',
  );
});

test('a display name containing a newline still terminates at its own </at>', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id="ou_1">two\nlines</at> tail'),
    '<at id=ou_1></at> tail',
  );
});

test('the @all sentinel is carried through like any other id', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id="all">所有人</at>'),
    '<at id=all></at>',
  );
});

test('an empty display name is fine (the name is dropped either way)', () => {
  assert.equal(convertAtMentionsForCard('<at user_id="ou_1"></at>'), '<at id=ou_1></at>');
});

test('is idempotent — already-card-format tags are left alone', () => {
  const card = '<at id=ou_abc123></at> hello';
  assert.equal(convertAtMentionsForCard(card), card);
  assert.equal(convertAtMentionsForCard(convertAtMentionsForCard(card)), card);
});

test('an empty user_id is left as-is rather than emitting <at id=></at>', () => {
  const broken = '<at user_id="">nobody</at>';
  assert.equal(convertAtMentionsForCard(broken), broken);
});

// --- code spans -----------------------------------------------------------
// Conversion is a concession to the card API's syntax; it must not rewrite
// quoted code. A message documenting the mention syntax is the obvious case,
// and it is one the naive pattern silently corrupts.

test('does NOT convert inside a fenced code block', () => {
  const doc = '语法：\n```html\n<at user_id="ou_xxx">Name</at>\n```\n以上';
  assert.equal(convertAtMentionsForCard(doc), doc);
});

test('does NOT convert inside an inline code span', () => {
  const doc = 'text 用 `<at user_id="ou_x">N</at>` 这种写法';
  assert.equal(convertAtMentionsForCard(doc), doc);
});

test('converts a real mention while leaving a documented one in code alone', () => {
  assert.equal(
    convertAtMentionsForCard('<at user_id="ou_real">R</at> 见 `<at user_id="ou_doc">D</at>`'),
    '<at id=ou_real></at> 见 `<at user_id="ou_doc">D</at>`',
  );
});

test('an unterminated fence does not disable conversion for the rest', () => {
  // A stray ``` must not swallow the remainder and silently stop converting.
  assert.equal(
    convertAtMentionsForCard('``` oops\n<at user_id="ou_1">A</at>'),
    '``` oops\n<at id=ou_1></at>',
  );
});

// --- pass-through ---------------------------------------------------------

test('leaves ordinary text untouched', () => {
  const plain = 'no mentions here, just prose with a < and a > sign';
  assert.equal(convertAtMentionsForCard(plain), plain);
});

test('handles empty and non-string input without throwing', () => {
  assert.equal(convertAtMentionsForCard(''), '');
  assert.equal(convertAtMentionsForCard(null), null);
  assert.equal(convertAtMentionsForCard(undefined), undefined);
});
