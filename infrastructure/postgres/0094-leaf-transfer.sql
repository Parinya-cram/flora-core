-- Discharge to another Leaf (or_sessions.transfer_out): a case started without a Canopy admission gets
-- one (source 'leaf_transfer') so the receiving Leaf sees it under Receive transfer. sync-api creates it.
GRANT INSERT ON canopy_admission TO flora_sync;
