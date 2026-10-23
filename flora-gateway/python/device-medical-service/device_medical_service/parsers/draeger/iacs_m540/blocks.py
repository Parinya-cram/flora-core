"""IACS block decoder ported from Vector; see THIRD_PARTY_NOTICES.md."""
from dataclasses import dataclass, field


class IacsParseError(ValueError):
    pass


@dataclass(frozen=True)
class ParsedIacsDatagram:
    numeric_values: dict[str, int] = field(default_factory=dict)
    waveforms: dict[str, list[int]] = field(default_factory=dict)
    # Second byte of each waveform block's tag (200, 100 or 50), by waveform key.
    waveform_tags: dict[str, int] = field(default_factory=dict)
    bed_label: str | None = None
    message: str | None = None
    trailing_offset: int | None = None


class IacsDatagramParser:
    """Python port of the available legacy IACS block parser.

    The framing is research-derived and must be validated with authorized captures
    before enabling a live network transport.
    """

    header_length = 32

    def parse(self, payload: bytes) -> ParsedIacsDatagram:
        if len(payload) < self.header_length:
            raise IacsParseError("datagram_shorter_than_iacs_header")

        numeric: dict[str, int] = {}
        waveforms: dict[str, list[int]] = {}
        waveform_tags: dict[str, int] = {}
        bed_label: str | None = None
        message: str | None = None
        position = self.header_length
        trailing_offset: int | None = None

        while position < len(payload):
            self._require(payload, position, 2)
            tag = (payload[position], payload[position + 1])

            if tag == (0, 12):
                block_length = 12
            elif tag in {(0, 200), (0, 100), (0, 50)}:
                sample_count, block_length = {
                    (0, 200): (40, 94),
                    (0, 100): (20, 54),
                    (0, 50): (10, 34),
                }[tag]
                self._require(payload, position, block_length)
                key = self._key(payload[position + 10 : position + 12])
                waveforms[key] = self._signed_list(payload, position + 14, sample_count)
                waveform_tags[key] = tag[1]
            elif tag == (0, 14):
                self._require(payload, position, 6)
                count = payload[position + 4]
                block_length = 6 + count * 36
                self._require(payload, position, block_length)
                base = position + 6
                for index in range(count):
                    entry = base + index * 36
                    key = self._key(payload[entry + 20 : entry + 25])
                    numeric[key] = self._signed_value(payload, entry)
            elif tag in {(0, 0), (0, 120)}:
                block_length = 36
                self._require(payload, position, block_length)
                key = self._key(payload[position + 14 : position + 19])
                numeric[key] = self._signed_value(payload, position + 30)
            elif tag == (0, 18):
                block_length = 130
                self._require(payload, position, block_length)
                characters = []
                for index in range(24):
                    value = payload[position + index * 2 + 5]
                    if value == 0:
                        break
                    characters.append(chr(value))
                message = "".join(characters) or None
            elif tag == (0, 10):
                block_length = 116
                self._require(payload, position, block_length)
                # The legacy parser reads the label from absolute byte 65.
                characters = []
                for index in range(8):
                    offset = 65 + index * 2
                    if offset >= len(payload) or payload[offset] == 0:
                        break
                    characters.append(chr(payload[offset]))
                bed_label = "".join(characters).strip() or None
            elif tag == (0, 15):
                block_length = 252
                self._require(payload, position, block_length)
            elif tag == (0, 24):
                block_length = 194
                self._require(payload, position, block_length)
            else:
                trailing_offset = position
                break

            self._require(payload, position, block_length)
            position += block_length

        return ParsedIacsDatagram(
            numeric_values=numeric,
            waveforms=waveforms,
            waveform_tags=waveform_tags,
            bed_label=bed_label,
            message=message,
            trailing_offset=trailing_offset,
        )

    @staticmethod
    def _require(payload: bytes, position: int, length: int) -> None:
        if position + length > len(payload):
            raise IacsParseError(f"truncated_iacs_block_at_{position}")

    @staticmethod
    def _key(value: bytes) -> str:
        return "-".join(str(part) for part in value)

    @staticmethod
    def _signed_value(payload: bytes, position: int) -> int:
        return int.from_bytes(payload[position : position + 2], byteorder="big", signed=True)

    def _signed_list(self, payload: bytes, position: int, count: int) -> list[int]:
        return [self._signed_value(payload, position + index * 2) for index in range(count)]
