import { Enter, MaskLines } from "@/components/motion/motion"
import { ArrowLink } from "@/components/site/editorial"

export function NotFoundContent() {
  return (
    <div className="page-wrap section-y text-center">
      <Enter>
        <p className="eyebrow flex items-center justify-center gap-3">
          <span className="h-px w-10 bg-gold" aria-hidden />
          Page not found
          <span className="h-px w-10 bg-gold" aria-hidden />
        </p>
      </Enter>
      <MaskLines lines={["This page", "has moved."]} className="mt-4 mb-6 text-[clamp(48px,6vw,88px)] leading-[0.95]" />
      <Enter delay={0.4}>
        <p className="mx-auto mb-8 max-w-md text-muted-foreground">The link may be out of date. The new arrivals are a good place to start.</p>
        <div className="flex flex-wrap justify-center gap-x-8">
          <ArrowLink href="/new-arrivals">Explore new arrivals</ArrowLink>
          <ArrowLink href="/">Back to the shop</ArrowLink>
        </div>
      </Enter>
    </div>
  )
}
