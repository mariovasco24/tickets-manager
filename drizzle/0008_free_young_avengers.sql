CREATE TABLE `job_artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`job_id` text NOT NULL,
	`phase` text NOT NULL,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`mime` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `job_artifacts_job_id_idx` ON `job_artifacts` (`job_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `e2e_mode` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `app_url` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `reproduction` text;