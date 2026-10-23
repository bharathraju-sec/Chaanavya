// robots.txt on the admin host (proxy.ts rewrites /robots.txt there to this route): no crawling at
// all, alongside the X-Robots-Tag and robots meta noindex the admin already sends.
export const GET = () => new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } })
