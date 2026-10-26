"""Deliver outbound messages: HL7 v2 over MLLP (TCP), FHIR R4 over HTTP(S)."""
from __future__ import annotations

import base64
import json
import os
import socket
import ssl
import tempfile
import urllib.error
import urllib.request
from typing import Any

START, END = b"\x0b", b"\x1c\x0d"
TIMEOUT = 15.0


class SendError(Exception):
    """Delivery failed. `retry` is False when the receiver rejected the message itself."""

    def __init__(self, message: str, response: str = "", retry: bool = True):
        super().__init__(message)
        self.response = response
        self.retry = retry


def tls_context(destination: dict[str, Any]) -> ssl.SSLContext:
    """Client TLS context: the destination's CA (or the system CAs) and, for mutual TLS, its client certificate."""
    try:
        context = ssl.create_default_context(cadata=destination.get("ca_cert") or None)
        if destination.get("ca_cert"):
            # Hospital private CAs often issue certificates without extensions RFC 5280 asks for (e.g. the
            # authority key identifier), which Python's strict mode refuses. The chain and host name are still checked.
            context.verify_flags &= ~getattr(ssl, "VERIFY_X509_STRICT", 0)
        if not destination.get("verify_tls", True):
            context.check_hostname = False
            context.verify_mode = ssl.CERT_NONE
        if destination.get("client_cert") and destination.get("client_key"):
            # load_cert_chain reads files only: write the PEMs to private temporary files for the call.
            with tempfile.TemporaryDirectory() as folder:
                cert, key = os.path.join(folder, "cert.pem"), os.path.join(folder, "key.pem")
                for path, text in ((cert, destination["client_cert"]), (key, destination["client_key"])):
                    with open(os.open(path, os.O_WRONLY | os.O_CREAT, 0o600), "w") as handle:
                        handle.write(text)
                context.load_cert_chain(cert, key)
    except (ssl.SSLError, ValueError, OSError) as exc:
        raise SendError(f"TLS settings: {exc}", retry=False) from exc
    return context


def send_mllp(destination: dict[str, Any], message: str) -> str:
    """Send one framed message (over TLS when the destination asks for it) and wait for the ACK.
    Raises SendError unless MSA-1 is AA or CA."""
    host, port = (destination.get("host") or "").strip(), destination.get("port")
    if not host or not port:
        raise SendError("destination has no host or port", retry=False)
    context = tls_context(destination) if destination.get("tls") else None
    try:
        with socket.create_connection((host, int(port)), timeout=TIMEOUT) as raw:
            sock: socket.socket = context.wrap_socket(raw, server_hostname=host) if context else raw
            try:
                sock.sendall(START + message.encode("utf-8") + END)
                buffer = b""
                while END not in buffer:
                    chunk = sock.recv(65536)
                    if not chunk:
                        break
                    buffer += chunk
            finally:
                if sock is not raw:
                    sock.close()
    except ssl.SSLCertVerificationError as exc:
        raise SendError(f"MLLP/TLS {host}:{port}: certificate not trusted: {exc.verify_message}", retry=False) from exc
    except OSError as exc:
        raise SendError(f"MLLP{'/TLS' if context else ''} {host}:{port}: {exc}") from exc
    ack = buffer.strip(START + END + b"\r\n").decode("utf-8", "replace")
    if not ack:
        raise SendError("no ACK received")
    code, text = ack_status(ack)
    if code in ("AA", "CA"):
        return ack
    # AE: application error (may succeed later); AR / CR: rejected, resending the same message will not help.
    raise SendError(f"ACK {code or '?'}{': ' + text if text else ''}", response=ack, retry=code in ("AE", "CE", ""))


def ack_status(ack: str) -> tuple[str, str]:
    for segment in ack.replace("\n", "\r").split("\r"):
        if segment.startswith("MSA"):
            fields = segment.split("|")
            return (fields[1] if len(fields) > 1 else "", fields[3] if len(fields) > 3 else "")
    return "", ""


def send_fhir(destination: dict[str, Any], bundle: dict[str, Any]) -> str:
    url = (destination.get("url") or "").strip()
    if not url:
        raise SendError("destination has no URL", retry=False)
    headers = {"Content-Type": "application/fhir+json", "Accept": "application/fhir+json"}
    if destination.get("auth_type") == "bearer" and destination.get("bearer_token"):
        headers["Authorization"] = f"Bearer {destination['bearer_token']}"
    elif destination.get("auth_type") == "basic":
        pair = f"{destination.get('username') or ''}:{destination.get('password') or ''}".encode()
        headers["Authorization"] = "Basic " + base64.b64encode(pair).decode()
    request = urllib.request.Request(url, data=json.dumps(bundle, ensure_ascii=False).encode("utf-8"), headers=headers,
                                     method="POST")
    context = None
    if url.startswith("https") and not destination.get("verify_tls", True):
        context = ssl.create_default_context()
        context.check_hostname = False
        context.verify_mode = ssl.CERT_NONE
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT, context=context) as response:
            body = response.read(4000).decode("utf-8", "replace")
            return body or f"HTTP {response.status}"
    except urllib.error.HTTPError as error:
        body = error.read(4000).decode("utf-8", "replace")
        # 4xx other than 408/429 means the server will not accept this message as it is.
        retry = error.code >= 500 or error.code in (408, 429)
        raise SendError(f"HTTP {error.code}", response=body, retry=retry) from error
    except (urllib.error.URLError, OSError) as exc:
        raise SendError(f"HTTP {url}: {exc}") from exc
