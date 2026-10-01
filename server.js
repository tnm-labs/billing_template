require("dotenv").config();
const express = require("express");
const path = require("path");
const { Readable } = require("stream");
const Anthropic = require("@anthropic-ai/sdk");
const multer = require("multer");
const { google } = require("googleapis");

const app = express();
app.set("trust proxy", true); // so req.ip is the real client IP behind Render/etc.
// 2mb was fine for the old {text} extraction payload, but a Seller Flex
// "all orders" CSV covering more than a few days can run to several MB
// once wrapped in a JSON body — raised so a bigger date-range export
// doesn't get silently rejected by Express before it reaches our handler.
app.use(express.json({ limit: "15mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const accessCode = process.env.ACCESS_CODE || ""; // optional shared team passcode

if (!apiKey) {
  console.warn("WARNING: ANTHROPIC_API_KEY is not set — /api/extract will return server_not_configured until it is.");
}
const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

// ---- tiny in-memory per-IP rate limiter (resets on restart; fine for a small internal tool) ----
// 20/min was too tight for real usage: a bulk .zip upload processes 2
// invoices at a time (see the client's worker pool), so a batch of
// several dozen invoices could burn through 20 extraction calls in well
// under a minute and start getting 429'd — which, before the client
// gained automatic retry-on-rate-limit, silently left several invoices
// out of a batch with no error the uploader would necessarily notice
// (confirmed: 11 of 49 genuine invoices in one real bulk upload). Raised
// to comfortably cover a 100-ish-invoice batch; a runaway bug would still
// be capped at a few dollars/minute of AI cost at this level, which is
// an acceptable trade-off for a small internal tool.
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 100;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > MAX_PER_WINDOW;
}

// ------------------------------------------------------------------
// Invoices tab — originally 31 fields mirroring "Invoice
// template_shailesh2.xlsx" column-for-column; CRM Order ID, Salesman, and
// Fitmate Date / Delivery Date were dropped at Manoj's request (2026-09-29,
// unused fields), leaving 28. Remaining labels are kept verbatim from that
// spreadsheet. `team` is a BEST-GUESS assignment (Sales/
// Accounts/OPS/MP Team) for the colour-coded grouping in the tool's UI
// and the Sheet's row-1 header — relabelling any column is a one-line
// change below.
// `derivable:false` fields are internal/manual-only and are never sent
// to the AI extractor — they stay blank until a person fills them in.
// Only `derivable:true` fields are asked of the AI extractor.
// `formula:true` (Order Status only) means this column is never written
// from extracted/typed values at all — the sync step always overwrites
// it with a live VLOOKUP formula that reads the order's status from the
// "All orders" tab, by order ID. See orderStatusFormula() below.
// ------------------------------------------------------------------
const COLUMNS = [
  // Column A and the Invoices tab's unique key: one row per invoice. An
  // order with several invoices (one per shipment/item) gets one row each.
  { key: "invoiceNumber",        label: "Invoice Number",               team: "Accounts", derivable: true },
  { key: "orderStatus",          label: "Order Status",                 team: "OPS",      derivable: false, formula: true },
  // Live lookup from "All orders", same as Order Status.
  { key: "actualShipoutDate",    label: "Actual Shipout Date",          team: "OPS",      derivable: false, formula: true },
  { key: "supplierName",         label: "Supplier Name",                team: "Sales",    derivable: true },
  { key: "taxableValue",         label: "Taxable value",                team: "Accounts", derivable: true },
  { key: "invoiceValue",         label: "Invoice value",                team: "Accounts", derivable: true },
  { key: "igst",                 label: "IGST",                         team: "Accounts", derivable: true },
  { key: "cgst",                 label: "CGST",                         team: "Accounts", derivable: true },
  { key: "sgst",                 label: "SGST",                         team: "Accounts", derivable: true },
  { key: "orderId",              label: "order-id",                     team: "MP Team",  derivable: true },
  { key: "orderItemId",          label: "order-item-id",                team: "MP Team",  derivable: false },
  { key: "purchaseDate",         label: "purchase-date",                team: "MP Team",  derivable: true },
  { key: "paymentsDate",         label: "payments-date",                team: "Accounts", derivable: false },
  { key: "buyerName",            label: "buyer-name",                   team: "Sales",    derivable: true },
  { key: "buyerPhoneNumber",     label: "buyer-phone-number",           team: "Sales",    derivable: true },
  { key: "sku",                  label: "sku",                          team: "Sales",    derivable: true },
  { key: "numberOfItems",        label: "number-of-items",              team: "Sales",    derivable: true },
  { key: "productName",          label: "product-name",                 team: "Sales",    derivable: true },
  { key: "quantityPurchased",    label: "quantity-purchased",           team: "Sales",    derivable: true },
  { key: "quantityShipped",      label: "quantity-shipped",             team: "OPS",      derivable: false },
  { key: "quantityToShip",       label: "quantity-to-ship",             team: "OPS",      derivable: false },
  { key: "shipServiceLevel",     label: "ship-service-level",           team: "OPS",      derivable: false },
  { key: "recipientName",        label: "recipient-name",               team: "Sales",    derivable: true },
  { key: "shipAddress1",         label: "ship-address-1",               team: "Sales",    derivable: true },
  { key: "shipAddress2",         label: "ship-address-2",               team: "Sales",    derivable: true },
  { key: "shipAddress3",         label: "ship-address-3",               team: "Sales",    derivable: true },
  { key: "shipCity",             label: "ship-city",                    team: "Sales",    derivable: true },
  { key: "shipState",            label: "ship-state",                   team: "Sales",    derivable: true },
  { key: "shipPostalCode",       label: "ship-postal-code",             team: "Sales",    derivable: true },
  // Never auto-filled from extraction or CSV import, by design — finance
  // fills this in by hand once a TnM invoice has actually been raised
  // for the order, so it stays blank on every sync no matter what.
  { key: "accountsRemarks",      label: "Accounts Remarks",             team: "Accounts", derivable: false }
];
const FIELD_KEYS = COLUMNS.map((c) => c.key);
const DERIVABLE_KEYS = COLUMNS.filter((c) => c.derivable).map((c) => c.key);

// ------------------------------------------------------------------
// "All orders" tab — the master record for every Seller Flex order,
// invoiced or not, imported from the portal's "all orders" CSV. One
// row per order (see importOrdersFromCsv). orderId doubles as both the
// first data column AND the dedup key scanned by syncOrdersToSheet —
// no separate hidden row-key column is needed here since it's already
// guaranteed unique per row.
//
// The first 8 columns are the original set and keep their original
// order/position so the already-synced "All orders" tab doesn't get
// reshuffled; every column after actualShipoutDate is one of the
// remaining columns from Seller Flex's own "all orders" CSV export
// (see importOrdersFromCsv), added so every field in that export ends
// up in the Sheet, not just a curated subset. Labels are the CSV's own
// column headers verbatim. A CSV can have several lines per order
// (one per shipment/split); every one of these, like sku/title
// already did, just takes its value from that order's FIRST line —
// see importOrdersFromCsv's per-order `orders.push` for the one
// exception (the two dates, which take the earliest/latest across all
// of an order's lines instead).
// ------------------------------------------------------------------
const ORDERS_COLUMNS = [
  { key: "orderId",               label: "Customer Order ID" },
  { key: "orderStatus",           label: "Status" },
  { key: "orderValue",            label: "Order Value" },
  { key: "units",                 label: "Units" },
  { key: "sku",                   label: "MSKU" },
  { key: "title",                 label: "Title" },
  { key: "shipmentCreationDate",  label: "Shipment Creation Date" },
  { key: "actualShipoutDate",     label: "Actual Shipout Date" },
  { key: "shipmentId",            label: "Shipment ID" },
  { key: "shipmentType",          label: "shipment Type" },
  { key: "flexSku",               label: "SKU" },
  { key: "asin",                  label: "ASIN" },
  { key: "customId",              label: "Custom ID" },
  { key: "shipmentTrackingId",    label: "Shipment Tracking ID" },
  { key: "exsd",                  label: "ExSD" },
  { key: "assignedToPicklist",    label: "Assigned to picklist" },
  { key: "packed",                label: "Packed" },
  { key: "hazmat",                label: "Hazmat" },
  { key: "serialNumber",          label: "Serial Number" },
  { key: "expiry",                label: "Expiry" },
  { key: "giftMsg",               label: "Gift Msg" },
  { key: "giftWrap",              label: "Gift Wrap" },
  { key: "isFastTrack",           label: "Is Fast Track" },
  { key: "channel",               label: "Channel" },
  // Not in the Seller Flex CSV at all — a live formula that pulls the
  // order date (purchase-date) from the Invoices tab for the same order
  // ID, so it fills in automatically once that order's invoice is
  // uploaded and stays blank until then. Added at the END so none of the
  // existing columns (or formulas built on them) shift position.
  { key: "orderCreationDate",     label: "Order Creation Date", formula: true }
];
// Every ORDERS_COLUMNS key except orderId/orderStatus/orderValue/units
// (computed specially) and the two dates (min/max'd separately) is
// carried straight through from the CSV using this same "first line
// wins" rule — built from ORDERS_COLUMNS itself so a future column
// addition doesn't need a matching change in three different places.
const ORDERS_PASSTHROUGH_KEYS = ORDERS_COLUMNS
  .filter((c) => !c.formula)
  .map((c) => c.key)
  .filter((k) => !["orderId", "orderStatus", "orderValue", "units", "shipmentCreationDate", "actualShipoutDate"].includes(k));

// Unique key of an "All orders" row (an array of cell values in
// ORDERS_COLUMNS order): its Shipment ID, or "order:<id>" for the rare
// line with no Shipment ID.
const SHIPMENT_ID_COL = ORDERS_COLUMNS.findIndex((c) => c.key === "shipmentId");
const ORDER_ID_COL = ORDERS_COLUMNS.findIndex((c) => c.key === "orderId");
function orderRowKey(row) {
  const ship = String((row && row[SHIPMENT_ID_COL]) == null ? "" : row[SHIPMENT_ID_COL]).trim();
  if (ship) return ship;
  const oid = String((row && row[ORDER_ID_COL]) == null ? "" : row[ORDER_ID_COL]).trim();
  return oid ? "order:" + oid : "";
}

const FIELD_NOTES = [
  'invoiceNumber: the invoice number exactly as printed (e.g. "JJGZ-179") — NOT the order ID.',
  "supplierName: the seller/supplier name as printed on the invoice (TyresNmore's own selling entity, or the upstream brand if shown separately).",
  "taxableValue: the taxable value (pre-tax amount) as printed on the invoice.",
  "invoiceValue: the total invoice value (including tax) as printed.",
  "igst / cgst / sgst: the IGST / CGST / SGST amounts from the invoice's tax breakup, exactly as printed — use \"0\" if a tax line is explicitly shown as zero, and leave empty only if that tax isn't shown on the invoice at all.",
  'orderId: the marketplace order ID (Amazon\'s "Order ID" / Flipkart\'s order ID), exactly as printed.',
  "purchaseDate: the order/purchase date exactly as printed — this is the order date, not the invoice date.",
  "buyerName: the customer/buyer's name.",
  "buyerPhoneNumber: the buyer's phone number, if printed on the invoice.",
  "sku: the seller SKU code for the item, if shown.",
  "numberOfItems: the number of distinct line items/items in the shipment, if determinable; otherwise same as quantityPurchased.",
  "productName: the product name/description as listed.",
  "quantityPurchased: the numeric quantity ordered for the item.",
  "recipientName: the name on the shipping/delivery address (may differ from buyerName).",
  "shipAddress1 / shipAddress2 / shipAddress3: the shipping address split across up to three lines, in order — leave later lines empty if the printed address has fewer lines.",
  "shipCity / shipState / shipPostalCode: the shipping address's city, state, and postal/PIN code."
].join("\n- ");

function buildPrompt(text) {
  const shape = "{" + DERIVABLE_KEYS.map((k) => '"' + k + '": string').join(", ") + "}";
  return "You are extracting data from a marketplace order tax invoice PDF for TyresNmore, an automotive tyre and accessories seller. The invoice may come from Amazon, Flipkart, or another marketplace. The text below was extracted from the PDF and may have irregular spacing or line breaks — use context to interpret it.\n\n"
    + "Reply with ONLY a single JSON object and absolutely nothing else — no markdown code fences, no explanation before or after, no trailing commentary. The response must start with { and end with }. It must have exactly these keys, every value a string:\n"
    + shape + "\n\n"
    + "Field notes:\n- " + FIELD_NOTES + "\n\n"
    + "Rules: use an empty string \"\" for anything you cannot find in the text — never guess or invent a value, and never omit a key. Keep every value short (copy amounts and dates exactly as printed) — do not include explanations inside values.\n\n"
    + "Document text:\n<<<\n" + text.slice(0, 11000) + "\n>>>";
}

function checkAccessCode(req, res) {
  if (!accessCode) return true; // no gate configured
  const supplied = req.get("x-access-code") || "";
  if (supplied === accessCode) return true;
  res.status(401).json({ error: "bad_access_code" });
  return false;
}

// ------------------------------------------------------------------
// Google Sheets + Drive (service account). Both are optional: if
// GOOGLE_SERVICE_ACCOUNT_KEY isn't set, the tool still works for AI
// extraction — sheet sync and PDF storage just report "not configured".
// ------------------------------------------------------------------
let sheetsClient = null;
let driveClient = null;
let googleReady = false;
const headerCheckedAt = {};      // tab name -> last time its header row was verified
const formatsApplied = {};       // tab name -> true once column number/date formats are set
const numbersCleaned = {};       // tab name -> true once old text-formatted numbers were converted
const tabSheetIds = {};          // tab name -> numeric sheetId (needed for row insert/delete)
const dedupedTabs = {};          // tab name -> true once duplicate rows were removed this process
const HEADER_RECHECK_MS = 60 * 1000;

async function initGoogle() {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyRaw) {
    console.warn("GOOGLE_SERVICE_ACCOUNT_KEY is not set — Google Sheet sync and PDF storage are disabled.");
    return;
  }
  let keyJson;
  try {
    const trimmed = keyRaw.trim();
    const looksLikeJson = trimmed.startsWith("{");
    const decoded = looksLikeJson ? trimmed : Buffer.from(trimmed, "base64").toString("utf8");
    keyJson = JSON.parse(decoded);
  } catch (e) {
    console.error("GOOGLE_SERVICE_ACCOUNT_KEY isn't valid JSON (or valid base64-encoded JSON):", e.message);
    return;
  }
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/drive.file"
      ]
    });
    const client = await auth.getClient();
    sheetsClient = google.sheets({ version: "v4", auth: client });
    driveClient = google.drive({ version: "v3", auth: client });
    googleReady = true;
    console.log("Google Sheets/Drive auth ready (service account: " + (keyJson.client_email || "unknown") + ").");
  } catch (e) {
    console.error("Failed to set up Google auth:", e.message);
  }
}
initGoogle();

function sheetsReady() { return googleReady && !!sheetsClient && !!process.env.GOOGLE_SHEET_ID; }
function driveReady() { return googleReady && !!driveClient && !!process.env.GOOGLE_DRIVE_FOLDER_ID; }

function colLetterFor(n) {
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function ordersTabName() { return process.env.GOOGLE_ORDERS_TAB || "All orders"; }

// Builds the live formula that fills the Invoices tab's "Order Status"
// cell, looking the order up by ID in the "All orders" tab rather than
// having our server write a point-in-time status value. The order ID is
// embedded as a literal in the formula (not a same-row cell reference) —
// simpler than working out which row an append landed on, at the small
// cost that hand-editing an order-id cell afterwards won't move the
// lookup with it (that's already discouraged: order-id is a locked,
// auto-filled field unless someone explicitly unlocks it).
function lookupId(orderId) { return '"' + String(orderId || "").replace(/"/g, '""') + '"'; }
function ordersRange(key) {
  const L = colLetterFor(ORDERS_COLUMNS.findIndex((c) => c.key === key) + 1);
  return quoteTab(ordersTabName()) + "!" + L + ":" + L;
}
// All orders now has one row per SHIPMENT, so an order can appear on
// several rows (e.g. a cancelled shipment and the one that actually went
// out). Status prefers the first non-cancelled shipment's status, falling
// back to "Cancelled" only if every shipment was cancelled.
function orderStatusFormula(orderId) {
  const id = lookupId(orderId), A = ordersRange("orderId"), B = ordersRange("orderStatus");
  return "=IFERROR(INDEX(FILTER(" + B + ", " + A + "=" + id + ", " + B + '<>"Cancelled"), 1), IFERROR(INDEX(FILTER(' + B + ", " + A + "=" + id + '), 1), ""))';
}
// Latest Actual Shipout Date across the order's shipments; blank until
// one has shipped (MAXIFS returns 0 when nothing matches — 1/(1/x) turns
// that 0 into an error, which IFERROR blanks).
function shipoutDateFormula(orderId) {
  const id = lookupId(orderId), A = ordersRange("orderId"), H = ordersRange("actualShipoutDate");
  return "=IFERROR(1/(1/MAXIFS(" + H + ", " + A + ", " + id + ')), "")';
}
function invoiceFormulaFor(key, values) {
  const orderId = values && values.orderId;
  if (key === "orderStatus") return orderStatusFormula(orderId);
  if (key === "actualShipoutDate") return shipoutDateFormula(orderId);
  return "";
}

// ------------------------------------------------------------------
// Header rows — one plain header row per tab, self-healing.
//
// History: the Invoices tab used to get TWO header rows (a team row —
// "OPS / Sales / Accounts / MP Team" — above the field labels). That team
// row is now dropped; both tabs get a single header row in row 1.
//
// The old version also remembered "header done" in an in-memory flag for
// the life of the server process. If someone cleared or deleted rows in a
// tab while the server was warm, the flag still said "done", so the next
// import appended data straight into row 1 with no header at all (that's
// what happened to "All orders"). Now every tab is re-checked at most
// once a minute and repaired on the spot:
//   - row 1 already the header          -> rewritten in place (picks up new columns)
//   - legacy team row + label row        -> team row deleted, labels stay as row 1
//   - row 1 blank                        -> header written
//   - row 1 holds DATA (header missing)  -> a row is inserted above it, header written
// ------------------------------------------------------------------
const tabLocks = {};
// Serialises all writes to one tab. Without this, two syncs for the same
// order arriving together (e.g. the Drive-upload sync and the extraction
// sync, or two copies of one invoice in a bulk zip) could both see "no
// row yet" and both append — producing duplicate rows.
function withTabLock(tab, fn) {
  const prev = tabLocks[tab] || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  tabLocks[tab] = next.catch(() => {});
  return next;
}

async function getTabSheetId(tab) {
  if (tabSheetIds[tab] !== undefined) return tabSheetIds[tab];
  const resp = await sheetsClient.spreadsheets.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    fields: "sheets.properties(sheetId,title)"
  });
  (resp.data.sheets || []).forEach((sh) => { tabSheetIds[sh.properties.title] = sh.properties.sheetId; });
  if (tabSheetIds[tab] === undefined) throw new Error('Tab "' + tab + '" not found in the Google Sheet');
  return tabSheetIds[tab];
}

function quoteTab(tab) { return "'" + String(tab).replace(/'/g, "''") + "'"; }

// opts.legacyFirsts: first-cell labels of older header layouts that
// should be recognised as "a header row" rather than data.
// opts.migrate(gid, legacyFirstCell): extra structural requests to bring
// an older layout's columns in line with the current one.
async function ensureHeaderRow(tab, header, opts) {
  opts = opts || {};
  const last = headerCheckedAt[tab];
  if (last && Date.now() - last < HEADER_RECHECK_MS) return;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const lastCol = colLetterFor(header.length);
  const resp = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: quoteTab(tab) + "!A1:" + lastCol + "2"
  });
  const rows = resp.data.values || [];
  const row1 = (rows[0] || []).map((v) => String(v || "").trim());
  const row2 = (rows[1] || []).map((v) => String(v || "").trim());
  const first = header[0];
  const legacy = opts.legacyFirsts || [];
  const isHeaderCell = (v) => v === first || legacy.includes(v);

  const structural = [];
  let headerFirstCell = null;
  if (isHeaderCell(row1[0])) {
    headerFirstCell = row1[0];
  } else if (isHeaderCell(row2[0]) && row1.some((v) => v)) {
    // legacy two-row header (team row on top) — delete the team row
    structural.push({ deleteDimension: { range: { sheetId: await getTabSheetId(tab), dimension: "ROWS", startIndex: 0, endIndex: 1 } } });
    headerFirstCell = row2[0];
  } else if (row1.some((v) => v)) {
    // row 1 is data — make room for the header above it
    structural.push({ insertDimension: { range: { sheetId: await getTabSheetId(tab), dimension: "ROWS", startIndex: 0, endIndex: 1 }, inheritFromBefore: false } });
  }
  if (headerFirstCell && headerFirstCell !== first && opts.migrate) {
    structural.push.apply(structural, await opts.migrate(await getTabSheetId(tab), headerFirstCell));
  }
  if (structural.length) {
    await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: sheetId, requestBody: { requests: structural } });
  }
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: quoteTab(tab) + "!A1:" + lastCol + "1",
    valueInputOption: "RAW",
    requestBody: { values: [header] }
  });
  headerCheckedAt[tab] = Date.now();
}

// Removes duplicate rows from a tab, once per server process: rows sharing
// the same key (keyFn over the row's cells) collapse to the one with the
// most filled-in cells (ties -> the lowest row, i.e. the most recent
// append). Rows with a blank key are left alone.
async function dedupeTab(tab, lastColIndex, keyFn) {
  if (dedupedTabs[tab]) return 0;
  const resp = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    range: quoteTab(tab) + "!A2:" + colLetterFor(lastColIndex)
  });
  const rows = resp.data.values || [];
  const best = new Map(); // key -> { idx, score }
  const toDelete = [];
  rows.forEach((row, i) => {
    const key = keyFn(row);
    if (!key) return;
    const score = row.filter((v) => String(v == null ? "" : v).trim() !== "").length;
    const cur = best.get(key);
    if (!cur) { best.set(key, { idx: i, score }); return; }
    if (score >= cur.score) { toDelete.push(cur.idx); best.set(key, { idx: i, score }); }
    else toDelete.push(i);
  });
  if (toDelete.length) {
    const gid = await getTabSheetId(tab);
    const requests = toDelete.sort((x, y) => y - x).map((i) => ({
      // +1 because `rows` starts at sheet row 2 (0-based index 1)
      deleteDimension: { range: { sheetId: gid, dimension: "ROWS", startIndex: i + 1, endIndex: i + 2 } }
    }));
    await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SHEET_ID, requestBody: { requests } });
    console.log("dedupeTab(" + tab + "): removed " + toDelete.length + " duplicate rows");
  }
  dedupedTabs[tab] = true;
  return toDelete.length;
}

// Applies number/date display formats to whole columns (row 2 down), once
// per server process per tab. `formats` is [{ col: 0-based index, pattern, type }].
async function applyColumnFormats(tab, formats) {
  if (formatsApplied[tab] || !formats.length) return;
  const gid = await getTabSheetId(tab);
  const requests = [{
    // bold + frozen header row
    repeatCell: {
      range: { sheetId: gid, startRowIndex: 0, endRowIndex: 1 },
      cell: { userEnteredFormat: { textFormat: { bold: true } } },
      fields: "userEnteredFormat.textFormat.bold"
    }
  }, {
    updateSheetProperties: { properties: { sheetId: gid, gridProperties: { frozenRowCount: 1 } }, fields: "gridProperties.frozenRowCount" }
  }].concat(formats.map((f) => ({
    repeatCell: {
      range: { sheetId: gid, startRowIndex: 1, startColumnIndex: f.col, endColumnIndex: f.col + 1 },
      cell: { userEnteredFormat: { numberFormat: { type: f.type, pattern: f.pattern } } },
      fields: "userEnteredFormat.numberFormat"
    }
  })));
  await sheetsClient.spreadsheets.batchUpdate({ spreadsheetId: process.env.GOOGLE_SHEET_ID, requestBody: { requests } });
  formatsApplied[tab] = true;
}

// ---- value normalisation: numbers as real numbers, dates as real dates ----
// The AI returns amounts the way the invoice prints them ("₹9,550.00",
// "Rs. 1,456.78", "9,550.00"). Written as-is they land in the Sheet as
// TEXT, which SUM/SUMIFS silently skip. Everything numeric is reduced to
// a plain number before writing.
const INVOICE_NUMERIC_KEYS = ["taxableValue", "invoiceValue", "igst", "cgst", "sgst", "numberOfItems", "quantityPurchased", "quantityShipped", "quantityToShip"];
const INVOICE_MONEY_KEYS = ["taxableValue", "invoiceValue", "igst", "cgst", "sgst"];
const INVOICE_DATE_KEYS = ["purchaseDate"];

function toPlainNumber(v) {
  if (typeof v === "number") return v;
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  const m = s.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : s;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Invoice dates are Indian day-first ("05.09.2026", "05/09/2026",
// "05-Sep-2026"). Returns an ISO "2026-09-05" string, which the Sheet
// stores as a real date regardless of its locale; anything unrecognised
// is passed through untouched.
function toIsoDate(v) {
  if (typeof v === "number") return v;
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  let d, mo, y, m;
  if ((m = s.match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-\/. ](\d{1,2})[-\/. ](\d{2,4})/))) { d = +m[1]; mo = +m[2]; y = +m[3]; }
  else if ((m = s.match(/^(\d{1,2})[-\/. ]*([A-Za-z]{3})[A-Za-z]*[-\/., ]*(\d{2,4})/))) { d = +m[1]; mo = MONTHS[m[2].toLowerCase()]; y = +m[3]; }
  else return s;
  if (y < 100) y += 2000;
  if (!mo || mo > 12 || !d || d > 31) return s;
  return y + "-" + String(mo).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function normaliseInvoiceValue(key, v) {
  if (INVOICE_NUMERIC_KEYS.includes(key)) return toPlainNumber(v);
  if (INVOICE_DATE_KEYS.includes(key)) return toIsoDate(v);
  return String(v == null ? "" : v);
}

// Invoices-tab column position (1-based). Invoice Number is column A.
function invoiceColIndex(key) { return COLUMNS.findIndex((c) => c.key === key) + 1; }
function ordersColIndex(key) { return ORDERS_COLUMNS.findIndex((c) => c.key === key) + 1; }

function invoicesTabName() { return process.env.GOOGLE_SHEET_TAB || "Invoices"; }
function invoicesHeader() { return COLUMNS.map((c) => c.label).concat(["Invoice File"]); }

// One-time (per server process) pass over rows synced before this fix:
// converts text amounts like "₹3,300.00" into real numbers and text dates
// like "05.09.2026" into real dates, so existing data also adds up.
async function cleanExistingInvoiceValues() {
  const tab = invoicesTabName();
  if (numbersCleaned[tab]) return;
  const keys = INVOICE_NUMERIC_KEYS.concat(INVOICE_DATE_KEYS);
  const ranges = keys.map((k) => { const L = colLetterFor(invoiceColIndex(k)); return quoteTab(tab) + "!" + L + "2:" + L; });
  const resp = await sheetsClient.spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    ranges,
    valueRenderOption: "UNFORMATTED_VALUE"
  });
  const data = [];
  (resp.data.valueRanges || []).forEach((vr, i) => {
    const key = keys[i];
    const L = colLetterFor(invoiceColIndex(key));
    (vr.values || []).forEach((row, r) => {
      const cur = row[0];
      if (typeof cur !== "string" || !cur.trim() || cur.trim().startsWith("=")) return;
      const fixed = normaliseInvoiceValue(key, cur);
      if (fixed !== cur) data.push({ range: quoteTab(tab) + "!" + L + (r + 2), values: [[fixed]] });
    });
  });
  if (data.length) {
    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      requestBody: { valueInputOption: "USER_ENTERED", data }
    });
    console.log("cleanExistingInvoiceValues: converted " + data.length + " text cells to numbers/dates");
  }
  numbersCleaned[tab] = true;
}

async function ensureInvoicesTabReady() {
  const tab = invoicesTabName();
  await ensureHeaderRow(tab, invoicesHeader(), {
    legacyFirsts: ["Row Key"],
    // Old layout: A=Row Key (the order ID), B=Order Status, C=Supplier Name…
    // New layout: A=Invoice Number, B=Order Status, C=Actual Shipout Date,
    // D=Supplier Name… — inserting one column at C shifts every existing
    // row's data into the right place. Column A of those old rows still
    // holds an order ID; it's replaced by the real invoice number the next
    // time that invoice is uploaded (see claimLegacyRow).
    migrate: async (gid) => [{
      insertDimension: { range: { sheetId: gid, dimension: "COLUMNS", startIndex: 2, endIndex: 3 }, inheritFromBefore: false }
    }]
  });
  try { await dedupeTab(tab, invoicesHeader().length, (row) => String(row[0] == null ? "" : row[0]).trim()); }
  catch (e) { console.warn("dedupe Invoices failed (non-fatal):", e.message); }
  await applyColumnFormats(tab,
    INVOICE_MONEY_KEYS.map((k) => ({ col: invoiceColIndex(k) - 1, type: "NUMBER", pattern: "#,##0.00" }))
      .concat(INVOICE_DATE_KEYS.map((k) => ({ col: invoiceColIndex(k) - 1, type: "DATE", pattern: "dd-mmm-yyyy" })))
      .concat([{ col: invoiceColIndex("actualShipoutDate") - 1, type: "DATE_TIME", pattern: "dd-mmm-yyyy h:mm AM/PM" }]));
  try { await cleanExistingInvoiceValues(); } catch (e) { console.warn("cleanExistingInvoiceValues failed (non-fatal):", e.message); }
}

async function ensureOrdersTabReady() {
  const tab = ordersTabName();
  await ensureHeaderRow(tab, ORDERS_COLUMNS.map((c) => c.label));
  try { await dedupeTab(tab, ORDERS_COLUMNS.length, orderRowKey); }
  catch (e) { console.warn("dedupe All orders failed (non-fatal):", e.message); }
  await applyColumnFormats(tab, [
    { col: ordersColIndex("orderValue") - 1,           type: "NUMBER",    pattern: "#,##0.00" },
    { col: ordersColIndex("shipmentCreationDate") - 1, type: "DATE_TIME", pattern: "dd-mmm-yyyy h:mm AM/PM" },
    { col: ordersColIndex("actualShipoutDate") - 1,    type: "DATE_TIME", pattern: "dd-mmm-yyyy h:mm AM/PM" },
    { col: ordersColIndex("exsd") - 1,                 type: "DATE_TIME", pattern: "dd-mmm-yyyy h:mm AM/PM" },
    { col: ordersColIndex("orderCreationDate") - 1,    type: "DATE",      pattern: "dd-mmm-yyyy" }
  ]);
}

// Live lookup for the "All orders" tab's Order Creation Date: the
// purchase-date of the matching order in the Invoices tab, blank until
// that order's invoice has been uploaded.
function orderCreationFormula(orderId) {
  const safeId = String(orderId || "").replace(/"/g, '""');
  const inv = quoteTab(invoicesTabName());
  const dateCol = colLetterFor(invoiceColIndex("purchaseDate"));
  const idCol = colLetterFor(invoiceColIndex("orderId"));
  return '=IFERROR(INDEX(' + inv + "!" + dateCol + ":" + dateCol + ', MATCH("' + safeId + '", ' + inv + "!" + idCol + ":" + idCol + ', 0)), "")';
}

// Returns the sheet row number for an invoice number, or — for rows
// written before invoice numbers became the key — a legacy row whose
// column A still holds this invoice's ORDER ID (old rows were keyed by
// order ID). Claiming that legacy row means re-uploading an old invoice
// converts its row in place instead of adding a second one.
async function findInvoiceRow(invoiceNumber, orderId) {
  const idCol = colLetterFor(invoiceColIndex("orderId"));
  const resp = await sheetsClient.spreadsheets.values.batchGet({
    spreadsheetId: process.env.GOOGLE_SHEET_ID,
    ranges: [quoteTab(invoicesTabName()) + "!A:A", quoteTab(invoicesTabName()) + "!" + idCol + ":" + idCol]
  });
  const colA = (resp.data.valueRanges[0] && resp.data.valueRanges[0].values) || [];
  const colId = (resp.data.valueRanges[1] && resp.data.valueRanges[1].values) || [];
  const cell = (col, i) => String((col[i] && col[i][0]) == null ? "" : col[i][0]).trim();
  for (let i = 1; i < colA.length; i++) {
    if (cell(colA, i) === invoiceNumber) return i + 1;
  }
  const oid = String(orderId || "").trim();
  if (oid && oid !== invoiceNumber) {
    for (let i = 1; i < colA.length; i++) {
      // legacy marker: column A equals the row's own order-id cell
      if (cell(colA, i) === oid && cell(colId, i) === oid) return i + 1;
    }
  }
  return null;
}

// Invoices tab is keyed by INVOICE NUMBER (column A): one row per invoice.
async function syncRowToSheet(invoiceNumber, values, fileLink) {
  const tab = invoicesTabName();
  invoiceNumber = String(invoiceNumber || "").trim();
  if (!invoiceNumber) throw Object.assign(new Error("missing_invoice_number"), { code: "missing_invoice_number" });
  return withTabLock(tab, async () => {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    await ensureInvoicesTabReady();
    const rowValues = COLUMNS.map((c) => {
      if (c.key === "invoiceNumber") return invoiceNumber;
      // Lookup columns are never taken from the client — always the live
      // formula into "All orders".
      if (c.formula) return invoiceFormulaFor(c.key, values);
      return normaliseInvoiceValue(c.key, values && values[c.key]);
    }).concat([fileLink || ""]);
    const existingRow = await findInvoiceRow(invoiceNumber, values && values.orderId);
    if (existingRow) {
      await sheetsClient.spreadsheets.values.update({
        spreadsheetId: sheetId,
        range: quoteTab(tab) + "!A" + existingRow,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [rowValues] }
      });
    } else {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: quoteTab(tab) + "!A:A",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowValues] }
      });
    }
  });
}

// Upserts a batch of aggregated orders (see importOrdersFromCsv) straight
// into the "All orders" tab, keyed by order ID in column A. Reads that
// column once up front rather than doing a per-order lookup — a CSV
// import can easily cover dozens of orders at a time — then issues at
// most one batchUpdate (existing orders) and one append (new orders).
async function syncOrdersToSheet(orders) {
  const tab = ordersTabName();
  return withTabLock(tab, async () => {
    const sheetId = process.env.GOOGLE_SHEET_ID;
    await ensureOrdersTabReady();

    // Keyed by Shipment ID (one row per shipment). Reads the whole tab
    // width so orderRowKey can fall back to the order ID for a row with
    // no shipment ID.
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: quoteTab(tab) + "!A:" + colLetterFor(ORDERS_COLUMNS.length)
    });
    const rows = resp.data.values || [];
    const existingRowByKey = new Map();
    for (let i = 1; i < rows.length; i++) { // row 1 is the header
      const k = orderRowKey(rows[i]);
      if (k) existingRowByKey.set(k, i + 1);
    }

    const updates = [];
    const appends = [];
    let created = 0, updated = 0;
    orders.forEach((order) => {
      const rowValues = ORDERS_COLUMNS.map((c) => {
        if (c.formula) return orderCreationFormula(order.orderId);
        if (c.key === "orderValue" || c.key === "units") return toPlainNumber(order[c.key]);
        return String((order && order[c.key]) || "");
      });
      const existingRow = existingRowByKey.get(orderRowKey(rowValues));
      if (existingRow) {
        updates.push({ range: quoteTab(tab) + "!A" + existingRow, values: [rowValues] });
        updated += 1;
      } else {
        appends.push(rowValues);
        created += 1;
      }
    });

    if (updates.length) {
      await sheetsClient.spreadsheets.values.batchUpdate({
        spreadsheetId: sheetId,
        requestBody: { valueInputOption: "USER_ENTERED", data: updates }
      });
    }
    if (appends.length) {
      await sheetsClient.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: quoteTab(tab) + "!A:A",
        valueInputOption: "USER_ENTERED",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: appends }
      });
    }
    return { created, updated };
  });
}

async function uploadPdfToDrive(buffer, filename) {
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const file = await driveClient.files.create({
    requestBody: { name: filename || "invoice.pdf", parents: folderId ? [folderId] : undefined },
    media: { mimeType: "application/pdf", body: Readable.from(buffer) },
    fields: "id, webViewLink",
    supportsAllDrives: true
  });
  try {
    await driveClient.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true
    });
  } catch (e) {
    console.warn("Couldn't set link-sharing on the Drive file (your Workspace's sharing policy may block it) — the file is still stored:", e.message);
  }
  return file.data.webViewLink || ("https://drive.google.com/file/d/" + file.data.id + "/view");
}

// ------------------------------------------------------------------
// Seller Flex "all orders" CSV import.
//
// Ops downloads this from the Seller Flex portal (Orders > All orders >
// download report). The same Amazon order can appear on several lines —
// e.g. a cancelled pick attempt followed by the one that actually
// shipped, or one line per unit/shipment within a multi-item order — so
// this groups by Shipment ID into a single row per SHIPMENT (the tab's
// unique key since 2026-10-01; an order with several shipments gets one
// row each), which then gets upserted straight into the "All orders" tab
// (see syncOrdersToSheet), the master record for every order whether or
// not it has a TnM invoice yet. Within a shipment's lines:
//   - orderStatus: the furthest-along status seen (Packed beats
//     Manifested beats Confirmed; Cancelled only wins if every line was
//     cancelled).
//   - orderValue / units: summed across the non-cancelled lines only.
//   - shipmentCreationDate / actualShipoutDate: the earliest / latest of
//     that column across the shipment's lines (falling back to the first
//     non-empty raw value if none of them parse as a date).
// A small dependency-free CSV parser is used here (RFC4180-ish: handles
// quoted fields with embedded commas/quotes) rather than adding a new npm
// package for what is one input format.
// ------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  // Strip a leading UTF-8 BOM — Excel adds one when it saves a CSV, and
  // left in place it would silently attach itself to the first header
  // name (e.g. "﻿Shipment Creation Date"), breaking any exact-match
  // lookup against that column.
  const s = String(text || "").replace(/^﻿/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); rows.push(row); row = []; field = "";
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

const ORDER_STATUS_RANK = { Delivered: 5, Shipped: 4, Packed: 3, Manifested: 2, Confirmed: 1, Cancelled: 0 };

function parseFlexDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

// Picks the raw (unparsed) date string whose parsed value is earliest
// (wantLatest=false) or latest (wantLatest=true) among the given values,
// so the displayed text stays exactly as Seller Flex printed it. Falls
// back to the first non-empty raw value if none of them parse.
function pickExtremeDate(values, wantLatest) {
  let best = null, bestParsed = null, fallback = "";
  values.forEach((v) => {
    if (!v) return;
    if (!fallback) fallback = v;
    const d = parseFlexDate(v);
    if (!d) return;
    if (bestParsed === null || (wantLatest ? d > bestParsed : d < bestParsed)) {
      bestParsed = d; best = v;
    }
  });
  return best !== null ? best : fallback;
}

function importOrdersFromCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return { orders: [], summary: { totalOrders: 0, ordersValueTotal: "0.00", cancelledOrders: 0 } };

  const header = rows[0].map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => { idx[h] = i; });
  const required = ["Customer Order ID", "Status", "Order Value", "MSKU", "Title", "Units"];
  const missing = required.filter((h) => !(h in idx));
  if (missing.length) {
    throw new Error("This doesn't look like a Seller Flex orders export — missing column(s): " + missing.join(", "));
  }
  // Shipment Creation Date / Actual Shipout Date are used if present but
  // aren't required — an older or slightly different export without them
  // just leaves those two columns blank rather than failing the import.

  // Strips thousands-separator commas (e.g. "1,234.50") before parseFloat —
  // plain parseFloat stops at the first comma and would silently read that
  // as 1, quietly undercounting GMV. Seller Flex's own CSV export doesn't
  // format numbers this way, but a value re-saved through Excel sometimes
  // picks up comma grouping, so this is cheap insurance either way.
  function toNumber(v) {
    return parseFloat(String(v || "").replace(/,/g, "")) || 0;
  }

  const columnByKey = {};
  ORDERS_COLUMNS.forEach((c) => { columnByKey[c.key] = c; });

  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c.trim() === "")) continue;
    const orderId = (r[idx["Customer Order ID"]] || "").trim();
    if (!orderId) continue;
    const shipmentId = idx["Shipment ID"] !== undefined ? (r[idx["Shipment ID"]] || "").trim() : "";
    const line = {
      orderId,
      status: (r[idx["Status"]] || "").trim(),
      orderValue: toNumber(r[idx["Order Value"]]),
      units: toNumber(r[idx["Units"]]),
      shipmentCreationDate: idx["Shipment Creation Date"] !== undefined ? (r[idx["Shipment Creation Date"]] || "").trim() : "",
      actualShipoutDate: idx["Actual Shipout Date"] !== undefined ? (r[idx["Actual Shipout Date"]] || "").trim() : ""
    };
    // Every other ORDERS_COLUMNS field (sku/title included — MSKU/Title are
    // just the two of these that happen to be required) is carried through
    // generically by column label, so a CSV missing an optional column
    // (an older export, say) just leaves that field blank instead of
    // breaking the import.
    ORDERS_PASSTHROUGH_KEYS.forEach((key) => {
      const label = columnByKey[key].label;
      line[key] = idx[label] !== undefined ? (r[idx[label]] || "").trim() : "";
    });
    // One row per SHIPMENT (the All orders tab's unique key); a line with
    // no Shipment ID falls back to grouping by order ID.
    const groupKey = shipmentId || ("order:" + orderId);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(line);
  }

  const orders = [];
  let ordersValueTotal = 0;
  let cancelledOrders = 0;
  const distinctOrders = new Set();
  groups.forEach((lines) => {
    const orderId = lines[0].orderId;
    distinctOrders.add(orderId);
    const active = lines.filter((l) => l.status !== "Cancelled");
    const useLines = active.length ? active : lines;
    let bestStatus = lines[0].status;
    let bestRank = -1;
    lines.forEach((l) => {
      const rank = ORDER_STATUS_RANK.hasOwnProperty(l.status) ? ORDER_STATUS_RANK[l.status] : 0;
      if (rank > bestRank) { bestRank = rank; bestStatus = l.status; }
    });
    const orderValue = useLines.reduce((sum, l) => sum + l.orderValue, 0);
    const units = useLines.reduce((sum, l) => sum + l.units, 0);
    const first = useLines[0];
    if (!active.length) cancelledOrders += 1;
    else ordersValueTotal += orderValue; // cancelled shipments don't count toward GMV
    const order = {
      orderId,
      orderStatus: bestStatus,
      orderValue: orderValue.toFixed(2),
      units: units ? String(units) : "",
      shipmentCreationDate: pickExtremeDate(lines.map((l) => l.shipmentCreationDate), false),
      actualShipoutDate: pickExtremeDate(lines.map((l) => l.actualShipoutDate), true)
    };
    // Every remaining column (a shipment can have several lines per order —
    // a split shipment, say — so these can genuinely differ line to line)
    // takes whichever value is on the order's first active line, same as
    // sku/title already did before this became a generic loop.
    ORDERS_PASSTHROUGH_KEYS.forEach((key) => { order[key] = first[key] || ""; });
    orders.push(order);
  });

  return {
    orders,
    // `orders` holds one entry per shipment; cancelledOrders counts fully
    // cancelled shipments.
    summary: { totalOrders: distinctOrders.size, totalShipments: orders.length, ordersValueTotal: ordersValueTotal.toFixed(2), cancelledOrders }
  };
}

// ------------------------------------------------------------------
// Routes
// ------------------------------------------------------------------
app.post("/api/extract", async (req, res) => {
  if (!checkAccessCode(req, res)) return;
  if (isRateLimited(req.ip)) return res.status(429).json({ error: "rate_limited" });
  if (!anthropic) return res.status(500).json({ error: "server_not_configured" });

  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "empty_text" });

  try {
    const msg = await anthropic.messages.create({
      model,
      max_tokens: 2200,
      messages: [{ role: "user", content: buildPrompt(text) }]
    });
    const raw = (msg.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
    if (msg.stop_reason === "max_tokens") {
      console.error("extract: response was truncated at max_tokens — raw so far:", raw.slice(0, 800));
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error("extract: no JSON object found in model response (stop_reason=" + msg.stop_reason + "):", raw.slice(0, 800));
      return res.status(502).json({ error: "invalid_json", raw });
    }
    let data;
    try {
      data = JSON.parse(match[0]);
    } catch (e) {
      console.error("extract: JSON.parse failed:", e.message, "raw:", raw.slice(0, 800));
      return res.status(502).json({ error: "invalid_json", raw });
    }
    res.json({ data });
  } catch (e) {
    console.error("extract failed:", e && e.message);
    res.status(502).json({ error: "upstream_error", message: (e && e.message) || "unknown" });
  }
});

app.post("/api/upload-invoice-file", upload.single("pdf"), async (req, res) => {
  if (!checkAccessCode(req, res)) return;
  if (isRateLimited("upload:" + req.ip)) return res.status(429).json({ error: "rate_limited" });
  if (!driveReady()) return res.status(500).json({ error: "drive_not_configured" });
  if (!req.file) return res.status(400).json({ error: "missing_file" });

  try {
    const link = await uploadPdfToDrive(req.file.buffer, req.file.originalname);
    res.json({ link });
  } catch (e) {
    console.error("drive upload failed:", e && e.message);
    res.status(502).json({ error: "drive_upload_failed", message: (e && e.message) || "unknown" });
  }
});

app.post("/api/sync-row", async (req, res) => {
  if (!checkAccessCode(req, res)) return;
  if (isRateLimited("sync:" + req.ip)) return res.status(429).json({ error: "rate_limited" });
  if (!sheetsReady()) return res.status(500).json({ error: "sheets_not_configured" });

  const values = (req.body && req.body.values) || {};
  const fileLink = (req.body && req.body.fileLink) || "";
  // The Invoices tab's unique key is the invoice number itself.
  const invoiceNumber = String(values.invoiceNumber || "").trim();
  if (!invoiceNumber) return res.status(400).json({ error: "missing_invoice_number" });

  try {
    await syncRowToSheet(invoiceNumber, values, fileLink);
    res.json({ ok: true });
  } catch (e) {
    console.error("sheet sync failed:", e && e.message);
    res.status(502).json({ error: "sheet_sync_failed", message: (e && e.message) || "unknown" });
  }
});

// Imports a Seller Flex "all orders" CSV straight into the "All orders"
// tab — aggregation AND the Sheet write both happen here, server-side, in
// one round trip. The client no longer walks the parsed orders one by one
// (that per-order dance is what the Invoices tab's PDF-upload flow still
// does; orders don't touch the Invoices tab at all any more).
app.post("/api/import-orders", async (req, res) => {
  if (!checkAccessCode(req, res)) return;
  if (isRateLimited("import:" + req.ip)) return res.status(429).json({ error: "rate_limited" });
  const csvText = String((req.body && req.body.csv) || "");
  if (!csvText.trim()) return res.status(400).json({ error: "empty_csv" });

  let result;
  try {
    result = importOrdersFromCsv(csvText);
  } catch (e) {
    console.error("orders CSV import failed:", e && e.message);
    return res.status(400).json({ error: "bad_csv", message: (e && e.message) || "unknown" });
  }
  if (!sheetsReady()) return res.status(500).json({ error: "sheets_not_configured" });

  try {
    const { created, updated } = await syncOrdersToSheet(result.orders);
    res.json({ summary: Object.assign({}, result.summary, { created, updated }) });
  } catch (e) {
    console.error("orders sheet sync failed:", e && e.message);
    res.status(502).json({ error: "orders_sync_failed", message: (e && e.message) || "unknown" });
  }
});

app.get("/api/config", (req, res) => {
  res.json({
    requiresAccessCode: Boolean(accessCode),
    sheetsConfigured: sheetsReady(),
    driveConfigured: driveReady()
  });
});

app.post("/api/verify-code", (req, res) => {
  if (!accessCode) return res.json({ ok: true });
  if (isRateLimited("verify:" + req.ip)) return res.status(429).json({ error: "rate_limited" });
  const supplied = String((req.body && req.body.code) || "");
  if (supplied === accessCode) return res.json({ ok: true });
  res.status(401).json({ ok: false });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("TnM Billing Template server listening on port " + port));
