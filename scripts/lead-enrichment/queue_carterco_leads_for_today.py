#!/usr/bin/env python3
"""Queue the top N CarterCo Adalo-imported leads for today's I dag view.

Sets next_action_at = now() on the highest-priority untriaged leads imported
from the Adalo legacy batch (source = adalo_legacy_2026-05-19), so they
appear in the daily Ring queue. By default queues the top 5.

Priority order (matches the conversation's recommended call order):
  1. CustomOffice (past converted)
  2. Stadsrevisionen Danmark (booked, didn't close)
  3. Mx Eventudlejning (booked, didn't close)
  4. Boston Group A/S (hand-curated, 51-emp wholesale)
  5. Agri-Norcold A/S (hand-curated, 350-emp cold storage)
  ...then the rest of the hand-curated, then CVR-confirmed.

Usage:
  set -a; source .env.local; set +a
  python3 scripts/lead-enrichment/queue_carterco_leads_for_today.py            # dry-run
  python3 scripts/lead-enrichment/queue_carterco_leads_for_today.py --apply    # write
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CARTERCO_WORKSPACE_ID = "1e067f9a-d453-41a7-8bc4-9fdb5644a5fa"
SOURCE_TAG = "adalo_legacy_2026-05-19"

# Priority order — phone last-7-digits to ID rows reliably even if formatting
# differs (Adalo stored some as 8-digit raw, some as +45-prefixed).
PRIORITY_PHONES_LAST7 = [
    "1741777",  # CustomOffice — Svend Vestergaard, past converted
    "5603013",  # Stadsrevisionen — Joshua A. Rix, booked not closed
    "1325325",  # Mx Eventudlejning — Martin, booked not closed
    "1391424",  # Boston Group A/S — Philip, hand-curated 51-emp
    "1755896",  # Agri-Norcold A/S — Kjeld, hand-curated 350-emp
    "1164625",  # Hoei Denmark — Christian, hand-curated
    "2118022",  # Zederkof A/S — Jan, hand-curated 22-emp furniture wholesale
    "9408051",  # MIS Recycling A/S — Tom, 38-emp byggepladsarbejder
    "0692265",  # Malerfirma Carsten Sørensen — Alexander
    "0350574",  # DENCON Foods — Henrik Bekker
    "0857771",  # Dagrofa A/S — Christian Søgaard
    "0570808",  # bygogbolig.dk — Peter
    "0496474",  # Container-lageret — Kasper
    "1180848",  # Tietgen Pension — Jacob
    "1203252",  # Ryby Hvidevarer A/S — Oliver
    "0889491",  # TWO Teknik — Tim Warner
    "9877401",  # Malerfix — Malerfix Aps
    "2694040",  # Drivedesk — Mathias
    "3201520",  # Sollu — Kasper Brand
]


def env(key: str, *fb: str) -> str:
    for k in (key,) + fb:
        v = os.environ.get(k)
        if v:
            return v
    sys.exit(f"required env var: {key}")


def patch(sb_url: str, sb_key: str, lead_id: str, at_iso: str) -> bool:
    body = json.dumps({"next_action_at": at_iso,
                       "next_action_type": None}).encode()
    req = urllib.request.Request(
        f"{sb_url}/rest/v1/leads?id=eq.{lead_id}",
        data=body,
        method="PATCH",
        headers={
            "apikey": sb_key,
            "Authorization": f"Bearer {sb_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as f:
            f.read()
        return True
    except urllib.error.HTTPError as e:
        print(f"  PATCH error {e.code}: {e.read().decode()[:200]}",
              file=sys.stderr)
        return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--top", type=int, default=5,
                    help="how many to queue (default 5)")
    ap.add_argument("--at", default="now",
                    help="when to queue: 'now', 'tomorrow', or ISO timestamp "
                    "(e.g. 2026-05-20T09:00:00+02:00). 'tomorrow' = next day "
                    "at 09:00 Europe/Copenhagen.")
    ap.add_argument("--skip-already-queued", action="store_true", default=True,
                    help="skip leads that already have next_action_at set")
    ap.add_argument("--apply", action="store_true",
                    help="actually PATCH (default is dry-run)")
    args = ap.parse_args()

    # Resolve --at to an ISO timestamp Postgres accepts
    from datetime import datetime, timedelta, timezone
    cph = timezone(timedelta(hours=2))  # CEST in May
    if args.at == "now":
        at_iso = datetime.now(cph).isoformat()
    elif args.at == "tomorrow":
        tomorrow = (datetime.now(cph) + timedelta(days=1)).replace(
            hour=9, minute=0, second=0, microsecond=0)
        at_iso = tomorrow.isoformat()
    else:
        at_iso = args.at  # raw ISO passthrough
    print(f"  scheduling for: {at_iso}")

    sb_url = env("SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL")
    sb_key = env("SUPABASE_SERVICE_ROLE_KEY")

    # Fetch all adalo_legacy leads in the workspace
    q = urllib.parse.urlencode({
        "workspace_id": f"eq.{CARTERCO_WORKSPACE_ID}",
        "source": f"eq.{SOURCE_TAG}",
        "select": "id,name,company,phone,next_action_at",
    })
    req = urllib.request.Request(
        f"{sb_url}/rest/v1/leads?{q}",
        headers={"apikey": sb_key, "Authorization": f"Bearer {sb_key}"},
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        leads = json.loads(r.read())
    print(f"  found {len(leads)} adalo_legacy leads in workspace")

    # Pick top N by priority phone list, skipping already-queued
    def last7(s: str) -> str:
        return "".join(c for c in (s or "") if c.isdigit())[-7:]

    by_l7 = {last7(l["phone"]): l for l in leads if l.get("phone")}
    queued: list[dict] = []
    seen = set()
    for pl7 in PRIORITY_PHONES_LAST7:
        l = by_l7.get(pl7)
        if not l or l["id"] in seen:
            continue
        if args.skip_already_queued and l.get("next_action_at"):
            continue
        seen.add(l["id"])
        queued.append(l)
        if len(queued) >= args.top:
            break

    # Pad with any other un-queued leads if priority list runs out
    if len(queued) < args.top:
        for l in leads:
            if l["id"] in seen:
                continue
            if l.get("next_action_at"):
                continue
            queued.append(l)
            seen.add(l["id"])
            if len(queued) >= args.top:
                break

    print(f"  queuing top {len(queued)}:")
    for l in queued:
        already = " (ALREADY QUEUED)" if l.get("next_action_at") else ""
        print(f"    - {l.get('company') or '(no co)':35s} | "
              f"{l.get('name') or '(no name)':25s} | "
              f"{l.get('phone'):14s}{already}")

    if not args.apply:
        print()
        print("(dry-run — pass --apply to PATCH next_action_at = now())")
        return 0

    print()
    ok = err = 0
    for l in queued:
        if patch(sb_url, sb_key, l["id"], at_iso):
            ok += 1
            print(f"  ✓ queued {l.get('company')}")
        else:
            err += 1
    print()
    print(f"=== DONE: {ok} queued, {err} errors ===")
    return 0 if err == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
