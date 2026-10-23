import type { Metadata } from "next"
import Link from "next/link"
import { notFound, permanentRedirect } from "next/navigation"
import { ProductGrid } from "@/components/product/product-card"
import { ProductGallery } from "@/components/product/product-gallery"
import { ProductPurchase } from "@/components/product/product-purchase"
import { SectionHead } from "@/components/site/editorial"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from "@/components/ui/breadcrumb"
import { collections } from "@/lib/collections"
import { getCollectionProducts, getProductView } from "@/lib/catalogue/storefront"

const pathFor = (handle: string) => `/products/${handle}`

/** Up to four other published products from the same collection. */
async function relatedIn(slug: string, handle: string) {
  const view = await getCollectionProducts(slug)
  return view.found ? view.products.filter(p => p.handle !== handle).slice(0, 4) : []
}

export async function generateMetadata(props: PageProps<"/products/[handle]">): Promise<Metadata> {
  const handle = (await props.params).handle
  const view = await getProductView(handle.toLowerCase())
  if (!view.found) return {}
  // During an outage the page says so; it must not be indexed in that state.
  if (view.unavailable) return { title: "Temporarily unavailable", robots: { index: false } }
  const { product } = view
  return {
    title: product.title,
    description: product.description.slice(0, 160) || `${product.title} at Chaanavya.`,
    alternates: { canonical: pathFor(product.handle) },
    openGraph: product.featuredImage ? { images: [product.featuredImage.url] } : undefined,
  }
}

export default async function ProductPage(props: PageProps<"/products/[handle]">) {
  const handle = (await props.params).handle
  // Handles are lowercase; any other spelling of a link goes to the canonical one.
  if (handle !== handle.toLowerCase()) permanentRedirect(pathFor(handle.toLowerCase()))
  const variantParam = (await props.searchParams).variant
  const view = await getProductView(handle, typeof variantParam === "string" ? variantParam : null)
  // Missing and hidden products are the same 404; the placeholder catalogue is never used here.
  if (!view.found) notFound()
  if (view.unavailable) {
    return (
      <section className="page-wrap py-[clamp(64px,9vw,128px)] text-center">
        <p role="status" className="font-serif text-2xl">
          This product is temporarily unavailable. Please try again in a few minutes.
        </p>
        <p className="mt-6">
          <Link href="/" className="underline underline-offset-4 hover:text-terra">
            Back to the shop
          </Link>
        </p>
      </section>
    )
  }
  const { product } = view

  const collection = collections.find(c => c.match(product))
  const images = product.images.length ? product.images : product.featuredImage ? [product.featuredImage] : []
  const related = collection ? await relatedIn(collection.slug, product.handle) : []

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
        {/* Gallery: main slider with a thumbnail strip (swipe, arrows, thumbnails, arrow keys). */}
        <ProductGallery images={images} title={product.title} />

        <div className="md:sticky md:top-[150px] md:self-start">
          {product.productType && <p className="eyebrow">{product.productType}</p>}
          <h1 className="mt-3 mb-4 text-[clamp(40px,4.4vw,64px)] leading-[0.98]">{product.title}</h1>
          <ProductPurchase product={product} initialVariantId={view.selectedBy === "requested" ? view.selectedVariantId : null} />
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
