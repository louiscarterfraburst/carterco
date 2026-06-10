#!/usr/bin/env python3
"""Shared urlopen wrapper for the hiring-signal pipeline: transient-error
retry + always surface the HTTP error response body.

Two cron outages motivated this, both diagnosed blind because the response
body was discarded:
  - 2026-06-09: Apify rejected the stage-1 actor-start POST with a transient
    403; the run died and the day's intake was silently lost.
  - 2026-06-10: PostgREST 500 in stage 4 ("ON CONFLICT DO UPDATE command
    cannot affect row a second time") — deterministic, but the body naming
    the cause was dropped.

Retry policy: network errors and statuses in `retry_statuses` get up to
`attempts` tries with backoff; everything else raises immediately. The error
detail is printed to stderr in ALL failure cases so the CI log names the
cause without archaeology.
"""
from __future__ import annotations

import sys
import time
import urllib.error
import urllib.request

TRANSIENT_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
BACKOFF_SECONDS = (10, 30, 60)


def describe_http_error(e: urllib.error.HTTPError) -> str:
    try:
        body = e.read().decode(errors="replace")[:400]
    except Exception:
        body = "<unreadable body>"
    return f"HTTP {e.code} {e.reason} from {e.url}: {body}"


def urlopen_retry(req, timeout: int = 60, attempts: int = 3,
                  retry_statuses: frozenset[int] = TRANSIENT_STATUSES,
                  sleep=None):
    """urllib.request.urlopen with retry. Returns the open response.

    `sleep` is injectable for tests (defaults to time.sleep, resolved late so
    tests can also patch the module). The final failure re-raises the original
    exception, so existing callers' except clauses keep working.
    """
    if sleep is None:
        sleep = time.sleep
    for attempt in range(1, attempts + 1):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            retryable = e.code in retry_statuses and attempt < attempts
            print(f"WARN: {describe_http_error(e)} "
                  f"(attempt {attempt}/{attempts}"
                  f"{', retrying' if retryable else ', giving up'})",
                  file=sys.stderr)
            if not retryable:
                raise
        except OSError as e:  # URLError, raw socket timeouts
            retryable = attempt < attempts
            reason = getattr(e, "reason", e)
            print(f"WARN: network error from "
                  f"{getattr(req, 'full_url', req)}: {reason} "
                  f"(attempt {attempt}/{attempts}"
                  f"{', retrying' if retryable else ', giving up'})",
                  file=sys.stderr)
            if not retryable:
                raise
        sleep(BACKOFF_SECONDS[min(attempt - 1, len(BACKOFF_SECONDS) - 1)])
