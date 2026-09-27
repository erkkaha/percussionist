CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "apikey" (
	"id" text PRIMARY KEY NOT NULL,
	"config_id" text DEFAULT 'default' NOT NULL,
	"name" text,
	"start" text,
	"reference_id" text NOT NULL,
	"prefix" text,
	"key" text NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true,
	"rate_limit_enabled" boolean DEFAULT true,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE TABLE "device_code" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code" text NOT NULL,
	"user_code" text NOT NULL,
	"user_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"status" text NOT NULL,
	"last_polled_at" timestamp with time zone,
	"polling_interval" integer,
	"client_id" text,
	"scope" text
);
--> statement-breakpoint
CREATE TABLE "file_ops" (
	"session_id" text NOT NULL,
	"message_idx" integer NOT NULL,
	"file_path" text NOT NULL,
	"operation" text NOT NULL,
	CONSTRAINT "file_ops_session_id_message_idx_file_path_pk" PRIMARY KEY("session_id","message_idx","file_path")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"idx" integer NOT NULL,
	"role" text,
	"content" text,
	"model" text,
	"tokens_in" integer,
	"tokens_out" integer,
	"tokens_reasoning" integer,
	"tokens_cache_read" integer,
	"tokens_cache_write" integer,
	"cost" double precision,
	"created_at" text,
	"completed_at" text
);
--> statement-breakpoint
CREATE TABLE "metric_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"node" text NOT NULL,
	"cpu_usage_millicores" integer NOT NULL,
	"memory_usage_bytes" bigint NOT NULL,
	"cpu_capacity_millicores" integer NOT NULL,
	"memory_capacity_bytes" bigint NOT NULL,
	"recorded_at" text DEFAULT (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscription" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" text DEFAULT (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL,
	CONSTRAINT "push_subscription_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "push_vapid" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"created_at" text DEFAULT (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"namespace" text,
	"task" text,
	"model" text,
	"agent" text,
	"phase" text,
	"started_at" text,
	"completed_at" text,
	"tokens_in" integer DEFAULT 0,
	"tokens_out" integer DEFAULT 0,
	"cost" double precision,
	"error" text,
	"created_at" text DEFAULT (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "task_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"project" text NOT NULL,
	"task_name" text NOT NULL,
	"task_type" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" text DEFAULT (to_char((now() at time zone 'utc'), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_idx" integer NOT NULL,
	"tool" text NOT NULL,
	"args" text,
	"success" boolean,
	"error" text,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "usage_daily" (
	"date" text NOT NULL,
	"reviewing" integer DEFAULT 0,
	"planning" integer DEFAULT 0,
	"other" integer DEFAULT 0,
	CONSTRAINT "usage_daily_date_pk" PRIMARY KEY("date")
);
--> statement-breakpoint
CREATE TABLE "usage_daily_project" (
	"date" text NOT NULL,
	"project" text NOT NULL,
	"reviewing" integer DEFAULT 0,
	"planning" integer DEFAULT 0,
	CONSTRAINT "usage_daily_project_date_project_pk" PRIMARY KEY("date","project")
);
--> statement-breakpoint
CREATE TABLE "usage_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"max_time_hours" integer DEFAULT 0,
	"show_percent" boolean DEFAULT false,
	"lock_on_max" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"github_login" text,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_ops" ADD CONSTRAINT "file_ops_session_id_runs_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_runs_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_session_id_runs_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_account_user_id" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_apikey_key" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_apikey_reference_id" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE INDEX "idx_apikey_config_id" ON "apikey" USING btree ("config_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_deviceCode_uidx" ON "device_code" USING btree ("device_code");--> statement-breakpoint
CREATE UNIQUE INDEX "deviceCode_userCode_uidx" ON "device_code" USING btree ("user_code");--> statement-breakpoint
CREATE INDEX "idx_file_ops_session_id" ON "file_ops" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_messages_session_id" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_metric_snapshots_node_recorded" ON "metric_snapshots" USING btree ("node","recorded_at");--> statement-breakpoint
CREATE INDEX "idx_metric_snapshots_recorded" ON "metric_snapshots" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "idx_push_subscription_user" ON "push_subscription" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_runs_started_at" ON "runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_session_user_id" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_task_events_project_task" ON "task_events" USING btree ("project","task_name");--> statement-breakpoint
CREATE INDEX "idx_task_events_project_created" ON "task_events" USING btree ("project","created_at");--> statement-breakpoint
CREATE INDEX "idx_tool_calls_session_id" ON "tool_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_verification_identifier" ON "verification" USING btree ("identifier");