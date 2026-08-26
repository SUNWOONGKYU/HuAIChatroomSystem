-- PostgREST caches table metadata. Reload it after the revision-ledger column migration
-- so the running gateway can use the new fields without waiting for a service restart.
notify pgrst, 'reload schema';
