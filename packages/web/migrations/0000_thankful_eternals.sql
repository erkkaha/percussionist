CREATE TABLE `board_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`task_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_board_events_project_task` ON `board_events` (`project`,`task_id`);--> statement-breakpoint
CREATE TABLE `board_tasks` (
	`project` text NOT NULL,
	`task_id` text NOT NULL,
	`column` text NOT NULL,
	`seq` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`project`, `task_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_board_tasks_project_column` ON `board_tasks` (`project`,`column`);--> statement-breakpoint
CREATE TABLE `board_workers` (
	`project` text NOT NULL,
	`task_id` text NOT NULL,
	`run_name` text NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`branch` text,
	`facilitated` integer DEFAULT false NOT NULL,
	`review_run_name` text,
	`rework_run_name` text,
	`facilitation_run_name` text,
	`extra` text,
	`assigned_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`project`, `task_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_board_workers_project` ON `board_workers` (`project`);--> statement-breakpoint
CREATE TABLE `file_ops` (
	`session_id` text NOT NULL,
	`message_idx` integer NOT NULL,
	`file_path` text NOT NULL,
	`operation` text NOT NULL,
	PRIMARY KEY(`session_id`, `message_idx`, `file_path`),
	FOREIGN KEY (`session_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_file_ops_session_id` ON `file_ops` (`session_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`idx` integer NOT NULL,
	`role` text,
	`content` text,
	`model` text,
	`tokens_in` integer,
	`tokens_out` integer,
	`created_at` text,
	`completed_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session_id` ON `messages` (`session_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`namespace` text,
	`task` text,
	`model` text,
	`agent` text,
	`phase` text,
	`started_at` text,
	`completed_at` text,
	`tokens_in` integer DEFAULT 0,
	`tokens_out` integer DEFAULT 0,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_started_at` ON `runs` (`started_at`);--> statement-breakpoint
CREATE TABLE `tool_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_idx` integer NOT NULL,
	`tool` text NOT NULL,
	`args` text,
	`success` integer,
	`error` text,
	`duration_ms` integer,
	FOREIGN KEY (`session_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_tool_calls_session_id` ON `tool_calls` (`session_id`);