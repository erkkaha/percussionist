CREATE TABLE `metric_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node` text NOT NULL,
	`cpu_usage_millicores` integer NOT NULL,
	`memory_usage_bytes` integer NOT NULL,
	`cpu_capacity_millicores` integer NOT NULL,
	`memory_capacity_bytes` integer NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_metric_snapshots_node_recorded` ON `metric_snapshots` (`node`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `idx_metric_snapshots_recorded` ON `metric_snapshots` (`recorded_at`);