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

export type TaxComponent = "CGST" | "SGST" | "IGST"

export type TaxLineV1 = { component: TaxComponent; rateBasisPoints: TaxRateBasisPoints; amount: MoneyPaise }
