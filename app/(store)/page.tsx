import type { Metadata } from "next"
import Image from "next/image"
import Link from "next/link"
import { ArrowRight, ArrowUpRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProductGrid } from "@/components/product/product-card"
import { ArrowLink, SectionHead } from "@/components/site/editorial"
import { Enter, HeroImage, ImageReveal, MaskLines, Rise, Stagger, StaggerItem } from "@/components/motion/motion"
import { isHiddenPath } from "@/lib/collections"
import { cn } from "@/lib/utils"
import { getNewArrivals } from "@/lib/catalogue/storefront"

// Headlines and body copy here are carried over from the template and flagged for the owner.
// Motion (2026 redesign, approved 25 October 2026): the hero headline rises line by line, the hero
// photo settles and drifts, sections and grids arrive in sequence, photos uncover with a wipe.

export const metadata: Metadata = { alternates: { canonical: "/" } }

const photo = (id: string, w: number, h?: number) =>
  `https://images.unsplash.com/photo-${id}?w=${w}${h ? `&h=${h}` : ""}&q=75&auto=format&fit=crop`

type Tile = { image: string; kicker: string; title: string; href: string; cta: string }

function Tiles({ tiles: all, lead }: { tiles: Tile[]; lead?: boolean }) {
  // Tiles linking to a hidden collection drop out; two tiles share one row instead of three.
  const tiles = all.filter(tile => !isHiddenPath(tile.href))
  const columns = tiles.length === 2 ? (lead ? "lg:grid-cols-[1.5fr_1fr]" : "lg:grid-cols-2") : lead ? "lg:grid-cols-[1.5fr_1fr_1fr]" : "lg:grid-cols-3"
  return (
    <Stagger className={cn("grid gap-[clamp(16px,2vw,28px)] sm:grid-cols-2", columns)}>
      {tiles.map((tile, i) => (
        <StaggerItem key={tile.title} className={cn("min-w-0", i === 0 && tiles.length % 2 === 1 && "sm:col-span-2 lg:col-span-1")}>
          <article className="group/tile flex flex-col">
            <ImageReveal className="bg-well">
              <Link href={tile.href} tabIndex={-1} aria-hidden className="relative block h-[clamp(340px,46vw,680px)] overflow-hidden">
                <Image src={tile.image} alt="" fill sizes="(min-width: 1024px) 40vw, 100vw" className="object-cover object-[50%_20%] transition-transform duration-[900ms] ease-editorial group-hover/tile:scale-[1.05]" />
                <span className="absolute right-4 bottom-4 flex size-11 items-center justify-center bg-paper text-ink transition-transform duration-500 ease-editorial group-hover/tile:translate-x-1 group-hover/tile:-translate-y-1">
                  <ArrowUpRight className="size-5" strokeWidth={1.5} />
                </span>
              </Link>
            </ImageReveal>
            <div className="flex flex-col items-start gap-2 pt-5">
              <p className="eyebrow">{tile.kicker}</p>
              <h3 className="text-[clamp(28px,2.6vw,40px)]">{tile.title}</h3>
              <ArrowLink href={tile.href} aria-label={`${tile.cta}: ${tile.title}`}>
                {tile.cta}
              </ArrowLink>
            </div>
          </article>
        </StaggerItem>
      ))}
    </Stagger>
  )
}

function Feature({
  image,
  alt,
  kicker,
  title,
  body,
  primary,
  secondary,
  tone,
  reverse,
  id,
}: {
  image: string
  alt: string
  kicker: string
  title: [string, string]
  body: string
  primary: { href: string; label: string }
  secondary?: { href: string; label: string }
  tone: "dark" | "sand"
  reverse?: boolean
  id: string
}) {
  const dark = tone === "dark"
  return (
    <section id={id} className={cn("grid md:grid-cols-2", dark ? "bg-ink text-on-dark" : "bg-sand")}>
      <ImageReveal className={cn("aspect-[4/5] max-h-[640px] bg-well md:aspect-auto md:max-h-none md:min-h-[clamp(460px,54vw,800px)]", reverse && "md:order-2")}>
        <Image src={image} alt={alt} fill sizes="(min-width: 768px) 50vw, 100vw" className="object-cover" />
      </ImageReveal>
      <Stagger className="flex flex-col items-start justify-center px-[clamp(16px,4vw,56px)] py-16 md:p-[clamp(48px,8vw,128px)]">
        <StaggerItem>
          <p className={cn("eyebrow", dark && "text-gold-on-dark")}>{kicker}</p>
        </StaggerItem>
        <StaggerItem>
          <h2 className="my-5 text-[clamp(48px,6vw,92px)] leading-[0.95]">
            {title[0]}
            <br />
            {title[1]}
          </h2>
        </StaggerItem>
        <StaggerItem>
          <p className={cn("max-w-[440px] text-[17px] leading-relaxed", dark ? "text-on-dark-muted" : "text-muted-foreground")}>{body}</p>
        </StaggerItem>
        <StaggerItem className="mt-9 flex flex-wrap items-center gap-x-7 gap-y-3.5 max-sm:w-full">
          <Button asChild variant={dark ? "light" : "outline"} className="max-sm:w-full">
            <Link href={primary.href}>
              {primary.label}
              <ArrowRight className="transition-transform duration-200 group-hover/button:translate-x-0.5" aria-hidden />
            </Link>
          </Button>
          {secondary && (
            <ArrowLink href={secondary.href} className={dark ? "hover:text-gold-on-dark" : undefined}>
              {secondary.label}
            </ArrowLink>
          )}
        </StaggerItem>
      </Stagger>
    </section>
  )
}

export default async function HomePage() {
  const { products, unavailable } = await getNewArrivals(4)

  return (
    <>
      {/* Hero: two-column editorial collage. The headline rises out of a mask; the photo is never hidden. */}
      <section className="page-wrap grid items-center gap-[clamp(32px,5vw,88px)] pt-7 pb-[clamp(56px,7vw,104px)] md:min-h-[min(88svh,920px)] md:grid-cols-[5fr_6fr] md:pt-[clamp(40px,5vw,72px)]">
        <div className="max-w-[580px]">
          <Enter>
            <p className="eyebrow flex items-center gap-3">
              <span className="h-px w-10 bg-gold" aria-hidden />
              Royal Festive &apos;26
            </p>
          </Enter>
          <MaskLines lines={["Wear the", "crown."]} className="mt-5 mb-[clamp(28px,3.5vw,44px)] text-[clamp(60px,8vw,128px)] leading-[0.9] tracking-[-0.02em]" />
          <Enter delay={0.45} className="flex flex-wrap items-center gap-x-7 gap-y-4">
            <Button asChild size="lg" className="max-sm:w-full">
              <Link href="/ethnic-festive">
                Shop the festive edit
                <ArrowRight className="transition-transform duration-200 group-hover/button:translate-x-0.5" aria-hidden />
              </Link>
            </Button>
            <ArrowLink href="#new" down>
              New this week
            </ArrowLink>
          </Enter>
        </div>
        <div className="relative w-full md:w-[min(100%,calc(78svh*0.8+clamp(40px,7vw,120px)))] md:justify-self-end md:pb-[clamp(40px,6vw,72px)] md:pl-[clamp(40px,7vw,120px)]">
          <HeroImage className="aspect-[4/5] bg-well">
            <Image src={photo("1566174053879-31528523f8ae", 1000, 1250)} alt="Woman in a deep amethyst off-shoulder gown" fill priority sizes="(min-width: 768px) 45vw, 100vw" className="object-cover object-[50%_20%]" />
          </HeroImage>
          <Enter delay={0.7} className="absolute bottom-0 left-0 hidden aspect-[3/4] w-[clamp(150px,30%,260px)] border-[clamp(6px,0.8vw,10px)] border-paper bg-well md:block">
            <Image src={photo("1610030469983-98e550d6193c", 520, 693)} alt="Model in a purple and gold zari-bordered silk saree" fill sizes="260px" className="object-cover" />
          </Enter>
        </div>
      </section>

      <Stagger className="flex flex-wrap justify-center gap-x-7 gap-y-2.5 border-y border-line px-4 py-5 text-[11px] font-medium tracking-[0.18em] uppercase">
        {["New season", "Regal silhouettes", "Hand-embroidered", "Made to reign"].map((item, i) => (
          <StaggerItem key={item} className="inline-flex items-center gap-7">
            {i > 0 && <span className="size-[5px] rotate-45 bg-gold" aria-hidden />}
            {item}
          </StaggerItem>
        ))}
      </Stagger>

      <section id="new" className="page-wrap section-y">
        <Rise>
          <SectionHead eyebrow="Just landed" title="New this week" link={{ href: "/new-arrivals", label: "View the full edit" }} />
        </Rise>
        <ProductGrid products={products} unavailable={unavailable} emptyMessage="New arrivals will appear here soon." />
      </section>

      <section className="page-wrap pb-[clamp(64px,9vw,128px)]">
        <Rise>
          <SectionHead eyebrow="Silhouettes for every hour" title="Dresses & gowns." link={{ href: "/dresses", label: "View all dresses" }} />
        </Rise>
        <Tiles
          tiles={[
            { image: photo("1566174053879-31528523f8ae", 900), kicker: "Evening / Floor-length drama", title: "Amethyst Gown", href: "/dresses", cta: "Shop gowns" },
            { image: photo("1585487000160-6ebcfceb0d03", 900), kicker: "Day to night / Effortless drape", title: "Merlot Wrap", href: "/dresses", cta: "Shop day dresses" },
            { image: photo("1524504388940-b1c1722653e1", 900), kicker: "After dark / Sheer & structured", title: "Noir Edit", href: "/dresses", cta: "Shop evening" },
          ]}
        />
      </section>

      <section className="page-wrap pb-[clamp(64px,9vw,128px)]">
        <Rise>
          <SectionHead eyebrow="Heirloom craft, modern fit" title="Sarees & lehengas." link={{ href: "/ethnic-festive", label: "View all festive wear" }} />
        </Rise>
        <Tiles
          lead
          tiles={[
            { image: photo("1610030469983-98e550d6193c", 1200, 1000), kicker: "Bridal & festive / Zari-bordered silk", title: "Heritage Sarees", href: "/ethnic-festive", cta: "Shop sarees" },
            { image: photo("1617627143750-d86bc21e42bb", 900), kicker: "Occasion wear / Statement drape", title: "Zari Lehengas", href: "/ethnic-festive", cta: "Shop lehengas" },
            { image: photo("1596944924616-7b38e7cfac36", 900), kicker: "Bridal edit / Hand-set pieces", title: "Bridal Jewellery", href: "/jewellery", cta: "Shop jewellery" },
          ]}
        />
      </section>

      {!isHiddenPath("/jewellery") && (
        <Feature
          id="jewellery"
          tone="dark"
          image={photo("1515562141207-7a88fb7ce338", 1100)}
          alt="Pearl necklace resting in an open jewellery box"
          kicker="Chaanavya fine jewellery / 01"
          title={["Crowned", "in gold."]}
          body="Hand-set pieces in 18k gold vermeil, pearl and stone. Finishing touches worthy of the occasion."
          primary={{ href: "/jewellery", label: "Shop jewellery" }}
          secondary={{ href: "/contact", label: "Book a styling call" }}
        />
      )}
      {!isHiddenPath("/fragrance") && (
        <Feature
          id="fragrance"
          tone="sand"
          reverse
          image="/assets/perfume-royal-oud-classic.png"
          alt="Royal Oud eau de parfum bottle with the Chaanavya logo"
          kicker="Chaanavya fragrance / 02"
          title={["The fragrance", "edit."]}
          body="Three signature eau de parfum blends, bottled in hand-finished glass and gold."
          primary={{ href: "/fragrance", label: "Shop fragrance" }}
        />
      )}

      <section className="page-wrap section-y">
        <Rise>
          <SectionHead eyebrow="Find your mood" title="Shop by mood" />
        </Rise>
        <Stagger className="grid gap-[clamp(16px,2vw,28px)] sm:grid-cols-2">
          {[
            { href: "/dresses", label: "After dark", image: photo("1524504388940-b1c1722653e1", 1000, 750), alt: "Evening wear campaign" },
            { href: "/ethnic-festive", label: "Royal festive", image: photo("1610030469983-98e550d6193c", 1000, 750), alt: "Festive saree campaign" },
          ].map(mood => (
            <StaggerItem key={mood.label}>
              <Link href={mood.href} className="group/mood block">
                <ImageReveal className="aspect-[4/3] bg-well">
                  <Image src={mood.image} alt={mood.alt} fill sizes="(min-width: 640px) 50vw, 100vw" className="object-cover object-[50%_25%] transition-transform duration-[900ms] ease-editorial group-hover/mood:scale-[1.05]" />
                </ImageReveal>
                <div className="flex items-center justify-between gap-4 border-b border-line py-[18px] transition-colors duration-300 group-hover/mood:border-ink">
                  <span className="font-serif text-[clamp(28px,3vw,40px)] leading-tight">{mood.label}</span>
                  <ArrowUpRight className="size-6 transition-transform duration-300 ease-editorial group-hover/mood:translate-x-1 group-hover/mood:-translate-y-1" strokeWidth={1.5} aria-hidden />
                </div>
              </Link>
            </StaggerItem>
          ))}
        </Stagger>
      </section>
    </>
  )
}
