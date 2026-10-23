import type { Product, Variant } from "./types"

// Placeholder catalogue: the template products from the original site. Names, photos and prices are
// placeholders until real products are entered in the admin (Stage 07) and served from the database
// (Stage 10). Checkout stays closed meanwhile.

const unsplash = (id: string) => `https://images.unsplash.com/photo-${id}?w=1200&q=75&auto=format&fit=crop`

const SIZES = ["XS", "S", "M", "L", "XL"]

function variants(handle: string, price: number, options: string[]): Variant[] {
  return options.map(title => ({
    id: `demo:${handle}:${title}`,
    title,
    availableForSale: true,
    price: { amount: String(price), currencyCode: "INR" },
    selectedOptions: [{ name: "Size", value: title }],
  }))
}

type Seed = {
  handle: string
  title: string
  description: string
  productType: string
  image: string
  alt: string
  price: number
  options: string[]
  collections: string[]
  tags?: string[]
}

const seeds: Seed[] = [
  { handle: "merlot-wrap-dress", title: "Merlot Wrap Dress", description: "Silk-blend crepe · Merlot", productType: "Dress", image: unsplash("1585487000160-6ebcfceb0d03"), alt: "Model in a merlot wrap dress", price: 3499, options: SIZES, collections: ["new-arrivals", "dresses"], tags: ["new-arrival"] },
  { handle: "sovereign-trench-coat", title: "Sovereign Trench Coat", description: "Wool-blend twill · Deep Plum", productType: "Outerwear", image: unsplash("1483985988355-763728e1935b"), alt: "Model in a plum trench coat", price: 4999, options: SIZES, collections: ["new-arrivals"], tags: ["new-arrival"] },
  { handle: "zari-silk-saree", title: "Zari Silk Saree", description: "Handwoven silk · Fuchsia & Gold", productType: "Saree", image: unsplash("1617627143750-d86bc21e42bb"), alt: "Model in a fuchsia and gold zari silk saree", price: 6999, options: ["Free Size"], collections: ["new-arrivals", "ethnic-festive"], tags: ["new-arrival"] },
  { handle: "noir-sheer-blouse", title: "Noir Sheer Blouse", description: "Georgette · Black", productType: "Blouse", image: unsplash("1524504388940-b1c1722653e1"), alt: "Model in a black sheer blouse", price: 1799, options: SIZES, collections: ["new-arrivals", "dresses"], tags: ["new-arrival"] },
  { handle: "amethyst-gown", title: "Amethyst Gown", description: "Off-shoulder crepe · Amethyst", productType: "Gown", image: unsplash("1566174053879-31528523f8ae"), alt: "Model in a floor-length amethyst evening gown", price: 5499, options: SIZES, collections: ["dresses"] },
  { handle: "heritage-saree", title: "Heritage Sarees", description: "Banarasi silk · Purple & Gold", productType: "Saree", image: unsplash("1610030469983-98e550d6193c"), alt: "Model in a purple and gold zari-bordered silk saree", price: 8499, options: ["Free Size"], collections: ["ethnic-festive"] },
  { handle: "zari-lehenga", title: "Zari Lehengas", description: "Hand-embroidered · Fuchsia & Gold", productType: "Lehenga", image: unsplash("1617627143750-d86bc21e42bb"), alt: "Model in a fuchsia and gold occasion drape", price: 12999, options: ["Free Size"], collections: ["ethnic-festive"] },
  { handle: "bridal-jewellery-set", title: "Bridal Jewellery Set", description: "22k gold vermeil · Bridal edit", productType: "Jewellery", image: unsplash("1596944924616-7b38e7cfac36"), alt: "Gold bangles and rings on a model's wrists", price: 4999, options: ["One Size"], collections: ["ethnic-festive", "jewellery"] },
  { handle: "aurum-bangles", title: "Aurum Bangles", description: "18k gold vermeil · Set of 4", productType: "Jewellery", image: unsplash("1596944924616-7b38e7cfac36"), alt: "Aurum bangle set", price: 6999, options: ["One Size"], collections: ["jewellery"] },
  { handle: "heirloom-pearls", title: "Heirloom Pearls", description: "Freshwater pearl · Silver clasp", productType: "Jewellery", image: unsplash("1515562141207-7a88fb7ce338"), alt: "Pearl necklace resting in an open jewellery box", price: 5499, options: ["One Size"], collections: ["jewellery"] },
  { handle: "crescent-layer-set", title: "Crescent Layer Set", description: "Gold vermeil · Cut stone pendant", productType: "Jewellery", image: unsplash("1599643478518-a784e5dc4c8f"), alt: "Layered gold necklaces with a crescent and gemstone pendant", price: 3999, options: ["One Size"], collections: ["jewellery"] },
  { handle: "royal-oud", title: "Royal Oud", description: "Amber, oud, saffron · 50ml", productType: "Perfume", image: "/assets/perfume-royal-oud-classic.png", alt: "Royal Oud eau de parfum bottle", price: 2499, options: ["50 ML"], collections: ["fragrance"] },
  { handle: "gilded-rose", title: "Gilded Rose", description: "Rose, peony, gold musk · 50ml", productType: "Perfume", image: "/assets/perfume-gilded-rose-classic.png", alt: "Gilded Rose eau de parfum bottle", price: 2299, options: ["50 ML"], collections: ["fragrance"] },
  { handle: "midnight-court", title: "Midnight Court", description: "Plum, vanilla, dark woods · 50ml", productType: "Perfume", image: "/assets/perfume-midnight-court-classic.png", alt: "Midnight Court eau de parfum bottle", price: 2499, options: ["50 ML"], collections: ["fragrance"] },
]

export const fallbackProducts: Product[] = seeds.map(seed => {
  const image = { url: seed.image, altText: seed.alt }
  return {
    id: `demo:${seed.handle}`,
    handle: seed.handle,
    title: seed.title,
    description: seed.description,
    productType: seed.productType,
    tags: seed.tags ?? [],
    featuredImage: image,
    images: [image],
    variants: variants(seed.handle, seed.price, seed.options),
    options: [{ name: "Size", values: seed.options }],
    collections: seed.collections,
  }
})
