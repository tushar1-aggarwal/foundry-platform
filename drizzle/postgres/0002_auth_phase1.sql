CREATE TABLE "scoping_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_kind" text NOT NULL,
	"scope_id" text NOT NULL,
	"key" text NOT NULL,
	"value_json" text NOT NULL,
	"tenant_id" text DEFAULT 'default' NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "sessions_auth" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"team_chain" text,
	"user_agent" text,
	"ip" text
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "parent_team_id" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_sub" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" text;--> statement-breakpoint
ALTER TABLE "sessions_auth" ADD CONSTRAINT "sessions_auth_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_scoping_overrides_live" ON "scoping_overrides" USING btree ("scope_kind","scope_id","key","tenant_id") WHERE "scoping_overrides"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_scoping_overrides_tenant" ON "scoping_overrides" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_auth_user" ON "sessions_auth" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_auth_expires" ON "sessions_auth" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_api_keys_user" ON "api_keys" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_teams_parent" ON "teams" USING btree ("parent_team_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_users_google_sub_live" ON "users" USING btree ("google_sub") WHERE "users"."google_sub" IS NOT NULL AND "users"."deleted_at" IS NULL;