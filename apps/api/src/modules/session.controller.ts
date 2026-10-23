// Who is signed in, for the web host's pages (Stage 07): the header's Sign in / Account button, the
// account pages and the admin entry rules (login, two-factor enrolment). Always 200; never audited.
import { twoFactorWaived } from "@chaanavya/shared/auth/two-factor-waiver"
import { Controller, Get, Req, Res } from "@nestjs/common"
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger"
import type { Response } from "express"
import { capabilitiesFor } from "@chaanavya/shared/auth/rbac"
import { getSignedIn } from "../auth/session.ts"
import { Access } from "../http/access.ts"
import { headersOf, type ApiRequest } from "../http/context.ts"
import { Schemas } from "../http/schemas.ts"

@ApiTags("session")
@Controller("api/v1/session")
export class SessionController {
  @Get()
  @Access.shopper()
  @ApiOperation({ summary: "The signed-in user for this browser, if any" })
  @ApiOkResponse({ schema: Schemas.session })
  async current(@Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    res.setHeader("cache-control", "no-store")
    const signedIn = await getSignedIn(headersOf(req))
    if (!signedIn) return { signedIn: false }
    return {
      signedIn: true,
      user: {
        id: signedIn.userId,
        email: signedIn.email,
        emailVerified: signedIn.emailVerified,
        roles: signedIn.roles,
        capabilities: [...capabilitiesFor(signedIn.roles)].sort(),
        twoFactorEnabled: signedIn.twoFactorEnabled,
        passedTwoFactor: signedIn.twoFactorEnabled && signedIn.authMethod === "password_2fa",
        // True only in development with ADMIN_TWO_FACTOR=off: the admin then needs no two-factor.
        twoFactorWaived: twoFactorWaived(process.env),
      },
    }
  }
}
