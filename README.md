# JIG Dialer + CRM (SignalWire)

Black-and-white lead CRM with a "call me first" dialer.
Rep clicks Call -> SignalWire rings the rep's cell -> rep answers, presses 1 -> lead is dialed and bridged.
Caller ID the lead sees = your SignalWire number. Cost ~ $0.016/min (two legs at $0.008) + $0.50/mo number.

## 1. SignalWire
1. signalwire.com > Sign up. Create a Space (pick a name, e.g. jacksoninvest -> jacksoninvest.signalwire.com).
2. Billing > add $10 (minimum to leave trial mode is $5).
3. Phone Numbers > Buy a number > US local, pick an area code (216 Cleveland, 713 Houston, 602 Phoenix).
4. API (left menu) > copy Project ID, Space URL, and create/copy an API token (starts with PT).
   No webhook to set on the number; the dialer tells SignalWire what to do on each call.

## 2. Cloudflare D1 database
Cloudflare > Storage & Databases > D1 > Create > name it jig-dialer > copy the Database ID
into wrangler.jsonc (replace PASTE_D1_DATABASE_ID_HERE). Tables create themselves.

## 3. GitHub
New private repo jig-dialer > Add file > Upload files > drag in worker.js, wrangler.jsonc, README.md
and the public folder (public/index.html, plus public/logo.png if you have a logo) > Commit.

## 4. Cloudflare Worker
Workers & Pages > Create > Import a repository > pick jig-dialer > Deploy.
Worker name must be jig-dialer (matches wrangler.jsonc).
Then Settings > Variables and secrets > add (type Secret for the token):
  SW_SPACE       jacksoninvest.signalwire.com
  SW_PROJECT_ID  your Project ID
  SW_API_TOKEN   your PT... token
  SW_FROM        your SignalWire number as +1XXXXXXXXXX
  TEAM_PASSWORD  (optional, default JIG-dial-2026)
  OWNER_PASSWORD (optional, default JIG-owner-2026)
Redeploy after adding variables.

## 5. Use it
Open https://jig-dialer.<your-subdomain>.workers.dev
Sign in with the owner password > Owner tab > import the formatted Cleveland/Houston CSVs.
Each rep signs in with their name + team password and clicks "Add my cell" once.
