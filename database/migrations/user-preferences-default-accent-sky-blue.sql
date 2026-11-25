-- ES-668: the default accent colour is now sky blue (#0ea5e9). It was indigo (#6366f1) in the database and pink in the app.
-- Only rows nobody ever customised are changed: every value still equals the old default, so the user chose nothing.
-- A person who picked indigo on purpose along with other changes keeps it.
ALTER TABLE user_preferences ALTER COLUMN "accentColor" SET DEFAULT '#0ea5e9';
UPDATE user_preferences
   SET "accentColor" = '#0ea5e9'
 WHERE "accentColor" = '#6366f1'
   AND "fontScale" = 1 AND "density" = 1 AND "cornerRadius" = 8
   AND "fontFamily" = 'Inter' AND "interfaceMode" = 'light';
