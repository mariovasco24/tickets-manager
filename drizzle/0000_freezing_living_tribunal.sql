CREATE TABLE `job_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`message` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_events_job_id_idx` ON `job_events` (`job_id`,`id`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_key` text NOT NULL,
	`ticket_summary` text,
	`ticket_url` text,
	`ticket_status` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`requested_by` text NOT NULL,
	`source_branch` text,
	`branch` text,
	`worktree_path` text,
	`slack_channel` text,
	`slack_thread_ts` text,
	`slack_permalink` text,
	`claude_session_id` text,
	`pending_question` text,
	`fix_summary` text,
	`files_changed` text,
	`tests_result` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `jobs_ticket_key_idx` ON `jobs` (`ticket_key`);--> statement-breakpoint
CREATE INDEX `jobs_status_idx` ON `jobs` (`status`);--> statement-breakpoint
CREATE INDEX `jobs_thread_idx` ON `jobs` (`slack_channel`,`slack_thread_ts`);