CREATE TABLE `job_worktrees` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`repo_name` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`branch` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`install_command` text,
	`created_at` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_worktrees_job_id_idx` ON `job_worktrees` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `phase` text DEFAULT 'triage' NOT NULL;--> statement-breakpoint
ALTER TABLE `jobs` ADD `triage_session_id` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `triage_result` text;