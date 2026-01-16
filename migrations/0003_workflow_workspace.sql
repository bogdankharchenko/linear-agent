-- Add workspace_id to workflow_runs for OAuth token lookup
ALTER TABLE workflow_runs ADD COLUMN linear_workspace_id TEXT;
