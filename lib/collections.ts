import type { Product } from "./types"

// Page copy below is carried over unchanged from the original template and is flagged
// for the owner to replace (see design-system/chaanavya/MASTER.md, content rules).

export type CollectionGroup = { heading: string; intro: string; filter?: (p: Product) => boolean }

export type Collection = {
  slug: string
  title: string
  description: string
  eyebrow: string
  heading: [string, string]
  cta: string
  hero: { src: string; alt: string }
  groups: CollectionGroup[]
  match: (p: Product) => boolean
}

const hero = (id: string, alt: string) => ({ src: `https://images.unsplash.com/photo-${id}?w=1600&h=1067&q=75&auto=format&fit=crop`, alt })
const text = (p: Product) => `${p.title} ${p.productType} ${p.tags.join(" ")}`
const inCollection = (slug: string, pattern: RegExp) => (p: Product) => (p.collections ? p.collections.includes(slug) : pattern.test(text(p)))
const isFragrance = inCollection("fragrance", /perfume|fragrance|parfum/i)

export const collections: Collection[] = [
  {
    slug: "new-arrivals",
    title: "New Arrivals",
    description: "Chaanavya new arrivals: the latest dresses, sarees, jewelry and essentials.",
    eyebrow: "Fresh rotation / This week",
    heading: ["Just", "landed."],
    cta: "Shop collection",
    hero: hero("1566174053879-31528523f8ae", "Model in a deep amethyst gown"),
    groups: [{ heading: "New now. Yours first.", intro: "The newest gowns, sarees and finishing pieces, selected for the season ahead." }],
    match: p => (p.collections ? p.collections.includes("new-arrivals") : p.tags.includes("new-arrival")),
  },
  {
    slug: "dresses",
    title: "Dresses & Gowns",
    description: "Chaanavya dresses and gowns for day, evening and occasion wear.",
    eyebrow: "Silhouettes / Dresses & gowns",
    heading: ["Dressed", "to reign."],
    cta: "Shop collection",
    hero: hero("1566174053879-31528523f8ae", "Model in a floor-length amethyst evening gown"),
    groups: [{ heading: "Every hour, elevated.", intro: "From boardroom to ballroom: dresses and gowns cut to move with you." }],
    match: inCollection("dresses", /dress|gown|blouse/i),
  },
  {
    slug: "ethnic-festive",
    title: "Ethnic & Festive",
    description: "Chaanavya sarees, lehengas and festive wear.",
    eyebrow: "Heirloom craft / Sarees & lehengas",
    heading: ["Heritage,", "reworked."],
    cta: "Shop collection",
    hero: hero("1610030469983-98e550d6193c", "Model in a purple and gold zari-bordered silk saree"),
    groups: [{ heading: "Zari, silk and gold.", intro: "Handwoven sarees and festive lehengas, bordered in real zari and finished for the modern bride." }],
    match: inCollection("ethnic-festive", /saree|lehenga|ethnic|festive|bridal/i),
  },
  {
    slug: "jewelry",
    title: "Fine Jewelry",
    description: "Chaanavya jewelry: bangles, pearls and layered necklaces.",
    eyebrow: "Fine jewelry / Hand-set",
    heading: ["Crowned", "in gold."],
    cta: "Shop collection",
    hero: hero("1515562141207-7a88fb7ce338", "Pearl necklace resting in an open jewelry box"),
    groups: [{ heading: "Finishing touches.", intro: "18k gold vermeil, pearl and stone, made to be heirlooms." }],
    match: inCollection("jewelry", /jewel|necklace|earring|bangle|ring/i),
  },
  {
    slug: "essentials",
    title: "Essentials",
    description: "Chaanavya essentials: everyday knitwear and signature fragrance for women.",
    eyebrow: "Everyday luxe / Essentials",
    heading: ["Soft luxe.", "Every day."],
    cta: "Shop collection",
    hero: hero("1509319117193-57bab727e09d", "Soft knit and lace-trim layers on a clothing rack"),
    groups: [
      { heading: "Wardrobe, refined.", intro: "Cashmere-soft knits and lace-trim layers. Quiet luxury for daily wear.", filter: p => !isFragrance(p) },
      { heading: "Chaanavya fragrance.", intro: "Three signature eau de parfum blends, bottled in hand-finished glass and gold.", filter: isFragrance },
    ],
    match: inCollection("essentials", /essential|knit|perfume|fragrance|parfum/i),
  },
]

export const getCollection = (slug: string) => collections.find(c => c.slug === slug)

export function productsFor(collection: Collection, products: Product[]) {
  const matched = products.filter(collection.match)
  // A live store without "new-arrival" tags still shows its newest pieces.
  if (collection.slug === "new-arrivals" && matched.length === 0) return products.slice(0, 8)
  return matched
}
