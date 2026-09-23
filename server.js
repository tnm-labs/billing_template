require("dotenv").config();
const express = require("express");
const path = require("path");
const { Readable } = require("stream");
const Anthropic = require("@anthropic-ai/sdk");
const multer = require("multer");
const { google } = require("googleapis");

const app = express();
app.set("trust proxy", true); // so req.ip is the real client IP behind Render/etc.
app.use(express.json({ limit: "2mb" }));
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
// The 42 fields, in the exact order the team's header row uses.
// `team` is a BEST-GUESS assignment (Sales/Accounts/OPS/MP Team) —
// the source header didn't paste cleanly, so treat this as a first
// draft; relabeling any column is a one-line change below.
// `derivable:false` fields are internal/manual-only and are never
// sent to the AI extractor — they stay blank until a person fills them.
// ------------------------------------------------------------------
const COLUMNS = [
  { key: "orderId",               label: "Order Id",                                team: "Sales",    derivable: false },
  { key: "costCenter",            label: "Cost Center",                             team: "Accounts", derivable: false },
  { key: "salesLedger",           label: "Sales Ledger",                            team: "Accounts", derivable: false },
  { key: "voucherType",           label: "Voucher Type",                            team: "Accounts", derivable: false },
  { key: "salesmanName",          label: "salesman name",                           team: "Sales",    derivable: false },
  { key: "leadSource",            label: "Lead Source",                             team: "Sales",    derivable: false },
  { key: "crmOrderId",            label: "CRM Order id",                            team: "MP Team",  derivable: true },
  { key: "costPrice",             label: "Cost Price",                              team: "Accounts", derivable: false },
  { key: "supplierName",          label: "Supplier name",                           team: "Sales",    derivable: true },
  { key: "dispatchedThrough",     label: "Dispatched through",                      team: "OPS",      derivable: true },
  { key: "billingCity",           label: "Billing City",                            team: "Sales",    derivable: true },
  { key: "fsnDetails",            label: "FSN Details for Creatives - Tyresnmore.", team: "Sales",    derivable: true },
  { key: "product",               label: "Product",                                 team: "Sales",    derivable: true },
  { key: "hasOffer",              label: "HAS OFFER",                               team: "Sales",    derivable: true },
  { key: "tnmDiscount",           label: "TNM Discount",                            team: "Sales",    derivable: true },
  { key: "orderDate",             label: "Order Date",                              team: "Sales",    derivable: true },
  { key: "skuCode",                label: "SKU Code",                               team: "Sales",    derivable: true },
  { key: "quantity",              label: "Quantity",                                team: "Sales",    derivable: true },
  { key: "totalInvoiceAmount",    label: "Total invoice Amount",                    team: "Sales",    derivable: true },
  { key: "sellingPricePerItem",   label: "Selling Price Per Item",                  team: "Sales",    derivable: true },
  { key: "preGstPrice",           label: "Pre GST Price",                           team: "Sales",    derivable: true },
  { key: "shippingChargePerItem", label: "Shipping Charge per item",                team: "Sales",    derivable: true },
  { key: "totalInclFkmp",         label: "Total (includes FKMP contribution)",      team: "Sales",    derivable: true },
  { key: "invoiceNo",             label: "Invoice No.",                             team: "Sales",    derivable: true },
  { key: "invoiceAmount",         label: "Invoice Amount",                          team: "Accounts", derivable: true },
  { key: "tnmBillingInvoiceDate", label: "TNM Billing Invoice Date (mm/dd/yy)",     team: "Accounts", derivable: true },
  { key: "taxLedgerCgst",         label: "Tax Ledger",                              team: "Accounts", derivable: false },
  { key: "cgst",                  label: "CGST",                                    team: "Accounts", derivable: true },
  { key: "taxLedgerSgst",         label: "Tax Ledger",                              team: "Accounts", derivable: false },
  { key: "sgst",                  label: "SGST",                                    team: "Accounts", derivable: true },
  { key: "taxLedgerIgst",         label: "Tax Ledger",                              team: "Accounts", derivable: false },
  { key: "igst",                  label: "IGST",                                    team: "Accounts", derivable: true },
  { key: "buyerName",             label: "Buyer name",                              team: "Sales",    derivable: true },
  { key: "shipToName",            label: "Ship to name",                            team: "Sales",    derivable: true },
  { key: "addressLine1",          label: "Address Line 1",                          team: "Sales",    derivable: true },
  { key: "addressLine2",          label: "Address Line 2",                          team: "Sales",    derivable: true },
  { key: "city",                  label: "City",                                    team: "Sales",    derivable: true },
  { key: "state",                 label: "State",                                   team: "Sales",    derivable: true },
  { key: "pinCode",                label: "PIN Code",                               team: "Sales",    derivable: true },
  { key: "phoneNo",               label: "Phone No",                                team: "Sales",    derivable: true },
  { key: "emailId",               label: "Email Id",                                team: "Sales",    derivable: true },
  { key: "hsn",                   label: "HSN",                                     team: "Accounts", derivable: true }
];
const FIELD_KEYS = COLUMNS.map((c) => c.key);
const DERIVABLE_KEYS = COLUMNS.filter((c) => c.derivable).map((c) => c.key);

const FIELD_NOTES = [
  'crmOrderId: the marketplace order ID (often labeled "Order ID" on the invoice).',
  "supplierName: the upstream brand/vendor supplying the product, only if shown separately from the seller.",
  "dispatchedThrough: the courier or logistics partner name.",
  "billingCity: the city from the bill-to address.",
  "fsnDetails: the FSN (Flipkart Serial Number) code.",
  "product: the product name/description as listed.",
  'hasOffer: "Yes" if a discount/offer price is shown on the item, else "No".',
  "tnmDiscount: the total discount amount applied (the combined FK + TNM discount, if the invoice breaks it out that way; otherwise the single discount line shown).",
  "orderDate: the Flipkart order date exactly as printed — this is the order date, not the invoice date.",
  "skuCode: the SKU code.",
  "quantity: the numeric quantity ordered.",
  "totalInvoiceAmount and invoiceAmount: the invoice total exactly as printed (may be the same value).",
  "sellingPricePerItem: the unit selling price.",
  "preGstPrice: the price before GST/tax.",
  "shippingChargePerItem: the shipping/freight charge per item.",
  "totalInclFkmp: the grand total including any FKMP contribution line, if shown separately.",
  "invoiceNo: the invoice number.",
  "tnmBillingInvoiceDate: the invoice date, reformatted as mm/dd/yy regardless of how it is printed. If the document clearly shows a separate dispatch/fitment date, use the actual invoice date here, not that date.",
  "cgst / sgst / igst: the tax amount for each, exactly as printed.",
  "buyerName: the customer/buyer's name.",
  "shipToName: the name on the shipping address, if different from the buyer name.",
  "addressLine1 / addressLine2 / city / state / pinCode / phoneNo / emailId: the shipping address broken into its parts.",
  "hsn: the HSN code for the product."
].join("\n- ");

function buildPrompt(text) {
  const shape = "{" + DERIVABLE_KEYS.map((k) => '"' + k + '": string').join(", ") + "}";
  return "You are extracting data from a Flipkart Marketplace (FKMP) tax invoice / TyresNmore billing invoice PDF. TyresNmore is an automotive tyre and accessories seller on Flipkart. The text below was extracted from the PDF and may have irregular spacing or line breaks — use context to interpret it.\n\n"
    + "Reply with ONLY a JSON object (no markdown fences, no other text) with exactly these keys, every value a string:\n"
    + shape + "\n\n"
    + "Field notes:\n- " + FIELD_NOTES + "\n\n"
    + "Rules: use an empty string \"\" for anything you cannot find in the text — never guess or invent a value. Copy amounts and dates exactly as printed, except tnmBillingInvoiceDate which should be reformatted to mm/dd/yy.\n\n"
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

async function ensureHeaderRows() {
  if (headerChecked) return;
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const tab = process.env.GOOGLE_SHEET_TAB || "Invoices";
  const existing = await sheetsClient.spreadsheets.values.get({ spreadsheetId: sheetId, range: tab + "!A1" });
  const hasHeader = existing.data.values && existing.data.values.length > 0;
  if (!hasHeader) {
    const row1 = [""].concat(COLUMNS.map((c) => c.team)).concat(["Attachment"]);
    const row2 = ["Row Key"].concat(COLUMNS.map((c) => c.label)).concat(["Invoice File"]);
    await sheetsClient.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: tab + "!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row1, row2] }
    });
  }
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
    fields: "id, webViewLink"
  });
  try {
    await driveClient.permissions.create({
      fileId: file.data.id,
      requestBody: { role: "reader", type: "anyone" }
    });
  } catch (e) {
    console.warn("Couldn't set link-sharing on the Drive file (your Workspace's sharing policy may block it) — the file is still stored:", e.message);
  }
  return file.data.webViewLink || ("https://drive.google.com/file/d/" + file.data.id + "/view");
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
      max_tokens: 1200,
      messages: [{ role: "user", content: buildPrompt(text) }]
    });
    const raw = (msg.content || []).map((b) => (b.type === "text" ? b.text : "")).join("");
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return res.status(502).json({ error: "invalid_json", raw });
    let data;
    try {
      data = JSON.parse(match[0]);
    } catch (e) {
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
