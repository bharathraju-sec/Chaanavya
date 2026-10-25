import type { Metadata } from "next"
import Image from "next/image"
import { notFound } from "next/navigation"
import { ProductGrid } from "@/components/product/product-card"
import { ArrowLink } from "@/components/site/editorial"
import { Enter, HeroImage, MaskLines, Rise } from "@/components/motion/motion"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { getCollection, visibleCollections } from "@/lib/collections"
import { getCollectionProducts } from "@/lib/catalogue/storefront"
import Link from "next/link"

export const dynamicParams = false

export function generateStaticParams() {
  return visibleCollections.map(c => ({ collection: c.slug }))
}

export async function generateMetadata(props: PageProps<"/[collection]">): Promise<Metadata> {
  const collection = getCollection((await props.params).collection)
  if (!collection) return {}
  const cursor = (await props.searchParams).cursor
  const view = await getCollectionProducts(collection.slug, typeof cursor === "string" ? cursor : null)
  // Search engines should index a collection page only when it lists products. An empty collection,
  // an outage and the "Show more" pages are kept out of the index (links on them are still followed);
  // every view names the first page as its canonical address.
  const indexable = view.found && !view.unavailable && view.products.length > 0 && typeof cursor !== "string"
  return {
    title: collection.title,
    description: collection.description,
    alternates: { canonical: `/${collection.slug}` },
    ...(!indexable && { robots: { index: false, follow: true } }),
  }
}

export default async function CollectionPage(props: PageProps<"/[collection]">) {
  const collection = getCollection((await props.params).collection)
  if (!collection) notFound()

  // Products come from the collection API (Stage 10.08). A collection the owner has hidden, or a
  // malformed ?cursor, is a 404; an outage shows the unavailable message; an empty collection is a
  // normal empty state. The placeholder catalogue is never used here.
  const cursor = (await props.searchParams).cursor
  const view = await getCollectionProducts(collection.slug, typeof cursor === "string" ? cursor : null)
  if (!view.found) notFound()
  const { products: items, unavailable, nextCursor } = view

  return (
    <>
      <section className="page-wrap grid items-end gap-[clamp(32px,5vw,80px)] pt-[clamp(32px,4vw,56px)] pb-[clamp(48px,6vw,80px)] md:grid-cols-[5fr_7fr]">
        <div>
          <Breadcrumb className="mb-6 md:mb-[clamp(28px,5vw,72px)]">
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink asChild>
                  <Link href="/">Home</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>{collection.title}</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
          <Enter>
            <p className="eyebrow">{collection.eyebrow}</p>
          </Enter>
          <MaskLines lines={[...collection.heading]} className="mt-4 mb-7 text-[clamp(56px,7vw,112px)] leading-[0.92] tracking-[-0.02em]" />
          <Enter delay={0.4}>
            <ArrowLink href="#collection" down>
              {collection.cta}
            </ArrowLink>
          </Enter>
        </div>
        <HeroImage className="aspect-[4/3] w-full bg-well md:aspect-[3/2] md:max-h-[70svh]">
          <Image src={collection.hero.src} alt={collection.hero.alt} fill priority sizes="(min-width: 768px) 58vw, 100vw" className="object-cover" style={{ objectPosition: collection.hero.position ?? "50% 22%" }} />
        </HeroImage>
      </section>

      <div id="collection">
        {collection.groups.map((group, i) => {
          const groupItems = group.filter ? items.filter(group.filter) : items
          // During a store outage show one "unavailable" message under the first group only.
          if (unavailable ? i > 0 : group.filter && groupItems.length === 0) return null
          return (
            <section key={group.heading} className="page-wrap pb-[clamp(64px,9vw,128px)]">
              <Rise className="grid items-end gap-[clamp(24px,5vw,80px)] border-t border-line pt-[clamp(40px,5vw,72px)] pb-[clamp(28px,3vw,40px)] md:grid-cols-[5fr_7fr]">
                <h2 className="text-[clamp(34px,4vw,56px)]">{group.heading}</h2>
                <p className="max-w-[540px] text-[17px] leading-relaxed text-muted-foreground">{group.intro}</p>
              </Rise>
              <ProductGrid products={groupItems} columns={3} actionLabel="Add to bag" unavailable={unavailable} />
            </section>
          )
        })}
        {nextCursor && (
          <div className="page-wrap pb-[clamp(64px,9vw,128px)]">
            <ArrowLink href={`/${collection.slug}?cursor=${encodeURIComponent(nextCursor)}`}>Show more</ArrowLink>
          </div>
        )}
      </div>
    </>
  )
}
