"""Polling requests that succeed are kept out of the access log; errors and real work stay in it."""
import logging
import unittest

from app.access_log import PollFilter


def record(method, path, status):
    return logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d', ("10.0.0.1:1", method, path, "1.1", status), None)


class Quiet(unittest.TestCase):
    def test_successful_polls_are_quiet_and_everything_else_is_logged(self):
        keep = PollFilter().filter
        for method, path in (("GET", "/health"), ("GET", "/api/ward/sync-control"), ("GET", "/api/formdev/reading/jobs/abc?after=4"),
                             ("GET", "/api/case/12/vitals"), ("PUT", "/api/ward/sync-status"), ("PUT", "/api/leaf-sync/state/case_forms.active"),
                             ("PUT", "/api/leaf-sync/cases"), ("POST", "/api/sync/v1/batch"), ("PUT", "/api/case/staff/sync/apply")):
            self.assertFalse(keep(record(method, path, 200)), path)
        self.assertTrue(keep(record("GET", "/api/ward/sync-control", 500)), "an error is always logged")
        self.assertTrue(keep(record("GET", "/api/formdev/reading/jobs/abc", 404)))
        self.assertTrue(keep(record("POST", "/api/formdev/reading/jobs", 200)), "starting work is logged")
        self.assertTrue(keep(record("PUT", "/api/case/12/documents", 200)))
        self.assertTrue(keep(logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, "other", None, None)))


if __name__ == "__main__":
    unittest.main()
