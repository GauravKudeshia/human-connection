CREATE TABLE `demo_workspaces` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` text NOT NULL
);
