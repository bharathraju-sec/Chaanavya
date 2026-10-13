import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ProductGrid } from "@/components/product/product-card"
import { ProductPurchase } from "@/components/product/product-purchase"
import { SectionHead } from "@/components/site/editorial"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { collections } from "@/lib/collections"
import { getProduct, getProducts } from "@/lib/shopify"

export async function generateMetadata(props: PageProps<"/products/[handle]">): Promise<Metadata> {
  const { product } = await getProduct((await props.params).handle)
  if (!product) return {}
  return {
    title: product.title,
    description: product.description.slice(0, 160) || `${product.title} at Chaanavya.`,
    openGraph: product.featuredImage ? { images: [product.featuredImage.url] } : undefined,
  }
}

export default async function ProductPage(props: PageProps<"/products/[handle]">) {
  const { product } = await getProduct((await props.params).handle)
  if (!product) notFound()

  const collection = collections.find(c => c.match(product))
  const images = product.images.length ? product.images : product.featuredImage ? [product.featuredImage] : []
  const { products } = await getProducts()
  const related = (collection ? products.filter(p => p.handle !== product.handle && collection.match(p)) : []).slice(0, 4)

  return (
    <>
      <div className="page-wrap pt-[clamp(24px,3vw,40px)]">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link href="/">Home</Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            {collection && (
              <>
                <BreadcrumbItem>
                  <BreadcrumbLink asChild>
                    <Link href={`/${collection.slug}`}>{collection.title}</Link>
                  </BreadcrumbLink>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            )}
            <BreadcrumbItem>
              <BreadcrumbPage>{product.title}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <section className="page-wrap grid gap-[clamp(32px,5vw,80px)] pt-6 pb-[clamp(64px,9vw,128px)] md:grid-cols-[7fr_5fr]">
        {/* Gallery: stacked on desktop, swipeable strip on phones. */}
        <div className="-mx-[clamp(16px,4vw,56px)] flex snap-x snap-mandatory gap-3 overflow-x-auto px-[clamp(16px,4vw,56px)] md:mx-0 md:grid md:grid-cols-2 md:overflow-visible md:px-0">
          {images.map((image, i) => (
            <div key={image.url} className={`relative aspect-[4/5] w-[85%] shrink-0 snap-start overflow-hidden bg-well md:w-auto ${i === 0 ? "md:col-span-2" : ""}`}>
              <Image src={image.url} alt={image.altText || (i === 0 ? product.title : "")} fill priority={i === 0} sizes={i === 0 ? "(min-width: 768px) 58vw, 85vw" : "(min-width: 768px) 29vw, 85vw"} className="object-cover" />
            </div>
          ))}
          {images.length === 0 && <div className="aspect-[4/5] w-full bg-well md:col-span-2" />}
        </div>

        <div className="md:sticky md:top-[150px] md:self-start">
          {product.productType && <p className="eyebrow">{product.productType}</p>}
          <h1 className="mt-3 mb-4 text-[clamp(40px,4.4vw,64px)] leading-[0.98]">{product.title}</h1>
          <ProductPurchase product={product} />
          {product.description && <p className="mt-10 text-[15px] leading-relaxed text-muted-foreground">{product.description}</p>}
          <Accordion type="multiple" className="mt-8 border-t border-line">
            {[
              { value: "shipping", title: "Shipping", href: "/shipping-policy", link: "Read the shipping policy" },
              { value: "returns", title: "Returns & refunds", href: "/refund-policy", link: "Read the returns policy" },
              { value: "size", title: "Size & fit", href: "/size-guide", link: "Open the size guide" },
            ].map(item => (
              <AccordionItem key={item.value} value={item.value} className="border-b border-line">
                <AccordionTrigger className="label-caps rounded-none py-5 hover:no-underline">{item.title}</AccordionTrigger>
                <AccordionContent className="pb-5 text-[15px]">
                  <Link href={item.href} className="underline underline-offset-4 hover:text-terra">
                    {item.link}
                  </Link>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>

      {related.length > 0 && collection && (
        <section className="page-wrap border-t border-line section-y">
          <SectionHead eyebrow={collection.title} title="You may also like" link={{ href: `/${collection.slug}`, label: "View the collection" }} />
          <ProductGrid products={related} />
        </section>
      )}
    </>
  )
}
