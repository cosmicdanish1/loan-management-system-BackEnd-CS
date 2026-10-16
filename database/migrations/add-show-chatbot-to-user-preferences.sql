-- ES-168: same DDL as src/migrations/1791331200000-AddShowChatbotToUserPreferences.ts
ALTER TABLE "user_preferences" ADD COLUMN IF NOT EXISTS "showChatbot" boolean NOT NULL DEFAULT true;
