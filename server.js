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
const hits = new Map();
const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 20;
function isRateLimited(ip) {
  const now = Date.now();
  const entry = hits.get(ip) || { count: 0, reset: now + WINDOW_MS };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + WINDOW_MS; }
  entry.count += 1;
  hits.set(ip, entry);
  return entry.count > MAX_PER_WINDOW;
}

// ------------------------------------------------------------------
// The 61 fields, mirroring the team's Amazon order-report export
// ("Invoice template_shailesh.xlsx") column-for-column, in its
// original order. Labels are kept verbatim from that spreadsheet
// (including its typos — e.g. "Fitmate Date", "Promish Delivery
// Date" — so the exported sheet still matches what the team expects).
// `team` is a BEST-GUESS assignment (Sales/Accounts/OPS/MP Team) —
// relabeling any column is a one-line change below.
// This is an ops/order-tracking report, not a printed invoice
// template, so most of these fields never appear on an invoice PDF.
// `derivable:false` fields are internal/manual-only and are never
// sent to the AI extractor — they stay blank until a person fills
// them in (from the marketplace seller portal, not the invoice).
// Only `derivable:true` fields are asked of the AI extractor.
// ------------------------------------------------------------------
const COLUMNS = [
  { key: "crmOrderId",                   label: "CRM Order ID",                            team: "MP Team",  derivable: false },
  { key: "salesman",                     label: "Salesman",                                team: "Sales",    derivable: false },
  { key: "supplierName",                 label: "Supplier Name",                           team: "Sales",    derivable: true },
  { key: "fitmentDeliveryDate",          label: "Fitmate Date / Delivery Date",            team: "OPS",      derivable: false },
  { key: "orderId",                      label: "order-id",                                team: "MP Team",  derivable: true },
  { key: "orderItemId",                  label: "order-item-id",                           team: "MP Team",  derivable: false },
  { key: "purchaseDate",                 label: "purchase-date",                           team: "MP Team",  derivable: true },
  { key: "paymentsDate",                 label: "payments-date",                           team: "Accounts", derivable: false },
  { key: "reportingDate",                label: "reporting-date",                          team: "Accounts", derivable: false },
  { key: "promiseDate",                  label: "promise-date",                            team: "OPS",      derivable: false },
  { key: "daysPastPromise",              label: "days-past-promise",                       team: "OPS",      derivable: false },
  { key: "buyerEmail",                   label: "buyer-email",                             team: "Sales",    derivable: false },
  { key: "buyerName",                    label: "buyer-name",                              team: "Sales",    derivable: true },
  { key: "buyerPhoneNumber",             label: "buyer-phone-number",                      team: "Sales",    derivable: true },
  { key: "sku",                          label: "sku",                                     team: "Sales",    derivable: true },
  { key: "numberOfItems",                label: "number-of-items",                         team: "Sales",    derivable: true },
  { key: "productName",                  label: "product-name",                            team: "Sales",    derivable: true },
  { key: "quantityPurchased",            label: "quantity-purchased",                      team: "Sales",    derivable: true },
  { key: "quantityShipped",              label: "quantity-shipped",                        team: "OPS",      derivable: false },
  { key: "quantityToShip",               label: "quantity-to-ship",                        team: "OPS",      derivable: false },
  { key: "shipServiceLevel",             label: "ship-service-level",                      team: "OPS",      derivable: false },
  { key: "recipientName",                label: "recipient-name",                          team: "Sales",    derivable: true },
  { key: "shipAddress1",                 label: "ship-address-1",                          team: "Sales",    derivable: true },
  { key: "shipAddress2",                 label: "ship-address-2",                          team: "Sales",    derivable: true },
  { key: "shipAddress3",                 label: "ship-address-3",                          team: "Sales",    derivable: true },
  { key: "shipCity",                     label: "ship-city",                               team: "Sales",    derivable: true },
  { key: "shipState",                    label: "ship-state",                              team: "Sales",    derivable: true },
  { key: "shipPostalCode",               label: "ship-postal-code",                        team: "Sales",    derivable: true },
  { key: "shipCountry",                  label: "ship-country",                            team: "Sales",    derivable: true },
  { key: "isBusinessOrder",              label: "is-business-order",                       team: "MP Team",  derivable: false },
  { key: "purchaseOrderNumber",          label: "purchase-order-number",                   team: "MP Team",  derivable: false },
  { key: "priceDesignation",             label: "price-designation",                       team: "MP Team",  derivable: false },
  { key: "isPrime",                      label: "is-prime",                                team: "MP Team",  derivable: false },
  { key: "shipmentStatus",               label: "shipment-status",                         team: "OPS",      derivable: false },
  { key: "isIba",                        label: "is-iba",                                  team: "MP Team",  derivable: false },
  { key: "isBuyerRequestedCancellation", label: "is-buyer-requested-cancellation",         team: "MP Team",  derivable: false },
  { key: "buyerRequestedCancelReason",   label: "buyer-requested-cancel-reason",           team: "MP Team",  derivable: false },
  { key: "vergeOfCancellation",          label: "verge-of-cancellation",                   team: "OPS",      derivable: false },
  { key: "vergeOfLateShipment",          label: "verge-of-lateShipment",                   team: "OPS",      derivable: false },
  { key: "handlingTime",                 label: "handling-time",                           team: "OPS",      derivable: false },
  { key: "effectiveHandlingTime",        label: "effective-handling-time",                 team: "OPS",      derivable: false },
  { key: "handlingTimeSource",           label: "handling-time-source",                    team: "OPS",      derivable: false },
  { key: "transitTime",                  label: "transit-time",                            team: "OPS",      derivable: false },
  { key: "transitTimeSource",            label: "transit-time-source",                     team: "OPS",      derivable: false },
  { key: "transitTimeShipFromCity",      label: "transit-time-ship-from-city",             team: "OPS",      derivable: false },
  { key: "transitTimeShipFromState",     label: "transit-time-ship-from-state",            team: "OPS",      derivable: false },
  { key: "transitTimeShipFromCountry",   label: "transit-time-ship-from-country",          team: "OPS",      derivable: false },
  { key: "agentName",                    label: "Agent Name",                              team: "OPS",      derivable: false },
  { key: "ticketStatus",                 label: "Ticket Status",                           team: "OPS",      derivable: false },
  { key: "orderStatus",                  label: "Order Status",                            team: "OPS",      derivable: false },
  { key: "amzPortalMessage",             label: "AMZ Portal message/Hardik Email",         team: "OPS",      derivable: false },
  { key: "wheelBalancingFitmentCharges", label: "Wheel balancing/Fitment charges",         team: "Accounts", derivable: false },
  { key: "promishDeliveryDate",          label: "Promish Delivery Date",                   team: "OPS",      derivable: false },
  { key: "remarks",                      label: "Remarks",                                 team: "OPS",      derivable: false },
  { key: "fitmentDate",                  label: "Fitment Date (Double click)",             team: "OPS",      derivable: false },
  { key: "fulfilmentType",               label: "FULFILMENT TYPE",                         team: "OPS",      derivable: false },
  { key: "actualFitmentDeliveryDate",    label: "Actual Fitment/Delivery Date",            team: "OPS",      derivable: false },
  { key: "cmRemark",                     label: "CM Remark",                               team: "OPS",      derivable: false },
  { key: "deliverBy",                    label: "Deliver by:",                             team: "OPS",      derivable: false },
  { key: "dateOfOrderAndTime",           label: "Date of Order and time",                  team: "MP Team",  derivable: false },
  { key: "dateOrder",                    label: "Date Order",                              team: "MP Team",  derivable: false },
  // Added for the Seller Flex "all orders" CSV import (see importOrdersFromCsv
  // below) and the finance hand-off it enables — neither is AI-derivable from
  // an invoice PDF, so both are appended here rather than inserted mid-list,
  // to avoid reshuffling columns in a Sheet that's already in use.
  { key: "orderValue",                   label: "Order Value (Seller Flex)",               team: "Accounts", derivable: false },
  { key: "accountsRemarks",              label: "Accounts Remarks",                        team: "Accounts", derivable: false }
];
const FIELD_KEYS = COLUMNS.map((c) => c.key);
const DERIVABLE_KEYS = COLUMNS.filter((c) => c.derivable).map((c) => c.key);
// Fields the Seller Flex orders-CSV import can populate automatically
// (see importOrdersFromCsv). Kept separate from DERIVABLE_KEYS (which is
// specifically "sent to the AI extractor") since these come from a CSV,
// not the model — but both are "auto-sourced" from the client's point of
// view for the field-locking behaviour in public/index.html.
const CSV_IMPORT_KEYS = ["orderId", "sku", "productName", "quantityPurchased", "orderStatus", "orderValue"];

const FIELD_NOTES = [
  "supplierName: the seller/supplier name as printed on the invoice (TyresNmore's own selling entity, or the upstream brand if shown separately).",
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
  "shipCity / shipState / shipPostalCode / shipCountry: the shipping address's city, state, postal/PIN code, and country."
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
let headerChecked = false;

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

// NOTE on a bug this fixes: the old version checked cell A1 for "does a
// header already exist?" — but A1 is the blank corner cell above "Row Key"
// by design, so that check always saw "empty" and re-appended a brand new
// header pair below all existing rows on every cold start (Render restarts
// the process often, which resets the in-memory `headerChecked` flag).
// Writing to a FIXED range (A1:<lastCol>2) with `update` instead of
// `append` makes this idempotent — calling it again just re-writes the
// same two rows in the same place, so headers can never be duplicated
// further down the sheet.
async function ensureHeaderRows() {
  if (headerChecked) return;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || "Invoices";
  const row1 = [""].concat(COLUMNS.map((c) => c.team)).concat(["Attachment"]);
  const row2 = ["Row Key"].concat(COLUMNS.map((c) => c.label)).concat(["Invoice File"]);
  const lastCol = colLetterFor(row1.length);
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: sheetId,
    range: tab + "!A1:" + lastCol + "2",
    valueInputOption: "RAW",
    requestBody: { values: [row1, row2] }
  });
  headerChecked = true;
}

async function findRowByKey(rowKey) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || "Invoices";
  const resp = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab + "!A:A" });
  const col = resp.data.values || [];
  for (let i = 0; i < col.length; i++) {
    if (col[i][0] === rowKey) return i + 1; // 1-indexed row number
  }
  return null;
}

async function syncRowToSheet(rowKey, values, fileLink) {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || "Invoices";
  await ensureHeaderRows();
  const rowValues = [rowKey].concat(COLUMNS.map((c) => String((values && values[c.key]) || ""))).concat([fileLink || ""]);
  const existingRow = await findRowByKey(rowKey);
  if (existingRow) {
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: tab + "!A" + existingRow,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [rowValues] }
    });
  } else {
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: tab + "!A:A",
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] }
    });
  }
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
// download report). Same Amazon order can appear on several lines — e.g.
// a cancelled pick attempt followed by the one that actually shipped, or
// one line per unit/shipment within a multi-item order — so this groups
// by Customer Order ID into a single row per order:
//   - orderStatus: the furthest-along status seen for that order (Packed
//     beats Manifested beats Confirmed; Cancelled only wins if every line
//     for that order was cancelled).
//   - orderValue / quantityPurchased: summed across the non-cancelled
//     lines only, so a cancelled-then-reshipped order isn't double-counted.
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

  // Strips thousands-separator commas (e.g. "1,234.50") before parseFloat —
  // plain parseFloat stops at the first comma and would silently read that
  // as 1, quietly undercounting GMV. Seller Flex's own CSV export doesn't
  // format numbers this way, but a value re-saved through Excel sometimes
  // picks up comma grouping, so this is cheap insurance either way.
  function toNumber(v) {
    return parseFloat(String(v || "").replace(/,/g, "")) || 0;
  }

  const groups = new Map();
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.every((c) => c.trim() === "")) continue;
    const orderId = (r[idx["Customer Order ID"]] || "").trim();
    if (!orderId) continue;
    const line = {
      status: (r[idx["Status"]] || "").trim(),
      orderValue: toNumber(r[idx["Order Value"]]),
      units: toNumber(r[idx["Units"]]),
      sku: (r[idx["MSKU"]] || "").trim(),
      title: (r[idx["Title"]] || "").trim()
    };
    if (!groups.has(orderId)) groups.set(orderId, []);
    groups.get(orderId).push(line);
  }

  const orders = [];
  let ordersValueTotal = 0;
  let cancelledOrders = 0;
  groups.forEach((lines, orderId) => {
    const active = lines.filter((l) => l.status !== "Cancelled");
    const useLines = active.length ? active : lines;
    let bestStatus = lines[0].status;
    let bestRank = -1;
    lines.forEach((l) => {
      const rank = ORDER_STATUS_RANK.hasOwnProperty(l.status) ? ORDER_STATUS_RANK[l.status] : 0;
      if (rank > bestRank) { bestRank = rank; bestStatus = l.status; }
    });
    const orderValue = useLines.reduce((sum, l) => sum + l.orderValue, 0);
    const quantityPurchased = useLines.reduce((sum, l) => sum + l.units, 0);
    const first = useLines[0];
    if (!active.length) cancelledOrders += 1;
    ordersValueTotal += orderValue;
    orders.push({
      orderId,
      orderStatus: bestStatus,
      orderValue: orderValue.toFixed(2),
      quantityPurchased: quantityPurchased ? String(quantityPurchased) : "",
      sku: first.sku || "",
      productName: first.title || ""
    });
  });

  return {
    orders,
    summary: { totalOrders: orders.length, ordersValueTotal: ordersValueTotal.toFixed(2), cancelledOrders }
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

  const rowKey = (req.body && req.body.rowKey) || "";
  const values = (req.body && req.body.values) || {};
  const fileLink = (req.body && req.body.fileLink) || "";
  if (!rowKey) return res.status(400).json({ error: "missing_row_key" });

  try {
    await syncRowToSheet(rowKey, values, fileLink);
    res.json({ ok: true });
  } catch (e) {
    console.error("sheet sync failed:", e && e.message);
    res.status(502).json({ error: "sheet_sync_failed", message: (e && e.message) || "unknown" });
  }
});

app.post("/api/import-orders", (req, res) => {
  if (!checkAccessCode(req, res)) return;
  if (isRateLimited("import:" + req.ip)) return res.status(429).json({ error: "rate_limited" });
  const csvText = String((req.body && req.body.csv) || "");
  if (!csvText.trim()) return res.status(400).json({ error: "empty_csv" });
  try {
    const result = importOrdersFromCsv(csvText);
    res.json(result);
  } catch (e) {
    console.error("orders CSV import failed:", e && e.message);
    res.status(400).json({ error: "bad_csv", message: (e && e.message) || "unknown" });
  }
});

app.get("/api/config", (req, res) => {
  res.json({
    requiresAccessCode: Boolean(accessCode),
    sheetsConfigured: sheetsReady(),
    driveConfigured: driveReady(),
    csvImportKeys: CSV_IMPORT_KEYS
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
