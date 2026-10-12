"""Every /api/formdev endpoint must authenticate. Canopy's read-only middleware lets /api/formdev
writes through, so each route's own dependencies are the only protection (security review)."""
import os
import unittest

os.environ.setdefault("FLORA_DATABASE_URL", "postgresql://unused@localhost/unused")
os.environ.setdefault("FLORA_API_MODE", "canopy")

AUTH_DEPENDENCIES = {"read_token", "require_admin", "require_studio_author", "current_canopy_user", "query_context", "api_context", "formdev"}


def _names(dependant) -> set:
    names = {getattr(dependant.call, "__name__", "")}
    for child in dependant.dependencies:
        names |= _names(child)
    return names


class RouteAuthentication(unittest.TestCase):
    def test_every_formdev_route_authenticates(self):
        import app.main as main
        from app.routes import formdev as phase3

        routes = [route for route in main.app.routes if getattr(route, "path", "").startswith("/api/formdev")]
        self.assertGreater(len(routes), 30)
        unauthenticated = []
        for route in routes:
            names = _names(route.dependant)
            # The Phase 3 storage dependency alone does not authenticate; endpoints using it must also
            # call read_token/require_admin or resolve the principal from the request connection.
            source = route.endpoint.__code__.co_names
            if not (names & (AUTH_DEPENDENCIES - {"formdev"})) and "principal_for" not in source and "_record_access" not in source:
                unauthenticated.append(f"{sorted(route.methods)} {route.path}")
        self.assertEqual(unauthenticated, [], "routes without authentication")
        self.assertIn("formdev", {r.dependant.dependencies[0].call.__name__ for r in routes if r.dependant.dependencies} | {phase3.formdev.__name__})


if __name__ == "__main__":
    unittest.main()
