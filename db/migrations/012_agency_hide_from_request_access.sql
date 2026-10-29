ALTER TABLE agencies
  ADD COLUMN IF NOT EXISTS hide_from_request_access BOOLEAN NOT NULL DEFAULT false;
