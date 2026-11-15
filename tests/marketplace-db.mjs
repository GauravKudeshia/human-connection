import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { marketplaceMigrations } from "../db/marketplace-migrations.mjs";

export function sqliteD1(filename = ":memory:") {
  const sqlite = new DatabaseSync(filename);
  for (const migration of marketplaceMigrations)
    sqlite.exec(
      readFileSync(new URL("../db/" + migration, import.meta.url), "utf8"),
    );
  function statement(sql, values = []) {
    return {
      bind: (...next) => statement(sql, next),
      async first() {
        return sqlite.prepare(sql).get(...values) || null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...values) };
      },
      async run() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      execute() {
        const result = sqlite.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
  }
  return {
    prepare: (sql) => statement(sql),
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((entry) => entry.execute());
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => sqlite.close(),
    sqlite,
  };
}
