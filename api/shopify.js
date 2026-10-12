const API_VERSION = process.env.SHOPIFY_STOREFRONT_API_VERSION || '2026-10';

const operations = {
  products: `query Products($first: Int!) {
    products(first: $first, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        handle
        title
        description
        productType
        tags
        featuredImage { url altText }
        variants(first: 20) {
          nodes {
            id
            title
            availableForSale
            image { url altText }
            price { amount currencyCode }
          }
        }
      }
    }
  }`,
  cart: `query Cart($id: ID!) {
    cart(id: $id) {
      ...CartFields
    }
  }
  fragment CartFields on Cart {
    id
    checkoutUrl
    totalQuantity
    cost {
      subtotalAmount { amount currencyCode }
      totalAmount { amount currencyCode }
    }
    lines(first: 100) {
      nodes {
        id
        quantity
        merchandise {
          ... on ProductVariant {
            id
            title
            availableForSale
            image { url altText }
            price { amount currencyCode }
            product { title handle featuredImage { url altText } }
          }
        }
      }
    }
  }`,
  cartCreate: `mutation CartCreate($input: CartInput!) {
    cartCreate(input: $input) {
      cart { ...CartFields }
      userErrors { field message code }
      warnings { code message target }
    }
  }
  fragment CartFields on Cart {
    id checkoutUrl totalQuantity
    cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
    lines(first: 100) { nodes { id quantity merchandise { ... on ProductVariant { id title availableForSale image { url altText } price { amount currencyCode } product { title handle featuredImage { url altText } } } } } }
  }`,
  cartLinesAdd: `mutation CartLinesAdd($cartId: ID!, $lines: [CartLineInput!]!) {
    cartLinesAdd(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { field message code }
      warnings { code message target }
    }
  }
  fragment CartFields on Cart {
    id checkoutUrl totalQuantity
    cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
    lines(first: 100) { nodes { id quantity merchandise { ... on ProductVariant { id title availableForSale image { url altText } price { amount currencyCode } product { title handle featuredImage { url altText } } } } } }
  }`,
  cartLinesUpdate: `mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
    cartLinesUpdate(cartId: $cartId, lines: $lines) {
      cart { ...CartFields }
      userErrors { field message code }
      warnings { code message target }
    }
  }
  fragment CartFields on Cart {
    id checkoutUrl totalQuantity
    cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
    lines(first: 100) { nodes { id quantity merchandise { ... on ProductVariant { id title availableForSale image { url altText } price { amount currencyCode } product { title handle featuredImage { url altText } } } } } }
  }`,
  cartLinesRemove: `mutation CartLinesRemove($cartId: ID!, $lineIds: [ID!]!) {
    cartLinesRemove(cartId: $cartId, lineIds: $lineIds) {
      cart { ...CartFields }
      userErrors { field message code }
      warnings { code message target }
    }
  }
  fragment CartFields on Cart {
    id checkoutUrl totalQuantity
    cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
    lines(first: 100) { nodes { id quantity merchandise { ... on ProductVariant { id title availableForSale image { url altText } price { amount currencyCode } product { title handle featuredImage { url altText } } } } } }
  }`,
};

const MAX_BODY_BYTES = 8 * 1024;
const MAX_QUANTITY = 99;
const MAX_LINES = 20;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX_REQUESTS = 60;
const SHOPIFY_TIMEOUT_MS = 8000;

// Shopify IDs look like gid://shopify/Cart/abc?key=xyz. Anything else is rejected before it reaches Shopify.
const isGid = type => value => typeof value === 'string' && value.length <= 300 && value.startsWith(`gid://shopify/${type}/`) && !/\s/.test(value);
const isCartId = isGid('Cart');
const isLineId = isGid('CartLine');
const isVariantId = isGid('ProductVariant');
const isQuantity = (value, min) => Number.isInteger(value) && value >= min && value <= MAX_QUANTITY;
const isList = (value, check) => Array.isArray(value) && value.length > 0 && value.length <= MAX_LINES && value.every(check);
const isNewLine = line => isVariantId(line?.merchandiseId) && isQuantity(line.quantity, 1);
const pickNewLine = ({ merchandiseId, quantity }) => ({ merchandiseId, quantity });

// Each validator returns a clean copy holding only the expected fields, or null to reject the request.
const validators = {
  products: ({ first }) => (Number.isInteger(first) && first >= 1 && first <= 50 ? { first } : null),
  cart: ({ id }) => (isCartId(id) ? { id } : null),
  cartCreate: ({ input }) => (isList(input?.lines, isNewLine) ? { input: { lines: input.lines.map(pickNewLine) } } : null),
  cartLinesAdd: ({ cartId, lines }) => (isCartId(cartId) && isList(lines, isNewLine) ? { cartId, lines: lines.map(pickNewLine) } : null),
  cartLinesUpdate: ({ cartId, lines }) =>
    isCartId(cartId) && isList(lines, line => isLineId(line?.id) && isQuantity(line.quantity, 0))
      ? { cartId, lines: lines.map(({ id, quantity }) => ({ id, quantity })) }
      : null,
  cartLinesRemove: ({ cartId, lineIds }) => (isCartId(cartId) && isList(lineIds, isLineId) ? { cartId, lineIds } : null),
};

// Best effort: counts live in this function instance's memory, so separate instances count separately.
// The Vercel Firewall rate-limit rule is the hard limit; this stops a single client hammering one instance.
const hits = new Map();
function retryAfterSeconds(ip) {
  const now = Date.now();
  if (hits.size > 5000) {
    for (const [key, entry] of hits) if (now - entry.start > RATE_WINDOW_MS) hits.delete(key);
  }
  const entry = hits.get(ip);
  if (!entry || now - entry.start > RATE_WINDOW_MS) {
    hits.set(ip, { start: now, count: 1 });
    return 0;
  }
  entry.count += 1;
  return entry.count > RATE_MAX_REQUESTS ? Math.ceil((entry.start + RATE_WINDOW_MS - now) / 1000) : 0;
}

// Vercel overwrites x-forwarded-for at the edge, so clients cannot spoof it.
const clientIp = request => String(request.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';

// Blocks other websites from using this endpoint through their visitors' browsers.
// Non-browser clients can send any headers they like; rate limiting covers them.
function isOwnSite(request) {
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite) return fetchSite === 'same-origin';
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).host;
    return host === request.headers.host || host === request.headers['x-forwarded-host'];
  } catch {
    return false;
  }
}

function shopifyConfig() {
  // Mock catalogue is for local testing only and can never be switched on in production.
  if (process.env.SHOPIFY_USE_MOCK === 'true' && process.env.VERCEL_ENV !== 'production') {
    return { endpoint: `https://mock.shop/api/${API_VERSION}/graphql.json`, headers: {} };
  }

  const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (!domain || !token) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(domain)) throw new Error('Invalid SHOPIFY_STORE_DOMAIN');
  if (!/^(\d{4}-\d{2}|unstable)$/.test(API_VERSION)) throw new Error('Invalid SHOPIFY_STOREFRONT_API_VERSION');

  return {
    endpoint: `https://${domain}/api/${API_VERSION}/graphql.json`,
    headers: { 'X-Shopify-Storefront-Access-Token': token },
  };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (!isOwnSite(request)) return response.status(403).json({ error: 'Forbidden' });

  const retryAfter = retryAfterSeconds(clientIp(request));
  if (retryAfter) {
    response.setHeader('Retry-After', String(retryAfter));
    return response.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
  }

  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    return response.status(415).json({ error: 'Unsupported content type' });
  }
  if (Number(request.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    return response.status(413).json({ error: 'Request too large' });
  }

  let body;
  try {
    body = request.body;
  } catch {
    return response.status(400).json({ error: 'Invalid request' });
  }
  const { action, variables } = body && typeof body === 'object' ? body : {};
  if (typeof action !== 'string' || !Object.hasOwn(operations, action)) {
    return response.status(400).json({ error: 'Unsupported Shopify operation' });
  }
  const cleanVariables = variables && typeof variables === 'object' && !Array.isArray(variables) ? validators[action](variables) : null;
  if (!cleanVariables) return response.status(400).json({ error: 'Invalid request' });

  let config;
  try {
    config = shopifyConfig();
  } catch (error) {
    console.error('Shopify configuration error:', error.message);
    return response.status(500).json({ error: 'Store service unavailable' });
  }
  if (!config) {
    return response.status(503).json({ error: 'Store service unavailable' });
  }

  try {
    const shopifyResponse = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...config.headers },
      body: JSON.stringify({ query: operations[action], variables: cleanVariables }),
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    });
    const payload = await shopifyResponse.json();
    if (!shopifyResponse.ok || payload.errors) {
      console.error('Shopify Storefront API error', payload.errors || shopifyResponse.status);
      return response.status(502).json({ error: 'Store service unavailable' });
    }
    return response.status(200).json(payload.data);
  } catch (error) {
    console.error('Shopify network error', error);
    return response.status(502).json({ error: 'Store service unavailable' });
  }
}
