-- Least-privilege database roles (Stage 04). Template for staging and production, run once by the
-- database owner per database; tested locally by tests/integration/database/privileges.test.mjs.
-- Passwords are never stored here: set them afterwards with \password or the provider's console,
-- and keep them only in the hosting secret store.
--
--   chaanavya_migrator  owns the schema; used only by `prisma migrate deploy` in the release step
--   chaanavya_app       the running application: read and write rows, no DDL
--   chaanavya_readonly  support and reporting: read only
--
-- Usage: psql -v db=<database name> -f prisma/sql/roles.sql

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaanavya_migrator') THEN CREATE ROLE chaanavya_migrator LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaanavya_app') THEN CREATE ROLE chaanavya_app LOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'chaanavya_readonly') THEN CREATE ROLE chaanavya_readonly LOGIN; END IF;
END
$$;

REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO chaanavya_migrator, chaanavya_app, chaanavya_readonly;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO chaanavya_migrator;
GRANT USAGE ON SCHEMA public TO chaanavya_app, chaanavya_readonly;

-- Application: row access only. Append-only tables get no UPDATE or DELETE (the triggers are a second line).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO chaanavya_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_event", "inventory_movement" FROM chaanavya_app;
REVOKE ALL ON "_prisma_migrations" FROM chaanavya_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO chaanavya_app;

GRANT SELECT ON ALL TABLES IN SCHEMA public TO chaanavya_readonly;
REVOKE ALL ON "_prisma_migrations" FROM chaanavya_readonly;

-- Tables created by later migrations (run as the migrator) get the same grants.
ALTER DEFAULT PRIVILEGES FOR ROLE chaanavya_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO chaanavya_app;
ALTER DEFAULT PRIVILEGES FOR ROLE chaanavya_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO chaanavya_app;
ALTER DEFAULT PRIVILEGES FOR ROLE chaanavya_migrator IN SCHEMA public GRANT SELECT ON TABLES TO chaanavya_readonly;
