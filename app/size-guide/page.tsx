import type { Metadata } from "next"
import { Note, SupportPage } from "@/components/site/support"

export const metadata: Metadata = { title: "Size guide", description: "Chaanavya size guide: bust, waist and hip measurements." }

const sizes = [
  ["XS", 32, 25, 35],
  ["S", 34, 27, 37],
  ["M", 36, 29, 39],
  ["L", 38, 31, 41],
  ["XL", 40, 33, 43],
] as const

export default function SizeGuidePage() {
  return (
    <SupportPage eyebrow="Fit with confidence" title="Size guide." lead="Measurements in inches, taken flat. Between sizes? Size up for gowns and structured trenches, true to size for knits.">
      <div className="mt-10 overflow-x-auto border border-line bg-card">
        <table className="w-full border-collapse text-[15px]">
          <caption className="sr-only">Body measurements in inches by size</caption>
          <thead>
            <tr className="bg-sand">
              {["Size", "Bust", "Waist", "Hip"].map(h => (
                <th key={h} scope="col" className="label-caps px-[18px] py-3.5 text-left text-[11px]">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sizes.map(([size, ...measures]) => (
              <tr key={size} className="border-t border-line">
                <th scope="row" className="px-[18px] py-3.5 text-left font-medium">
                  {size}
                </th>
                {measures.map((m, i) => (
                  <td key={i} className="px-[18px] py-3.5">
                    {m}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Note>Sarees are woven to a free-size, 5.5m unstitched length with a matching 0.8m blouse piece. Request a stitched blouse in your size at checkout when our backend goes live.</Note>
    </SupportPage>
  )
}
