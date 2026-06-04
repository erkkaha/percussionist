CREATE TABLE IF NOT EXISTS `tool_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`run_name` text NOT NULL,
	`tool_name` text NOT NULL,
	`is_mcp` integer NOT NULL DEFAULT false,
	`called_at` text NOT NULL,
	`duration_ms` integer,
	`success` integer,
	`result_size` integer,
	`result_truncated` integer,
	`error` text
);
CREATE INDEX IF NOT EXISTS `idx_tool_events_session_id` ON `tool_events` (`session_id`);
CREATE INDEX IF NOT EXISTS `idx_tool_events_run_name` ON `tool_events` (`run_name`);
