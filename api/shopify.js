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
            quantityAvailable
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

function shopifyConfig() {
  if (process.env.SHOPIFY_USE_MOCK === 'true') {
    return { endpoint: `https://mock.shop/api/${API_VERSION}/graphql.json`, headers: {} };
  }

  const domain = (process.env.SHOPIFY_STORE_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_STOREFRONT_ACCESS_TOKEN;
  if (!domain || !token) return null;
  if (!/^[a-z0-9][a-z0-9.-]*$/i.test(domain)) throw new Error('Invalid Shopify store domain');

  return {
    endpoint: `https://${domain}/api/${API_VERSION}/graphql.json`,
    headers: { 'X-Shopify-Storefront-Access-Token': token },
  };
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).json({ error: 'Method not allowed' });

  const { action, variables = {} } = request.body || {};
  const query = operations[action];
  if (!query) return response.status(400).json({ error: 'Unsupported Shopify operation' });

  let config;
  try {
    config = shopifyConfig();
  } catch (error) {
    return response.status(500).json({ error: error.message });
  }
  if (!config) {
    return response.status(503).json({ error: 'Shopify is not configured' });
  }

  try {
    const shopifyResponse = await fetch(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...config.headers },
      body: JSON.stringify({ query, variables }),
    });
    const payload = await shopifyResponse.json();
    if (!shopifyResponse.ok || payload.errors) {
      console.error('Shopify Storefront API error', payload.errors || shopifyResponse.status);
      return response.status(502).json({ error: 'Shopify request failed', details: payload.errors || [] });
    }
    return response.status(200).json(payload.data);
  } catch (error) {
    console.error('Shopify network error', error);
    return response.status(502).json({ error: 'Unable to reach Shopify' });
  }
}
