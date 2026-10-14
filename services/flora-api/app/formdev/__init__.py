"""FormDev data engine (Phase 3).

``services_for(adapter)`` wires every repository on top of one DataAdapter. Nothing
above the adapter knows which database vendor is in use.
"""
from __future__ import annotations

from dataclasses import dataclass

from typing import Callable

from .adapters.base import DataAdapter
from .conflict import ConflictResolver
from .indexing import IndexMaintenance
from .attachments import AttachmentStore
from .lookups import LookupRepository
from .repositories import FormRepository, RecordRepository, SchemaRepository, StyleRepository
from .sync import SyncService
from .templates import TemplateRepository


@dataclass
class FormDevServices:
    adapter: DataAdapter
    styles: StyleRepository
    forms: FormRepository
    schemas: SchemaRepository
    records: RecordRepository
    sync: SyncService
    indexing: IndexMaintenance
    lookups: LookupRepository

    @property
    def attachments(self) -> AttachmentStore:
        return self.records.attachments

    @property
    def templates(self) -> TemplateRepository:
        return TemplateRepository(self.adapter, self.schemas.validate)


def services_for(
    adapter: DataAdapter,
    resolver: ConflictResolver | None = None,
    enqueue_reindex: Callable[[str, str], None] | None = None,
) -> FormDevServices:
    """enqueue_reindex(form_id, user) queues a background reindex for large forms; without it
    reindexing runs inline."""
    styles = StyleRepository(adapter)
    schemas = SchemaRepository(adapter, styles)
    indexing = IndexMaintenance(adapter, schemas, enqueue_reindex)
    schemas.on_published = indexing.after_publish
    records = RecordRepository(adapter, schemas, indexing)
    return FormDevServices(adapter, styles, FormRepository(adapter), schemas, records, SyncService(adapter, records, resolver), indexing, records.lookups)
