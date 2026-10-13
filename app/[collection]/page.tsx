import type { Metadata } from "next"
import Image from "next/image"
import { notFound } from "next/navigation"
import { ProductGrid } from "@/components/product/product-card"
import { ArrowLink } from "@/components/site/editorial"
import { Reveal } from "@/components/site/reveal"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { collections, getCollection, productsFor } from "@/lib/collections"
import { getProducts } from "@/lib/shopify"
import Link from "next/link"

export const dynamicParams = false

export function generateStaticParams() {
  return collections.map(c => ({ collection: c.slug }))
}

export async function generateMetadata(props: PageProps<"/[collection]">): Promise<Metadata> {
  const collection = getCollection((await props.params).collection)
  return collection ? { title: collection.title, description: collection.description } : {}
}

export default async function CollectionPage(props: PageProps<"/[collection]">) {
  const collection = getCollection((await props.params).collection)
  if (!collection) notFound()

  const { products } = await getProducts()
  const items = productsFor(collection, products)

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
          <p className="eyebrow">{collection.eyebrow}</p>
          <h1 className="mt-4 mb-7 text-[clamp(56px,7vw,112px)] leading-[0.92] tracking-[-0.02em]">
            {collection.heading[0]}
            <br />
            {collection.heading[1]}
          </h1>
          <ArrowLink href="#collection" down>
            {collection.cta}
          </ArrowLink>
        </div>
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-well md:aspect-[3/2] md:max-h-[70svh]">
          <Image src={collection.hero.src} alt={collection.hero.alt} fill priority sizes="(min-width: 768px) 58vw, 100vw" className="object-cover object-[50%_22%]" />
        </div>
      </section>

      <div id="collection">
        {collection.groups.map(group => {
          const groupItems = group.filter ? items.filter(group.filter) : items
          if (group.filter && groupItems.length === 0) return null
          return (
            <Reveal key={group.heading} className="page-wrap pb-[clamp(64px,9vw,128px)]">
              <div className="grid items-end gap-[clamp(24px,5vw,80px)] border-t border-line pt-[clamp(40px,5vw,72px)] pb-[clamp(28px,3vw,40px)] md:grid-cols-[5fr_7fr]">
                <h2 className="text-[clamp(34px,4vw,56px)]">{group.heading}</h2>
                <p className="max-w-[540px] text-[17px] leading-relaxed text-muted-foreground">{group.intro}</p>
              </div>
              <ProductGrid products={groupItems} columns={3} actionLabel="Add to bag" />
            </Reveal>
          )
        })}
      </div>
    </>
  )
}
