"""LDAP / Active Directory sign-in for Canopy (and Leafs, through Canopy).

Search-then-bind: find the user's entry with the service account, then bind as
that entry with the supplied password. Configure with FLORA_LDAP_* variables.
"""
import logging
import os
from typing import Any

log = logging.getLogger("flora.ldap")


def _env(name: str, default: str = "") -> str:
    return os.getenv(f"FLORA_LDAP_{name}", default).strip()


def enabled() -> bool:
    return _env("ENABLED", "false").lower() in {"1", "true", "yes", "on"} and bool(_env("URL"))


def auto_provision() -> bool:
    return _env("AUTO_PROVISION", "false").lower() in {"1", "true", "yes", "on"}


def default_role() -> str:
    return _env("DEFAULT_ROLE", "viewer") or "viewer"


class LdapUnavailable(Exception):
    """The directory server could not be reached or the service bind failed."""


def authenticate(username: str, password: str) -> dict[str, Any] | None:
    """Return {dn, name, email} when the credentials are valid, None when they are not."""
    if not enabled():
        return None
    # An empty password is an anonymous bind, which many servers accept.
    if not username.strip() or not password:
        return None
    from ldap3 import Connection, Server, SUBTREE, Tls
    from ldap3.core.exceptions import LDAPBindError, LDAPException
    from ldap3.utils.conv import escape_filter_chars
    import ssl

    url = _env("URL")
    # ldap3 packs the receive timeout into a socket option, so it must be an int.
    timeout = max(1, int(float(_env("TIMEOUT_SECONDS", "5") or 5)))
    verify = _env("TLS_VERIFY", "true").lower() not in {"0", "false", "no", "off"}
    tls = Tls(validate=ssl.CERT_REQUIRED if verify else ssl.CERT_NONE)
    server = Server(url, use_ssl=url.lower().startswith("ldaps://"), tls=tls, connect_timeout=timeout)
    name_attr = _env("NAME_ATTR", "displayName") or "displayName"
    mail_attr = _env("MAIL_ATTR", "mail") or "mail"
    user_filter = _env("USER_FILTER", "(uid={username})") or "(uid={username})"
    try:
        service = Connection(
            server, user=_env("BIND_DN") or None, password=_env("BIND_PASSWORD") or None,
            receive_timeout=timeout, raise_exceptions=False,
        )
        if _env("START_TLS", "false").lower() in {"1", "true", "yes", "on"}:
            service.open()
            service.start_tls()
        if not service.bind():
            raise LdapUnavailable(f"service bind failed: {service.result.get('description')}")
        service.search(
            _env("BASE_DN"), user_filter.replace("{username}", escape_filter_chars(username.strip())),
            search_scope=SUBTREE, attributes=[name_attr, mail_attr], size_limit=2,
        )
        entries = list(service.entries)
        service.unbind()
    except (LDAPException, OSError, ValueError) as error:
        raise LdapUnavailable(str(error)) from error
    if len(entries) != 1:
        return None
    entry = entries[0]
    try:
        user = Connection(server, user=entry.entry_dn, password=password, receive_timeout=timeout,
                          raise_exceptions=False)
        if _env("START_TLS", "false").lower() in {"1", "true", "yes", "on"}:
            user.open()
            user.start_tls()
        bound = user.bind()
        user.unbind()
        if not bound:
            return None
    except LDAPBindError:
        return None
    except (LDAPException, OSError, ValueError) as error:
        raise LdapUnavailable(str(error)) from error

    def first(attr: str) -> str | None:
        values = entry.entry_attributes_as_dict.get(attr) or []
        return str(values[0]) if values else None

    return {"dn": entry.entry_dn, "name": first(name_attr), "email": first(mail_attr)}
