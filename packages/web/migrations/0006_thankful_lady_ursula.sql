CREATE TABLE `usage_daily` (
	`date` text PRIMARY KEY NOT NULL,
	`reviewing` integer DEFAULT 0,
	`planning` integer DEFAULT 0,
	`other` integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE `usage_settings` (
	`id` integer PRIMARY KEY DEFAULT 1 NOT NULL,
	`max_time_hours` integer DEFAULT 0,
	`show_percent` integer DEFAULT false,
	`lock_on_max` integer DEFAULT false
);
