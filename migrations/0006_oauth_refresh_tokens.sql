-- Add refresh token support for OAuth tokens
-- Linear now issues 24-hour access tokens with refresh tokens
ALTER TABLE oauth_tokens ADD COLUMN refresh_token TEXT;
ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT;
