CREATE TABLE `task_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`task_name` text NOT NULL,
	`task_type` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_task_events_project_task` ON `task_events` (`project`,`task_name`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_project_created` ON `task_events` (`project`,`created_at`);
