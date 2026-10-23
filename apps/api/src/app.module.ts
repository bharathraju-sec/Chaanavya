import { Module } from "@nestjs/common"
import { APP_FILTER, APP_GUARD } from "@nestjs/core"
import { ThrottlerModule } from "@nestjs/throttler"
import { AccessGuard } from "./http/access.ts"
import { ApiExceptionFilter } from "./http/errors.ts"
import { API_RATE_LIMIT, ClientIpThrottlerGuard } from "./http/throttle.ts"
import { AccountController } from "./modules/account.controller.ts"
import { AdminController } from "./modules/admin.controller.ts"
import { CatalogueAdminController } from "./modules/catalogue.controller.ts"
import { HealthController } from "./modules/health.controller.ts"
import { InventoryController } from "./modules/inventory.controller.ts"
import { OrdersController } from "./modules/orders.controller.ts"
import { SessionController } from "./modules/session.controller.ts"
import { StorefrontCatalogueController } from "./modules/storefront.controller.ts"

// Guards run in this order on every route: the per-IP limit, then the route's access rule.
@Module({
  imports: [ThrottlerModule.forRoot([API_RATE_LIMIT])],
  controllers: [HealthController, SessionController, AccountController, OrdersController, AdminController, CatalogueAdminController, InventoryController, StorefrontCatalogueController],
  providers: [
    { provide: APP_GUARD, useClass: ClientIpThrottlerGuard },
    { provide: APP_GUARD, useClass: AccessGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
