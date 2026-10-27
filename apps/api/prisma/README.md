# Database: Prisma and PostgreSQL

Stage 04 schema for the Chaanavya-owned commerce modules. Sign-in, accounts, staff roles and the audit trail use it today; products, cart and checkout move onto it in later stages.

| Path | Purpose |
| --- | --- |
| `schema.prisma` | Models, enums, relations, indexes |
| `migrations/` | Applied in order by `prisma migrate deploy`; never edit one that has run anywhere shared |
| `sql/init-pre.sql`, `sql/init-constraints.sql` | Hand-written parts of the first migration (sequence, CHECK constraints, partial unique index, append-only triggers) |
| `sql/roles.sql` | Least-privilege roles for staging and production |
| `rollback/` | Down scripts for rehearsals; production prefers a forward fix |
| `seed.mjs` | Synthetic development fixtures only |
| `../prisma.config.ts` | CLI configuration (Prisma 7 keeps the connection URL here) |
| `../src/db/` | Client, money conversion, transaction-safe transitions; `generated/` is created by `npm install` (this folder moved under `apps/api/` in Stage 07; migration names and contents are unchanged) |

## Everyday commands

```bash
npm run db:up
```

```bash
npm run db:migrate
```

```bash
npm run db:seed:synthetic
```

```bash
npm run test:db
```

Without `DATABASE_URL`, the CLI and `src/db/client.ts` use the local compose database on `127.0.0.1:15432`. Staging and production must set `DATABASE_URL` (checked by `npm run check:env`).

## Changing the schema

1. Edit `schema.prisma`.
2. Create the migration without applying it, against a scratch database so local data is not reset:
   From `apps/api`: `npx prisma migrate dev --create-only --name <change>` (or generate SQL with `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script`).
3. Review the SQL for destructive statements (`DROP`, `ALTER ... TYPE`, `NOT NULL` without a default). Destructive changes need a backup, a data migration plan and a second reviewer.
4. Add any rule Prisma cannot express (CHECK constraint, partial index, trigger) to the same migration by hand.
5. Write the matching down script in `rollback/`.
6. Run `npm run test:db`. Its drift test fails if the migrations and `schema.prisma` disagree.

The first migration was assembled from three files: `sql/init-pre.sql`, the output of `npx prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`, and `sql/init-constraints.sql`.

## Rules the database enforces

- One active variant per SKU (partial unique index); handles are unique slugs.
- Stock: `on_hand`, `reserved`, `allocated` never negative, and `on_hand - reserved - allocated >= 0`.
- Order totals add up in paise; discount never exceeds the subtotal.
- A cart has exactly one owner; quantities 1 to 99.
- A promotion is a percentage or a fixed amount, not both.
- `(provider, event_id)` is unique for provider events, `(shipment_id, event_id)` for tracking events; every idempotency key column is unique.
- `audit_event` and `inventory_movement` are append-only (UPDATE, DELETE and TRUNCATE raise an error).

## Production access

Run `sql/roles.sql` once per database as its owner, then set passwords outside this repository. Migrations run as `chaanavya_migrator` in the release step; the application connects as `chaanavya_app`; support tools use `chaanavya_readonly`. Use TLS (`sslmode=require` or stricter) and a provider with encryption at rest. Take a backup before every migration.
