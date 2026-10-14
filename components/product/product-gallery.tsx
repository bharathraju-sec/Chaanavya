"use client"

import * as React from "react"
import Image from "next/image"
import useEmblaCarousel from "embla-carousel-react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"

type GalleryImage = { url: string; altText?: string | null }

// Structure follows the 21st.dev "Thumbnail Slider" (uilayout): an Embla main slider with a strip of
// clickable thumbnails below it, kept in sync. Restyled to the design system: square corners, 4:5 wells,
// terra focus rings, and no slide animation under prefers-reduced-motion.
export function ProductGallery({ images, title }: { images: GalleryImage[]; title: string }) {
  const [selected, setSelected] = React.useState(0)
  const [mainRef, mainApi] = useEmblaCarousel({ loop: false })
  const [thumbsRef, thumbsApi] = useEmblaCarousel({ containScroll: "keepSnaps", dragFree: true })
  const reducedMotion = React.useRef(false)

  React.useEffect(() => {
    reducedMotion.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches
  }, [])

  React.useEffect(() => {
    if (!mainApi) return
    const onSelect = () => {
      const index = mainApi.selectedScrollSnap()
      setSelected(index)
      thumbsApi?.scrollTo(index)
    }
    onSelect()
    mainApi.on("select", onSelect).on("reInit", onSelect)
    return () => {
      mainApi.off("select", onSelect).off("reInit", onSelect)
    }
  }, [mainApi, thumbsApi])

  const go = React.useCallback((index: number) => mainApi?.scrollTo(index, reducedMotion.current), [mainApi])

  const altFor = (image: GalleryImage, i: number) => image.altText || (i === 0 ? title : `${title}, image ${i + 1}`)

  if (images.length === 0) return <div className="aspect-[4/5] w-full bg-well" />

  if (images.length === 1) {
    return (
      <div className="relative aspect-[4/5] w-full overflow-hidden bg-well">
        <Image src={images[0].url} alt={altFor(images[0], 0)} fill priority sizes="(min-width: 768px) 58vw, 100vw" className="object-cover" />
      </div>
    )
  }

  const count = images.length

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label={`${title} photos`}
      className="min-w-0"
      onKeyDownCapture={event => {
        if (event.key === "ArrowLeft") {
          event.preventDefault()
          go(Math.max(0, selected - 1))
        } else if (event.key === "ArrowRight") {
          event.preventDefault()
          go(Math.min(count - 1, selected + 1))
        }
      }}
    >
      <div className="group relative">
        <div ref={mainRef} className="overflow-hidden">
          <div className="flex touch-pan-y">
            {images.map((image, i) => (
              <div
                key={image.url}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${count}`}
                className="relative aspect-[4/5] min-w-0 shrink-0 grow-0 basis-full overflow-hidden bg-well"
              >
                <Image src={image.url} alt={altFor(image, i)} fill priority={i === 0} sizes="(min-width: 768px) 58vw, 100vw" className="object-cover" />
              </div>
            ))}
          </div>
        </div>

        {[
          { label: "Previous photo", icon: ChevronLeft, to: selected - 1, side: "left-3", disabled: selected === 0 },
          { label: "Next photo", icon: ChevronRight, to: selected + 1, side: "right-3", disabled: selected === count - 1 },
        ].map(({ label, icon: Icon, to, side, disabled }) => (
          <button
            key={label}
            type="button"
            aria-label={label}
            disabled={disabled}
            onClick={() => go(to)}
            className={cn(
              "absolute top-1/2 grid size-11 -translate-y-1/2 place-items-center bg-card/90 text-ink transition-opacity hover:text-terra disabled:pointer-events-none disabled:opacity-0 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100",
              side
            )}
          >
            <Icon className="size-5" strokeWidth={1.5} aria-hidden />
          </button>
        ))}

        <p className="absolute right-3 bottom-3 bg-card/90 px-2.5 py-1 text-xs tabular-nums" aria-live="polite">
          {selected + 1} / {count}
        </p>
      </div>

      {/* Padding keeps the focus ring (2px, 3px offset) inside the clipped thumbnail viewport. */}
      <div ref={thumbsRef} className="mt-1.5 overflow-hidden p-[5px]">
        <div className="flex gap-2">
          {images.map((image, i) => (
            <button
              key={image.url}
              type="button"
              onClick={() => go(i)}
              aria-label={`Show photo ${i + 1} of ${count}`}
              aria-current={i === selected ? "true" : undefined}
              className={cn(
                "relative aspect-[4/5] w-[18%] min-w-16 shrink-0 overflow-hidden bg-well transition-opacity sm:w-[14%]",
                i === selected ? "opacity-100" : "opacity-55 hover:opacity-90"
              )}
            >
              <Image src={image.url} alt="" fill sizes="120px" className="object-cover" />
              {i === selected && <span aria-hidden className="absolute inset-0 border border-ink" />}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
