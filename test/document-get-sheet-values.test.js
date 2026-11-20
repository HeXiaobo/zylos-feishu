/**
 * Tests for getSheetValues throwOnError in src/lib/document.js
 *
 * Uses Node built-in test runner (node:test).
 * Run: node --test test/document-get-sheet-values.test.js
 *
 * No network: the SDK client is replaced through the module's test injection
 * point, so credentials are never read and no request leaves the process.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSheetValues,
  _setClientFactoryForTest,
  SHEET_RANGE_OUT_OF_BOUNDS_CODE,
} from '../src/lib/document.js';

// ---------- helpers ----------

const TOKEN = 'shtcnTestToken';
const RANGE = 'SUOFkP!A1:D10';

/**
 * Install a fake SDK client whose request() resolves with `response` or
 * rejects with `failure`. Records every request it receives.
 */
function installClient({ response, failure } = {}) {
  const calls = [];
  _setClientFactoryForTest(() => ({
    request: async (req) => {
      calls.push(req);
      if (failure) throw failure;
      return response;
    },
  }));
  return calls;
}

// ---------- fixtures ----------

const OK_RESPONSE = {
  code: 0,
  msg: 'success',
  data: {
    valueRange: {
      range: RANGE,
      values: [['name', 'qty'], ['apple', '3']],
    },
  },
};

const API_ERROR_RESPONSE = {
  code: 1310213,
  msg: 'spreadsheet not found',
  data: {},
};

const RANGE_OUT_OF_BOUNDS_RESPONSE = {
  code: 900015206,
  msg: 'range exceeds the sheet boundary',
  data: {},
};

// ---------- tests ----------

describe('getSheetValues default behavior (unchanged)', () => {
  afterEach(() => _setClientFactoryForTest(null));

  it('success path still returns { success, range, values }', async () => {
    installClient({ response: OK_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE);

    assert.equal(result.success, true);
    assert.equal(result.range, RANGE);
    assert.deepEqual(result.values, [['name', 'qty'], ['apple', '3']]);
  });

  it('API error returns { success: false } with the API code and never throws', async () => {
    installClient({ response: API_ERROR_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE);

    assert.equal(result.success, false);
    assert.equal(result.code, 1310213);
    assert.match(result.message, /spreadsheet not found/);
  });

  it('transport failure returns { success: false } with the message and never throws', async () => {
    const boom = new Error('socket hang up');
    boom.code = 'ECONNRESET';
    installClient({ failure: boom });

    const result = await getSheetValues(TOKEN, RANGE);

    assert.equal(result.success, false);
    assert.equal(result.message, 'socket hang up');
    assert.equal(result.code, undefined, 'default shape must not grow a code field');
  });

  it('900015206 without throwOnError keeps the historical failure shape', async () => {
    installClient({ response: RANGE_OUT_OF_BOUNDS_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE);

    assert.equal(result.success, false);
    assert.equal(result.code, SHEET_RANGE_OUT_OF_BOUNDS_CODE);
  });

  it('empty options object behaves like no options', async () => {
    installClient({ response: API_ERROR_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE, {});

    assert.equal(result.success, false);
    assert.equal(result.code, 1310213);
  });
});

describe('getSheetValues with { throwOnError: true }', () => {
  afterEach(() => _setClientFactoryForTest(null));

  it('throws on a non-zero interface code and carries that code', async () => {
    installClient({ response: API_ERROR_RESPONSE });

    await assert.rejects(
      () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
      (err) => {
        assert.ok(err instanceof Error, 'must reject with an Error');
        assert.equal(err.code, 1310213, 'err.code must be the API code');
        assert.match(err.message, /spreadsheet not found/);
        return true;
      },
    );
  });

  it('throws on a transport failure and keeps the original error code', async () => {
    const boom = new Error('getaddrinfo ENOTFOUND open.feishu.cn');
    boom.code = 'ENOTFOUND';
    installClient({ failure: boom });

    await assert.rejects(
      () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
      (err) => {
        assert.equal(err, boom, 'the original error object must propagate');
        assert.equal(err.code, 'ENOTFOUND', 'the original code must be preserved');
        return true;
      },
    );
  });

  it('transport failure without a code still throws with a stable fallback code', async () => {
    installClient({ failure: new Error('timed out') });

    await assert.rejects(
      () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
      (err) => {
        assert.equal(err.message, 'timed out');
        assert.equal(err.code, 'E_SHEET_VALUES_REQUEST_FAILED');
        return true;
      },
    );
  });

  it('900015206 resolves as an empty table tail instead of throwing', async () => {
    installClient({ response: RANGE_OUT_OF_BOUNDS_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

    assert.equal(result.success, true, 'range out of bounds is not an error');
    assert.deepEqual(result.values, [], 'values must be an empty array');
  });

  it('900015206 reports the requested range when the response has none', async () => {
    installClient({ response: { code: SHEET_RANGE_OUT_OF_BOUNDS_CODE, msg: 'oob' } });

    const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

    assert.equal(result.success, true);
    assert.equal(result.range, RANGE);
    assert.deepEqual(result.values, []);
  });

  it('success path returns the same shape as the default', async () => {
    installClient({ response: OK_RESPONSE });

    const result = await getSheetValues(TOKEN, RANGE, { throwOnError: true });

    assert.equal(result.success, true);
    assert.equal(result.range, RANGE);
    assert.deepEqual(result.values, [['name', 'qty'], ['apple', '3']]);
  });

  it('only 900015206 is tolerated: other range errors still throw', async () => {
    installClient({ response: { code: 1310214, msg: 'invalid range' } });

    await assert.rejects(
      () => getSheetValues(TOKEN, RANGE, { throwOnError: true }),
      (err) => {
        assert.equal(err.code, 1310214);
        return true;
      },
    );
  });
});

describe('getSheetValues request shape', () => {
  beforeEach(() => _setClientFactoryForTest(null));
  afterEach(() => _setClientFactoryForTest(null));

  it('keeps the same URL and render options as before', async () => {
    const calls = installClient({ response: OK_RESPONSE });

    await getSheetValues(TOKEN, RANGE, { throwOnError: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'GET');
    assert.equal(
      calls[0].url,
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(TOKEN)}/values/${encodeURIComponent(RANGE)}`,
    );
    assert.equal(calls[0].params.valueRenderOption, 'ToString');
    assert.equal(calls[0].params.dateTimeRenderOption, 'FormattedString');
  });
});
