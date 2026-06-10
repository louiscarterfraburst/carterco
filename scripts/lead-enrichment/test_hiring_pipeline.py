#!/usr/bin/env python3
"""Regression tests for the hiring-signal pipeline's failure modes.

Covers the two cron outages of 2026-06-09/10:
  - duplicate linkedin_url within one batch → PostgREST 500 on the
    on_conflict upsert (fixed by dedupe_first_by_url)
  - transient API errors (Apify 403, PostgREST 5xx) killing a whole run
    because nothing retried and the error body was discarded

Run: python3 -m unittest discover -s scripts/lead-enrichment -p 'test_*.py'
"""
from __future__ import annotations

import io
import os
import unittest
import urllib.error
import urllib.request
from unittest import mock

# The pipeline scripts hard-exit at import when their env is missing; tests
# never talk to the network, so dummies are fine.
os.environ.setdefault("SUPABASE_URL", "https://example.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-key")
os.environ.setdefault("APIFY_API_TOKEN", "test-token")

import _http_retry
import apify_hiring_intake
import load_hiring_batch
from _http_retry import TRANSIENT_STATUSES, urlopen_retry


def _http_error(code: int, body: bytes = b"boom") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://x.test/y", code, "err",
                                  hdrs=None, fp=io.BytesIO(body))


def _response(payload: bytes = b"{}"):
    r = mock.MagicMock()
    r.read.return_value = payload
    r.__enter__ = lambda self: self
    r.__exit__ = lambda self, *a: False
    return r


class DedupeFirstByUrl(unittest.TestCase):
    """Regression for 2026-06-10: same buyer matched to two companies put the
    conflict key twice in one upsert → Postgres 500, whole load stage dead."""

    def test_keeps_first_occurrence_per_url(self):
        rows = [
            {"linkedin_profile_url": "https://linkedin.com/in/jeppe", "brand": "Ibexa"},
            {"linkedin_profile_url": "https://linkedin.com/in/other", "brand": "Acme"},
            {"linkedin_profile_url": "https://linkedin.com/in/jeppe", "brand": "Raptor"},
        ]
        out = load_hiring_batch.dedupe_first_by_url(rows)
        self.assertEqual([r["brand"] for r in out], ["Ibexa", "Acme"])

    def test_whitespace_around_url_still_collides(self):
        rows = [
            {"linkedin_profile_url": "https://linkedin.com/in/jeppe"},
            {"linkedin_profile_url": " https://linkedin.com/in/jeppe "},
        ]
        self.assertEqual(len(load_hiring_batch.dedupe_first_by_url(rows)), 1)

    def test_empty_batch(self):
        self.assertEqual(load_hiring_batch.dedupe_first_by_url([]), [])


class UrlopenRetry(unittest.TestCase):
    def setUp(self):
        self.req = urllib.request.Request("https://x.test/y")
        self.sleeps: list[int] = []
        self.sleep = self.sleeps.append

    def test_transient_500_retried_then_succeeds(self):
        ok = _response(b'{"fine": true}')
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(500), ok]) as m:
            got = urlopen_retry(self.req, sleep=self.sleep)
        self.assertIs(got, ok)
        self.assertEqual(m.call_count, 2)
        self.assertEqual(self.sleeps, [10])

    def test_persistent_500_raises_after_attempts(self):
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(500)] * 3) as m:
            with self.assertRaises(urllib.error.HTTPError):
                urlopen_retry(self.req, attempts=3, sleep=self.sleep)
        self.assertEqual(m.call_count, 3)
        self.assertEqual(self.sleeps, [10, 30])

    def test_non_transient_400_raises_immediately(self):
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(400)]) as m:
            with self.assertRaises(urllib.error.HTTPError):
                urlopen_retry(self.req, sleep=self.sleep)
        self.assertEqual(m.call_count, 1)
        self.assertEqual(self.sleeps, [])

    def test_403_not_retried_by_default(self):
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(403)]) as m:
            with self.assertRaises(urllib.error.HTTPError):
                urlopen_retry(self.req, sleep=self.sleep)
        self.assertEqual(m.call_count, 1)

    def test_403_retried_with_apify_statuses(self):
        """Regression for 2026-06-09: a transient Apify 403 killed the cron;
        the same call succeeded the day before and the day after."""
        ok = _response()
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(403), ok]) as m:
            got = urlopen_retry(self.req, sleep=self.sleep,
                                retry_statuses=TRANSIENT_STATUSES | {403})
        self.assertIs(got, ok)
        self.assertEqual(m.call_count, 2)

    def test_network_error_retried(self):
        ok = _response()
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[urllib.error.URLError("reset"), ok]) as m:
            got = urlopen_retry(self.req, sleep=self.sleep)
        self.assertIs(got, ok)
        self.assertEqual(m.call_count, 2)

    def test_error_body_lands_in_stderr(self):
        """The 06-09/06-10 outages were diagnosed blind because the response
        body was discarded. The body must reach the (CI) log."""
        err = _http_error(500, body=b"ON CONFLICT DO UPDATE cannot affect row")
        stderr = io.StringIO()
        with mock.patch.object(_http_retry.urllib.request, "urlopen", side_effect=[err]):
            with mock.patch.object(_http_retry.sys, "stderr", stderr):
                with self.assertRaises(urllib.error.HTTPError):
                    urlopen_retry(self.req, attempts=1, sleep=self.sleep)
        self.assertIn("ON CONFLICT DO UPDATE", stderr.getvalue())


class PipelineWiring(unittest.TestCase):
    def test_apify_retry_statuses_include_403_and_transients(self):
        self.assertIn(403, apify_hiring_intake.APIFY_RETRY_STATUSES)
        self.assertTrue(TRANSIENT_STATUSES <= apify_hiring_intake.APIFY_RETRY_STATUSES)

    def test_sb_retries_transient_500(self):
        """sb() (the stage-4 Supabase caller) must go through the retry path."""
        ok = _response(b'[{"id": 1}]')
        with mock.patch.object(_http_retry.urllib.request, "urlopen",
                               side_effect=[_http_error(503), ok]) as m:
            with mock.patch.object(_http_retry.time, "sleep"):
                got = load_hiring_batch.sb("GET", "outreach_leads?select=id")
        self.assertEqual(got, [{"id": 1}])
        self.assertEqual(m.call_count, 2)


if __name__ == "__main__":
    unittest.main()
