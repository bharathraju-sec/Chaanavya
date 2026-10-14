import type { Metadata } from "next"
import Link from "next/link"
import { Note, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Size guide", description: "Chaanavya size guide: Indian women's body measurements for bust, waist and hip, in inches and centimetres." }

// Indian high-street body measurements ("to fit"), in inches, as used by major Indian retailers
// (owner request, 15 October 2026). Owner to confirm against Chaanavya's own garments.
const sizes = [
  ["XS", 32, 26, 35],
  ["S", 34, 28, 37],
  ["M", 36, 30, 39],
  ["L", 38, 32, 41],
  ["XL", 40, 34, 43],
] as const

const cm = (inches: number) => Math.round(inches * 2.54)

const HOW_TO_MEASURE = [
  ["Bust", "Around the fullest part of the bust, keeping the tape level under the arms."],
  ["Waist", "Around your natural waist, the narrowest part above the navel."],
  ["Hip", "Around the fullest part of the hips, about 20 cm below the waist."],
] as const

export default function SizeGuidePage() {
  return (
    <SupportPage eyebrow="Fit with confidence" title="Size guide." lead="Indian sizes, given as body measurements in inches and centimetres.">
      <div className="mt-10 overflow-x-auto border border-line bg-card">
        <table className="w-full border-collapse text-[15px]">
          <caption className="sr-only">Body measurements by size, in inches and centimetres</caption>
          <thead>
            <tr className="bg-sand">
              {["Size", "Bust (in / cm)", "Waist (in / cm)", "Hip (in / cm)"].map(h => (
                <th key={h} scope="col" className="label-caps px-3 py-3.5 text-left text-[11px] sm:px-[18px]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map(([size, ...measures]) => (
              <tr key={size} className="border-t border-line">
                <th scope="row" className="px-3 py-3.5 text-left font-medium sm:px-[18px]">
                  {size}
                </th>
                {measures.map((m, i) => (
                  <td key={i} className="px-3 py-3.5 whitespace-nowrap sm:px-[18px]">
                    {m} / {cm(m)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2 className="mt-12 mb-3 text-3xl">How to measure</h2>
      <p className="max-w-[68ch] leading-[1.75] text-[#2e4544]">Measure over light clothing with a soft tape, keeping it snug but not tight.</p>
      <dl className="mt-4 max-w-[68ch] space-y-2 leading-[1.75] text-[#2e4544]">
        {HOW_TO_MEASURE.map(([name, how]) => (
          <div key={name}>
            <dt className="inline font-semibold text-ink">{name}: </dt>
            <dd className="inline">{how}</dd>
          </div>
        ))}
      </dl>
      <Note>
        Sarees are woven to a free-size, 5.5m unstitched length with a matching 0.8m blouse piece. Need help with saree or blouse sizing?{" "}
        <Link href="/contact" className="underline underline-offset-2 hover:text-terra">
          Contact us
        </Link>{" "}
        by email or WhatsApp.
      </Note>
    </SupportPage>
  )
}
