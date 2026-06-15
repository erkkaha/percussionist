CREATE TABLE `usage_daily_project` (
	`date` text NOT NULL,
	`project` text NOT NULL,
	`reviewing` integer DEFAULT 0,
	`planning` integer DEFAULT 0,
	PRIMARY KEY(`date`, `project`)
);
