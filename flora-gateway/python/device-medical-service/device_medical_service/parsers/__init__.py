"""Stable config names mapped to vendor/protocol implementations."""

from typing import Any

from device_medical_service.parsers.acme.t200.parser import AcmeT200Parser
from device_medical_service.parsers.generic.ascii_kv.parser import AsciiKvParser
from device_medical_service.parsers.shared.base import Parser
from device_medical_service.parsers.hl7.parser import Hl7v2Parser
from device_medical_service.parsers.generic.json_fields.parser import JsonFieldsParser
from device_medical_service.parsers.draeger.iacs_m540.parser import IacsM540Parser
from device_medical_service.parsers.draeger.medibus.parser import MedibusParser
from device_medical_service.parsers.ge.carestation.parser import GeCarestationParser
from device_medical_service.parsers.ge.dri.parser import GeDriParser
from device_medical_service.parsers.bbraun.bcc.parser import BBraunBccParser
from device_medical_service.parsers.hl7.hidro import HidroHl7Parser

PARSERS: dict[str, type[Parser]] = {
    parser.name: parser
    for parser in (
        IacsM540Parser,
        MedibusParser,
        GeCarestationParser,
        GeDriParser,
        BBraunBccParser,
        Hl7v2Parser,
        HidroHl7Parser,
        AsciiKvParser,
        JsonFieldsParser,
        AcmeT200Parser,
    )
}


def load_parser(name: str, device_id: str, pod: str, options: dict[str, Any] | None = None) -> Parser:
    try:
        parser = PARSERS[name]
    except KeyError:
        raise ValueError(f"unknown parser {name!r}; available: {', '.join(sorted(PARSERS))}") from None
    return parser(device_id, pod, options)
