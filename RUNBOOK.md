# Shopify Inventory Sync — Runbook

## What this does
Automatically keeps inventory quantities in sync across Shopify product variants that share the same SKU. When inventory changes on one variant, all other variants store-wide with the same SKU are updated to match in real time.

This prevents overselling when the same physical inventory pool is represented by multiple product listings.

## How it works
1. Shopify detects an inventory change and sends a webhook notification to this service
2. The service looks up the SKU for the changed item
3. It finds all other variants in the store with that same SKU
4. It updates their inventory quantities to match

## Where it lives
- **Code:** GitHub — `shopify-inventory-sync` repository
- **Hosting:** Railway (check the org's Railway workspace for the project)
- **Live URL:** `https://shopify-inventory-sync-production-7b49.up.railway.app`

## Credentials
Stored as environment variables in the Railway project (Settings → Variables). Never stored in the code or GitHub. Three variables are required:
- `SHOPIFY_TOKEN` — Shopify Admin API access token
- `SHOPIFY_STORE_DOMAIN` — the store's myshopify.com domain
- `SHOPIFY_WEBHOOK_SECRET` — used to verify webhooks are genuinely from Shopify

## Important: the webhook is not visible in Shopify admin
The webhook was created via the Shopify API, not through the Shopify admin UI. This means it will **not** appear under Settings → Notifications → Webhooks in Shopify. It can only be viewed or managed via the API (see commands below).

## How to view the registered webhook
Run this in PowerShell, substituting your Shopify store domain and access token:

```powershell
Invoke-RestMethod -Method Get `
  -Uri "https://YOUR_STORE.myshopify.com/admin/api/2025-01/webhooks.json" `
  -Headers @{"X-Shopify-Access-Token" = "YOUR_SHOPIFY_TOKEN"}
```

## How to stop the sync

**Option 1 — Delete the webhook (recommended)**
This stops Shopify from sending notifications. The Railway service keeps running but receives nothing.

First, get the webhook ID using the view command above. Then:

```powershell
Invoke-RestMethod -Method Delete `
  -Uri "https://YOUR_STORE.myshopify.com/admin/api/2025-01/webhooks/WEBHOOK_ID.json" `
  -Headers @{"X-Shopify-Access-Token" = "YOUR_SHOPIFY_TOKEN"}
```

**Option 2 — Shut down the Railway service**
In the Railway dashboard, open the project and select **Remove** or disable the deployment. Without a running service, Shopify webhooks will fail to deliver and eventually stop retrying.

**Option 3 — Remove Railway environment variables**
Deleting the variables in Railway → Settings → Variables will cause the service to crash on startup and stop processing webhooks.

## How to monitor it
- **Railway logs:** Railway dashboard → project → Deployments → View logs
- Healthy log output looks like:
  ```
  [sync] SKU "ABC123" — syncing 2 variant(s) to qty 5
  [sync]   ✓ item 123456 → 5
  ```
- Railway will send an email alert if the service goes down

## Planned future work (Phase 2)
Extend this service to also sync inventory between the retail store and the wholesale store when the wholesale store goes live. Requires:
1. Registering the same webhook on the wholesale store (pointing to the same Railway URL)
2. Adding the wholesale store's credentials as additional Railway environment variables
3. Minor code changes to `server.js`
