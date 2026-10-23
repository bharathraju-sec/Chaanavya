// Least-privilege roles (apps/api/prisma/sql/roles.sql): the application role can read and write rows but
// cannot change the schema, rewrite append-only ledgers or read migration history.
import { after, before, describe, test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { API_ROOT, dropDatabase, freshDatabase, psql, psqlOk } from "./helpers.mjs"

const NAME = "chaanavya_test_privileges"
let db

before(() => {
  ;({ client: db } = freshDatabase(NAME))
  psqlOk(NAME, null, { input: readFileSync(`${API_ROOT}prisma/sql/roles.sql`, "utf8"), variables: { db: NAME } })
})
after(async () => {
  await db?.$disconnect()
  dropDatabase(NAME)
})

const as = (role, sql) => psql(NAME, `SET ROLE ${role}; ${sql}`)
const audit = `INSERT INTO audit_event (id, action, actor_kind, entity_type, entity_id, reason, correlation_id) VALUES (gen_random_uuid(), 'test', 'system', 'test', '1', 'privileges test', 'corr-privileges')`

describe("application role", () => {
  test("can insert and read rows", () => {
    assert.equal(as("chaanavya_app", audit).status, 0)
    assert.equal(as("chaanavya_app", "SELECT count(*) FROM audit_event").status, 0)
  })

  test("cannot update or delete audit events, or truncate ledgers", () => {
    for (const sql of ["UPDATE audit_event SET reason = 'x'", "DELETE FROM audit_event", "DELETE FROM inventory_movement", "TRUNCATE inventory_movement"]) {
      const result = as("chaanavya_app", sql)
      assert.notEqual(result.status, 0, sql)
      assert.match(result.stderr, /permission denied|append-only/, sql)
    }
  })

  test("cannot change the schema or read migration history", () => {
    for (const sql of ["DROP TABLE product", "ALTER TABLE product ADD COLUMN x int", "CREATE TABLE intruder (id int)", "SELECT * FROM _prisma_migrations"]) {
      const result = as("chaanavya_app", sql)
      assert.notEqual(result.status, 0, sql)
      assert.match(result.stderr, /permission denied|must be owner/, sql)
    }
  })
})

describe("read-only role", () => {
  test("can read but not write", () => {
    assert.equal(as("chaanavya_readonly", "SELECT count(*) FROM product").status, 0)
    assert.match(as("chaanavya_readonly", audit).stderr, /permission denied/)
  })
})
