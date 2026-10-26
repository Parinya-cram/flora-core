BEGIN;

-- MLLP over TLS for HL7 v2 destinations. ca_cert: PEM of the CA that signed the receiver's certificate
-- (empty = system CAs). client_cert / client_key: PEM for mutual TLS when the receiver asks for one.
ALTER TABLE canopy_outbound_destination ADD COLUMN IF NOT EXISTS tls boolean NOT NULL DEFAULT false;
ALTER TABLE canopy_outbound_destination ADD COLUMN IF NOT EXISTS ca_cert text NOT NULL DEFAULT '';
ALTER TABLE canopy_outbound_destination ADD COLUMN IF NOT EXISTS client_cert text NOT NULL DEFAULT '';
ALTER TABLE canopy_outbound_destination ADD COLUMN IF NOT EXISTS client_key text NOT NULL DEFAULT '';

COMMIT;
