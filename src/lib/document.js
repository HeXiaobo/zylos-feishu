/**
 * Feishu Document Functions
 */

import { getClient } from './client.js';

/**
 * Get document raw content
 * @param {string} documentId - Document ID (e.g., doccnXXXX)
 */
export async function getDocument(documentId) {
  const client = getClient();

  try {
    const res = await client.docx.document.rawContent({
      path: {
        document_id: documentId,
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        content: res.data.content,
      };
    } else {
      return {
        success: false,
        message: `Failed to get document: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Get wiki node info and content
 * @param {string} token - Wiki node token
 */
export async function getWikiNode(token) {
  const client = getClient();

  try {
    // Get wiki node info using space.getNode
    const res = await client.wiki.space.getNode({
      params: {
        token: token,
      },
    });

    if (res.code === 0) {
      const node = res.data.node;
      return {
        success: true,
        node: {
          spaceId: node?.space_id,
          nodeToken: node?.node_token,
          objToken: node?.obj_token,
          objType: node?.obj_type,
          title: node?.title,
          hasChild: node?.has_child,
          parentNodeToken: node?.parent_node_token,
          nodeType: node?.node_type,
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get wiki node: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Get spreadsheet info
 * @param {string} token - Spreadsheet token
 */
export async function getSpreadsheet(token) {
  const client = getClient();

  try {
    const res = await client.sheets.spreadsheet.get({
      path: {
        spreadsheet_token: token,
      },
    });

    if (res.code === 0) {
      const spreadsheet = res.data.spreadsheet;
      return {
        success: true,
        spreadsheet: {
          title: spreadsheet?.title,
          folderToken: spreadsheet?.folder_token,
          url: spreadsheet?.url,
          sheets: spreadsheet?.sheets?.map(s => ({
            sheetId: s.sheet_id,
            title: s.title,
            index: s.index,
          })),
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get spreadsheet: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Read spreadsheet data from a range
 * @param {string} token - Spreadsheet token
 * @param {string} sheetId - Sheet ID (e.g., SUOFkP)
 * @param {string} range - Range like "A1:D10" (optional, reads all if not specified)
 */
export async function readSheetData(token, sheetId, range = '') {
  // If range specified, delegate to getSheetValues for actual cell data
  if (range) {
    const rangeStr = `${sheetId}!${range}`;
    return getSheetValues(token, rangeStr);
  }

  // No range: return sheet metadata
  const client = getClient();

  try {
    const res = await client.sheets.spreadsheetSheet.query({
      path: {
        spreadsheet_token: token,
        sheet_id: sheetId,
      },
      params: {},
    });

    if (res.code === 0) {
      return {
        success: true,
        sheet: {
          sheetId: res.data.sheet?.sheet_id,
          title: res.data.sheet?.title,
          rowCount: res.data.sheet?.grid_properties?.row_count,
          columnCount: res.data.sheet?.grid_properties?.column_count,
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to read sheet: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Feishu API error code for "range goes past the sheet tail".
 * This is the only failure a reader may treat as an empty read.
 */
export const SHEET_RANGE_OUT_OF_BOUNDS_CODE = 900015206;

/**
 * Fallback code attached to a thrown getSheetValues failure that carries none.
 */
export const SHEET_VALUES_REQUEST_FAILED = 'E_SHEET_VALUES_REQUEST_FAILED';

let clientFactoryImpl = null; // test injection point

function resolveClient() {
  return clientFactoryImpl ? clientFactoryImpl() : getClient();
}

/**
 * Inject the client factory (for testing only).
 * Pass null to restore the real credential-backed client.
 */
export function _setClientFactoryForTest(fn) {
  clientFactoryImpl = fn;
}

/**
 * Get values from spreadsheet range using drive API
 * @param {string} token - Spreadsheet token
 * @param {string} range - Range like "SheetId!A1:D10"
 * @param {object} [options]
 * @param {boolean} [options.throwOnError=false] - Throw instead of returning
 *   `{ success: false }` when the read fails. The thrown error carries the API
 *   `code`, or the original error code on the transport path.
 *   Exception: with `throwOnError`, a range past the sheet tail (900015206)
 *   resolves as an empty tail instead of throwing.
 */
export async function getSheetValues(token, range, options = {}) {
  const { throwOnError = false } = options ?? {};
  const client = resolveClient();

  let res;
  try {
    // Use the valueRange API to get actual cell values
    res = await client.request({
      method: 'GET',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values/${encodeURIComponent(range)}`,
      params: {
        valueRenderOption: 'ToString',
        dateTimeRenderOption: 'FormattedString',
      },
    });
  } catch (err) {
    if (!throwOnError) {
      return { success: false, message: err.message };
    }
    // Preserve the original error (and its code) on the transport path.
    const error = err instanceof Error ? err : new Error(String(err));
    if (error.code === undefined) {
      error.code = SHEET_VALUES_REQUEST_FAILED;
    }
    throw error;
  }

  if (res?.code === 0) {
    return {
      success: true,
      range: res.data.valueRange?.range,
      values: res.data.valueRange?.values,
    };
  }

  // A range past the sheet tail is not a failure for a tolerant reader: it
  // reads as an empty tail. Default callers keep the historical failure shape.
  if (throwOnError && res?.code === SHEET_RANGE_OUT_OF_BOUNDS_CODE) {
    return {
      success: true,
      range: res.data?.valueRange?.range ?? range,
      values: [],
    };
  }

  const message = `Failed to get values: ${res?.msg}`;
  if (throwOnError) {
    const error = new Error(message);
    error.code = res?.code;
    throw error;
  }
  return {
    success: false,
    message,
    code: res?.code,
  };
}

/**
 * Copy a sheet within a spreadsheet
 * @param {string} token - Spreadsheet token
 * @param {string} sourceSheetId - Source sheet ID to copy from
 * @param {string} newTitle - Title for the new sheet
 */
export async function copySheet(token, sourceSheetId, newTitle) {
  const client = getClient();

  try {
    const res = await client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/sheets_batch_update`,
      data: {
        requests: [
          {
            copySheet: {
              source: {
                sheetId: sourceSheetId,
              },
              destination: {
                title: newTitle,
              },
            },
          },
        ],
      },
    });

    if (res.code === 0) {
      // Extract the new sheet ID from response
      const newSheetId = res.data?.replies?.[0]?.copySheet?.properties?.sheetId;
      return {
        success: true,
        sheetId: newSheetId,
        message: `Sheet copied successfully as "${newTitle}"`,
      };
    } else {
      return {
        success: false,
        message: `Failed to copy sheet: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Add a new empty sheet to a spreadsheet
 * @param {string} token - Spreadsheet token
 * @param {string} title - Title for the new sheet
 */
export async function addSheet(token, title) {
  const client = getClient();

  try {
    const res = await client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/sheets_batch_update`,
      data: {
        requests: [
          {
            addSheet: {
              properties: {
                title: title,
              },
            },
          },
        ],
      },
    });

    if (res.code === 0) {
      const newSheetId = res.data?.replies?.[0]?.addSheet?.properties?.sheetId;
      return {
        success: true,
        sheetId: newSheetId,
        message: `Sheet "${title}" added successfully`,
      };
    } else {
      return {
        success: false,
        message: `Failed to add sheet: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Move a sheet to a specific position
 * @param {string} token - Spreadsheet token
 * @param {string} sheetId - Sheet ID to move
 * @param {number} index - Target position (0 = first)
 */
export async function moveSheet(token, sheetId, index) {
  const client = getClient();

  try {
    const res = await client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/sheets_batch_update`,
      data: {
        requests: [
          {
            updateSheet: {
              properties: {
                sheetId: sheetId,
                index: index,
              },
            },
          },
        ],
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        message: `Sheet moved to position ${index}`,
      };
    } else {
      return {
        success: false,
        message: `Failed to move sheet: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Write values to spreadsheet range
 * @param {string} token - Spreadsheet token
 * @param {string} range - Range like "SheetId!A1:C1"
 * @param {Array<Array<string>>} values - 2D array of values
 */
export async function writeSheetValues(token, range, values) {
  const client = getClient();

  try {
    const res = await client.request({
      method: 'POST',
      url: `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(token)}/values_batch_update`,
      data: {
        valueRanges: [
          {
            range: range,
            values: values,
          },
        ],
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        message: `Values written to ${range}`,
        updatedCells: res.data.totalUpdatedCells,
      };
    } else {
      return {
        success: false,
        message: `Failed to write values: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Get document metadata
 * @param {string} documentId - Document ID
 */
export async function getDocumentInfo(documentId) {
  const client = getClient();

  try {
    const res = await client.docx.document.get({
      path: {
        document_id: documentId,
      },
    });

    if (res.code === 0) {
      return {
        success: true,
        info: {
          title: res.data.document?.title,
          revisionId: res.data.document?.revision_id,
        },
      };
    } else {
      return {
        success: false,
        message: `Failed to get document info: ${res.msg}`,
        code: res.code,
      };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}
