-- Baseline: memories table with a pgvector embedding column.
--
-- The CREATE EXTENSION below is hand-written (drizzle-kit generates everything
-- after it) and must stay first: pgvector is not part of a vanilla PostgreSQL
-- image, and the `vector` column in the next statement does not resolve without
-- it. It is idempotent, so re-running the migration is safe.
--
-- It needs a role that may CREATE EXTENSION in the target database. The bundled
-- StatefulSet runs as the POSTGRES_USER superuser from the percussionist-db
-- Secret, so it is fine there; on a managed database, have an administrator
-- install pgvector once and this statement becomes a no-op.
CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "memories" (
	"project" text NOT NULL,
	"id" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"agent_run" text,
	"embedding" vector NOT NULL,
	"dims" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memories_project_id_pk" PRIMARY KEY("project","id"),
	CONSTRAINT "memories_dims_matches_embedding" CHECK ("memories"."dims" = vector_dims("memories"."embedding"))
);
--> statement-breakpoint
CREATE INDEX "idx_memories_project_created" ON "memories" USING btree ("project","created_at");--> statement-breakpoint
CREATE INDEX "idx_memories_project_dims" ON "memories" USING btree ("project","dims");