ALTER TABLE `messages` ADD `tokens_reasoning` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `tokens_cache_read` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `tokens_cache_write` integer;--> statement-breakpoint
ALTER TABLE `messages` ADD `cost` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost` real;