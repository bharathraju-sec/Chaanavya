import type { MetadataRoute } from "next"

// Shop robots.txt. The admin host gets its own (app/admin/robots.txt), because proxy.ts rewrites
// every admin-host path into app/admin.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/account", "/admin"] },
    sitemap: "https://chaanavya.in/sitemap.xml",
  }
}
