"use client"

import * as React from "react"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { Product } from "@/lib/types"
import { choosableOptions, fixedSelection, resolveVariant, selectionFor, valueAvailable, type Selection } from "@/lib/variants"

export { choosableOptions }

/**
 * Tracks the shopper's choice per option and resolves it to a variant. Single-value options
 * are preselected, so a product with no real choice resolves to its only variant immediately.
 * `initialVariantId` (a shared link) preselects that variant's options.
 */
export function useVariantSelection(product: Product, initialVariantId?: string | null) {
  const fixed = React.useMemo(() => fixedSelection(product), [product])
  const [chosen, setChosen] = React.useState<Selection>(() => selectionFor(product, initialVariantId))
  const selection = { ...fixed, ...chosen }
  const options = choosableOptions(product)
  const variant = resolveVariant(product, selection)

  return {
    options,
    selection,
    variant,
    missing: options.find(o => !selection[o.name])?.name,
    choose: (name: string, value: string) => setChosen(prev => ({ ...prev, [name]: value })),
    reset: () => setChosen({}),
  }
}

export function OptionPicker({ product, selection, onChoose }: { product: Product; selection: Selection; onChoose: (name: string, value: string) => void }) {
  return (
    <div className="grid gap-6">
      {choosableOptions(product).map(option => {
        const isAvailable = (value: string) => valueAvailable(product, selection, option.name, value)
        return (
          <div key={option.name}>
            <p className="label-caps mb-3 text-[11px]" id={`opt-${product.handle}-${option.name}`}>
              {option.name}
              {selection[option.name] && <span className="ml-2 font-normal tracking-normal normal-case text-muted-foreground">{selection[option.name]}</span>}
            </p>
            <ToggleGroup
              type="single"
              value={selection[option.name] ?? ""}
              onValueChange={value => value && onChoose(option.name, value)}
              aria-labelledby={`opt-${product.handle}-${option.name}`}
              spacing={2}
              className="grid w-full grid-cols-[repeat(auto-fill,minmax(72px,1fr))]"
            >
              {option.values.map(value => (
                <ToggleGroupItem
                  key={value}
                  value={value}
                  disabled={!isAvailable(value)}
                  variant="outline"
                  className="h-12 w-full rounded-none border-line-strong bg-card px-2 text-sm font-normal whitespace-normal hover:border-ink hover:bg-card data-[state=on]:border-ink data-[state=on]:bg-ink data-[state=on]:text-white disabled:line-through"
                >
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        )
      })}
    </div>
  )
}
