import type { CurrencyCode } from "./common.ts"

/**
 * Money inside the commerce modules: an integer number of paise. Never a float, never rupees.
 * Every amount must satisfy Number.isSafeInteger (checked by invariants.ts).
 *
 * This is deliberately a different shape from the storefront's display `Money` in lib/types.ts
 * (decimal string). The two are not both sources of truth: commerce data uses
 * MoneyPaise, and the Stage 10 catalogue adapter converts to the display shape for existing UI.
 */
export type MoneyPaise = { amountPaise: number; currency: CurrencyCode }

/** GST rate in basis points (5% = 500). Actual rates per category need tax-advisor approval. */
export type TaxRateBasisPoints = number

/** UTGST replaces SGST in a union territory without a legislature (Stage 12.06). */
export type TaxComponent = "CGST" | "SGST" | "UTGST" | "IGST"

export type TaxLineV1 = { component: TaxComponent; rateBasisPoints: TaxRateBasisPoints; amount: MoneyPaise }

/**
 * How one quote line was classified and taxed (Stage 12.06), frozen into the quote and the order so a
 * later change to the tax profile never changes what was charged.
 */
export type TaxClassificationV1 = {
  taxProfileId: string
  /** False only outside production, when a draft profile was used for a test quote. */
  profileApproved: boolean
  taxCategory: string
  hsnCode: string
  rateBasisPoints: TaxRateBasisPoints
  /** intra: CGST plus SGST or UTGST in the seller's state; inter: IGST. */
  supply: "intra" | "inter"
  sellerStateCode: string
  deliveryStateCode: string
  pricesIncludeTax: boolean
  /** Rounding policy version: per line, nearest paisa, half up; intra-state halves computed separately. */
  rounding: "line_half_up_v1"
}
