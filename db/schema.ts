import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
// Owner-isolated, optimistic-locking storage for the private prototype.
// Production marketplace tables are separately supplied in docs/reference-schema.sql.
export const demoWorkspaces = sqliteTable('demo_workspaces', {
  ownerId: text('owner_id').primaryKey(),
  version: integer('version').notNull().default(0),
  state: text('state').notNull(),
  updatedAt: text('updated_at').notNull(),
});
