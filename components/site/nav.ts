import { isHiddenPath } from "@/lib/collections"

const visible = (link: { href: string }) => !isHiddenPath(link.href)

export const mainNav = [
  { href: "/new-arrivals", label: "New In" },
  { href: "/dresses", label: "Dresses" },
  { href: "/ethnic-festive", label: "Ethnic & Festive" },
  { href: "/jewelry", label: "Jewellery" },
  { href: "/fragrance", label: "Fragrance" },
  { href: "/contact", label: "Contact" },
].filter(visible)

export const footerNav = [
  {
    heading: "Shop",
    links: [
      { href: "/new-arrivals", label: "New arrivals" },
      { href: "/dresses", label: "Dresses" },
      { href: "/ethnic-festive", label: "Sarees & lehengas" },
      { href: "/jewelry", label: "Fine jewellery" },
      { href: "/fragrance", label: "Fragrance" },
    ].filter(visible),
  },
  {
    heading: "Help",
    links: [
      { href: "/track-order", label: "Track order" },
      { href: "/contact", label: "Contact" },
      { href: "/size-guide", label: "Size guide" },
    ],
  },
  {
    heading: "Policies",
    links: [
      { href: "/shipping-policy", label: "Shipping" },
      { href: "/refund-policy", label: "Returns & refunds" },
      { href: "/privacy-policy", label: "Privacy" },
      { href: "/terms", label: "Terms" },
    ],
  },
]
