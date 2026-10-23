import { forwardToApi } from "@/lib/api/forward"

// Every /api/* request except the shop chat goes to the NestJS API (Stage 07, decision 032):
// sign-in, accounts, orders and the admin API. This host adds no rules of its own; see lib/api/forward.ts.
const forward = (request: Request) => forwardToApi(request)

export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
