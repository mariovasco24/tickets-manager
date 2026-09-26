CREATE TABLE `job_messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`kind` text NOT NULL,
	`tool_name` text,
	`summary` text NOT NULL,
	`content` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_messages_job_id_idx` ON `job_messages` (`job_id`,`id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `clarification_rounds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `claude_cost_usd` real;--> statement-breakpoint
ALTER TABLE `jobs` ADD `claude_num_turns` integer;