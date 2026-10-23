// Paise to the storefront's display Money (decimal string), using string arithmetic only (no floats).
// Shared by the API and the web host, which formats amounts the API returns in paise.
export function toDisplayMoney(paise: bigint | number, currencyCode = "INR") {
  const value = BigInt(paise)
  const sign = value < BigInt(0) ? "-" : ""
  const digits = (value < BigInt(0) ? -value : value).toString().padStart(3, "0")
  return { amount: `${sign}${digits.slice(0, -2)}.${digits.slice(-2)}`, currencyCode }
}
