import { ArrowLink } from "@/components/site/editorial"

export default function NotFound() {
  return (
    <div className="page-wrap section-y text-center">
      <p className="eyebrow">Page not found</p>
      <h1 className="mt-4 mb-6 text-[clamp(48px,6vw,88px)]">This page has moved.</h1>
      <p className="mx-auto mb-8 max-w-md text-muted-foreground">The link may be out of date. The new arrivals are a good place to start.</p>
      <ArrowLink href="/new-arrivals">Explore new arrivals</ArrowLink>
    </div>
  )
}
