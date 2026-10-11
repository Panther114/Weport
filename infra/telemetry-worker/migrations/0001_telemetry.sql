CREATE TABLE installations (
  installation_id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux'))
);
CREATE TABLE error_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('win32', 'darwin', 'linux')),
  app_version TEXT NOT NULL,
  electron_version TEXT NOT NULL,
  errors_json TEXT NOT NULL CHECK (json_valid(errors_json)),
  received_day TEXT NOT NULL
);
CREATE INDEX error_batches_received ON error_batches(received_day);
