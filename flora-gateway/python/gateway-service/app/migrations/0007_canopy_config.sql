-- Version of the configuration last applied from Canopy (clone / restore / new gateway).
ALTER TABLE gateway_site ADD COLUMN IF NOT EXISTS canopy_config_version bigint NOT NULL DEFAULT 0;
