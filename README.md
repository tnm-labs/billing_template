# TnM Billing Template — server edition

Upload a marketplace order invoice PDF, get the fields the invoice can answer auto-filled, and have every row land straight in a shared Google Sheet — with the original PDF attached so anyone can open it. All as a plain link, with **no Claude account or sign-in for anyone who uses it.**

## How it works

- Everyone opens one URL (your deployed link). No login screen, just an optional shared team passcode if you set one.
- Each PDF is read **in the browser** — its text is sent to your server for AI extraction, and the PDF file itself is uploaded to a Google Drive folder you choose.
- You can drop in individual PDFs or a **.zip of PDFs** (e.g. Amazon's bulk invoice download) — the page unzips it in the browser and processes every PDF inside, including ones nested in subfolders.
- Your server calls the Anthropic API (your own API key) to fill in the fields the invoice can answer. The other fields (see below) are left blank for Sales/OPS/Accounts to fill in by hand.
- Every row is saved automatically into a Google Sheet you choose (via a Google "service account" — see setup below), a couple of seconds after any field changes. Editing a row later updates that same Sheet row rather than creating a duplicate.
- Export to Excel is still available in the page as a local backup copy, but the Google Sheet is now the primary record.

So this needs two things hosted: the small server (`server.js`, same as before) and a Google Sheet + Drive folder you already have access to.

## The 42 fields, and what fills them

The field list follows your team's exact header — Order Id through HSN. A handful of fields (Order Id, Cost Center, Sales Ledger, Voucher Type, salesman name, Lead Source, Cost Price, and the three "Tax Ledger" columns) are internal/CRM data that generally isn't printed on a customer invoice, so those are always left blank for manual entry rather than guessed. Every other field is attempted by the AI extractor and left blank if it isn't found on the invoice.

The column colors (Sales / OPS / Accounts / MP Team) in the page, and the two header rows written into the Sheet, are a **first-pass, best-guess assignment** of which team owns which field — the source list you shared didn't paste with its team groupings intact, so treat the labels as a starting point and tell me anything that should move to a different team; it's a one-line change in `server.js` (`COLUMNS`) and `public/index.html` (the matching array near the top of the script).

## What you need before deploying

1. **An Anthropic API key.** [console.anthropic.com](https://console.anthropic.com) → *Settings → API Keys*. Billed per use (a few cents per invoice at most) — keep it secret.
2. **A Google Cloud project with a service account** — see the walkthrough below. Free.
3. **A Google Sheet and a Google Drive folder** you already have (or create fresh) — share both with the service account.
4. **A place to run a small Node.js server.** [Render.com](https://render.com) is the easiest free option and deploys straight from GitHub.
5. **A GitHub account**, to hold this code so Render can deploy from it.

## Setting up Google Sheets sync

This is the part that's new, and it's the fiddliest step — budget ~15–20 minutes the first time.

1. **Create a Google Cloud project.** Go to [console.cloud.google.com](https://console.cloud.google.com), create a new project (any name, e.g. "tnm-billing-template").
2. **Enable two APIs** for that project: search for and enable both the **Google Sheets API** and the **Google Drive API** (APIs & Services → Library).
3. **Create a service account.** APIs & Services → Credentials → Create Credentials → Service Account. Give it any name (e.g. "tnm-billing-sync"). You don't need to grant it any project-level role.
4. **Create a JSON key for it.** Open the service account → Keys → Add Key → Create new key → JSON. This downloads a `.json` file — this is the credential that lets your server write to the Sheet and Drive folder. Keep it private.
5. **Note the service account's email** — it looks like `tnm-billing-sync@your-project.iam.gserviceaccount.com`. You'll share the Sheet and Drive folder with this exact address, like you'd share with a person.
6. **Create (or pick) the Google Sheet.** Create a blank spreadsheet, name it, add a tab called `Invoices` (or whatever you set `GOOGLE_SHEET_TAB` to). **Share it with the service account's email as an Editor.** Copy the Spreadsheet ID from its URL: `https://docs.google.com/spreadsheets/d/THIS_PART/edit`.
7. **Create (or pick) a Drive folder** for the invoice PDFs. **Share that folder with the service account's email as an Editor** too. Copy the folder ID from its URL: `https://drive.google.com/drive/folders/THIS_PART`.
8. **Turn the downloaded JSON key into one environment variable.** Env vars don't like raw multi-line JSON, so base64-encode it first:
   - Mac/Linux: `base64 -i path/to/your-key.json | tr -d '\n'`
   - Windows (PowerShell): `[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\your-key.json"))`
   Copy the long output string — that's your `GOOGLE_SERVICE_ACCOUNT_KEY`.
9. **A note on sharing:** the server tries to make each uploaded PDF viewable by "anyone with the link" so the link works for your whole team without them needing Drive access. If your Google Workspace's sharing policy blocks external/anyone-with-link sharing, that one step will fail quietly (the file still gets stored, it just won't be link-viewable) — in that case, share the Drive folder itself with your team instead, or loosen that policy for this folder.

The very first time the server successfully writes to the Sheet, it automatically adds two header rows (the team-per-field row and the field-name row) if the tab is empty — you don't need to type headers in yourself.

## 1. Push this folder to GitHub

```bash
cd tnm-billing-backend
git init
git add .
git commit -m "Initial commit: TnM Billing Template server"
```

Create a new empty repository on GitHub (e.g. `tnm-billing-template`), then:

```bash
git remote add origin https://github.com/<your-org-or-username>/tnm-billing-template.git
git branch -M main
git push -u origin main
```

`.gitignore` already excludes `node_modules/` and `.env`, so your keys never get committed.

## 2. Deploy on Render (free tier works)

1. Go to [render.com](https://render.com) → sign up / log in (you can sign in with your GitHub account).
2. **New → Web Service**, connect the `tnm-billing-template` repo you just pushed.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free is fine to start.
4. Under **Environment**, add:
   - `ANTHROPIC_API_KEY` — from the Anthropic console.
   - `ANTHROPIC_MODEL` — optional; defaults to `claude-sonnet-5`. Double-check this is still current at [platform.claude.com/docs/en/about-claude/pricing](https://platform.claude.com/docs/en/about-claude/pricing) before you deploy — Anthropic retires older model IDs periodically.
   - `ACCESS_CODE` — optional but recommended (see below).
   - `GOOGLE_SERVICE_ACCOUNT_KEY` — the base64 string from step 8 above.
   - `GOOGLE_SHEET_ID`, `GOOGLE_SHEET_TAB`, `GOOGLE_DRIVE_FOLDER_ID` — from the setup above.
5. Click **Create Web Service**. After the first build finishes (~1–2 min), Render gives you a URL like `https://tnm-billing-template.onrender.com`.

That URL is what you share with your team — open it, no sign-in, upload PDFs, fields fill in, rows land in the Sheet.

To redeploy after a code change: push to GitHub (`git push`), Render redeploys automatically.

## About the passcode (`ACCESS_CODE`)

Since this link has no login, **anyone who gets the URL can use it — and every use spends your Anthropic API key's balance and writes into your Sheet.** Setting `ACCESS_CODE` to any word or phrase puts a one-time passcode screen in front of the tool; your team enters it once per browser and it's remembered for that browsing session. Leave it blank only if you're fine with the link being fully open.

## Cost, storage, and rate limiting

- Each PDF makes one Anthropic API call (a few cents), one Drive upload, and one or two Sheets API calls — all free at normal team volumes (Google's free quotas are generous; the Sheets/Drive APIs themselves have no per-call cost).
- A built-in limiter caps each visitor at 20 extractions per minute so a runaway script can't blow through your budget, but it does **not** cap total spend on the Anthropic key — keep an eye on usage at console.anthropic.com.
- If the server isn't yet configured with the Google key/IDs, the page still works for AI extraction and export — it just shows a banner saying Sheet sync/PDF storage aren't set up, and rows only live in that browser tab until exported.

## Running it locally first (optional, to test before deploying)

```bash
cd tnm-billing-backend
npm install
cp .env.example .env
# edit .env and fill in ANTHROPIC_API_KEY plus the GOOGLE_* variables
npm start
```

Then open `http://localhost:3000`.

## Files in this folder

- `server.js` — the whole backend: serves the page, `POST /api/extract` (invoice text → fields), `POST /api/upload-invoice-file` (PDF → Drive, returns a link), `POST /api/sync-row` (fields + link → Sheet, upserted by a per-row key), `POST /api/verify-code` (passcode check).
- `public/index.html` — the tool itself (upload, table, export) — self-contained, no build step.
- `package.json` — dependencies (`express`, `@anthropic-ai/sdk`, `googleapis`, `multer`, `dotenv`).
- `.env.example` — copy to `.env` for local runs; never commit the real `.env`.
