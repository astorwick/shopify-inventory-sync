require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');

const app = express();

const {
  SHOPIFY_TOKEN,
  SHOPIFY_STORE_DOMAIN,
  SHOPIFY_WEBHOOK_SECRET,
  PORT = 3000,
} = process.env;

// ── Loop prevention ──────────────────────────────────────────────────────────
// When we set inventory on item B, Shopify fires a webhook for B. We track
// recently-set (item, quantity) pairs so we can skip that echo webhook.

const recentlySet = new Map(); // key: `${inventory_item_id}:${available}` → timestamp
const DEDUP_TTL_MS = 10_000;

function markAsSet(inventoryItemId, available) {
  recentlySet.set(`${inventoryItemId}:${available}`, Date.now());
}

function wasRecentlySet(inventoryItemId, available) {
  const key = `${inventoryItemId}:${available}`;
  const ts = recentlySet.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL_MS) {
    recentlySet.delete(key);
    return false;
  }
  return true;
}

// ── Shopify API helpers ──────────────────────────────────────────────────────

const API_VERSION = '2025-01';
const BASE_URL = `https://${SHOPIFY_STORE_DOMAIN}/admin/api/${API_VERSION}`;

async function shopifyGraphQL(query, variables = {}) {
  const res = await fetch(`${BASE_URL}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL request failed: ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(errors)}`);
  return data;
}

async function getSkuForInventoryItem(inventoryItemId) {
  const data = await shopifyGraphQL(
    `query GetSku($id: ID!) {
      inventoryItem(id: $id) { sku }
    }`,
    { id: `gid://shopify/InventoryItem/${inventoryItemId}` }
  );
  return data?.inventoryItem?.sku || null;
}

async function getVariantsBySku(sku) {
  // Wrap in quotes for exact match; escape any quotes in the SKU itself
  const escaped = sku.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const data = await shopifyGraphQL(
    `query FindBySku($q: String!) {
      productVariants(first: 50, query: $q) {
        edges {
          node {
            id
            inventoryItem { id tracked }
          }
        }
      }
    }`,
    { q: `sku:"${escaped}"` }
  );
  return data?.productVariants?.edges?.map(e => e.node) ?? [];
}

async function setInventoryLevel(inventoryItemId, locationId, available) {
  const res = await fetch(`${BASE_URL}/inventory_levels/set.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN,
    },
    body: JSON.stringify({ inventory_item_id: inventoryItemId, location_id: locationId, available }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${res.status} ${body}`);
  }
}

// ── HMAC verification ────────────────────────────────────────────────────────

function verifyHmac(rawBody, hmacHeader) {
  const digest = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(hmacHeader));
  } catch {
    return false;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Rate limiter — drops excessive requests before they reach HMAC verification
const webhookLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});

// Health check — used by hosting platforms and uptime monitors
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Shopify requires the raw body for HMAC verification, so we use express.raw
// on this route only rather than global express.json()
app.post('/webhook', webhookLimiter, express.raw({ type: 'application/json' }), async (req, res) => {
  const hmac = req.headers['x-shopify-hmac-sha256'];
  if (!hmac || !verifyHmac(req.body, hmac)) {
    return res.status(401).send('Unauthorized');
  }

  // Respond immediately — Shopify retries if it doesn't get a 2xx within 5s
  res.status(200).send('OK');

  let payload;
  try {
    payload = JSON.parse(req.body.toString());
  } catch {
    console.error('[webhook] Failed to parse payload');
    return;
  }

  const { inventory_item_id, location_id, available } = payload;

  if (wasRecentlySet(inventory_item_id, available)) {
    console.log(`[sync] Skipping echo for item ${inventory_item_id} @ qty ${available}`);
    return;
  }

  try {
    const sku = await getSkuForInventoryItem(inventory_item_id);
    if (!sku) {
      console.log(`[sync] Item ${inventory_item_id} has no SKU — skipping`);
      return;
    }

    const variants = await getVariantsBySku(sku);

    // Exclude the variant that triggered this webhook and any untracked items
    const targets = variants.filter(v => {
      const numericId = v.inventoryItem.id.replace('gid://shopify/InventoryItem/', '');
      return numericId !== String(inventory_item_id) && v.inventoryItem.tracked;
    });

    if (targets.length === 0) {
      console.log(`[sync] SKU "${sku}" — no other tracked variants to sync`);
      return;
    }

    console.log(`[sync] SKU "${sku}" — syncing ${targets.length} variant(s) to qty ${available}`);

    for (const variant of targets) {
      const itemId = Number(variant.inventoryItem.id.replace('gid://shopify/InventoryItem/', ''));
      try {
        markAsSet(itemId, available);
        await setInventoryLevel(itemId, location_id, available);
        console.log(`[sync]   ✓ item ${itemId} → ${available}`);
      } catch (err) {
        console.error(`[sync]   ✗ item ${itemId}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[sync] Unhandled error:', err.message);
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Shopify inventory sync listening on port ${PORT}`);
});
