#!/usr/bin/env python3
"""Mine the old Adalo CRM export for CarterCo ICP fits.

Reads ~/Downloads/Leads (79).csv (or --csv override), filters to rows owned by
hauge@burstcreators.com (or --owner override), scores every row on realness +
engagement + ICP-vertical-pattern signal, and emits five bucketed CSVs into
clients/carterco/data/adalo_mined/.

Buckets (mutually exclusive, evaluated top-down):
  rejects                      - hard-excluded (Bad/Unqualified/generic-domain/junk-phone)
  past_client_known_icp        - Converted/Onboarding + recognized vertical (re-engage with "old customer" message)
  needs_llm_review_high_prio   - real + engaged but vertical unknown (CustomOffice case)
  tier_a_reengage              - Booked-not-Converted + recognized vertical (classic re-engage)
  tier_b_icp_new               - strong realness + strong ICP, low/no prior engagement
  needs_llm_review             - middle band - LLM decides
"""
from __future__ import annotations

import argparse
import csv
import re
import sys
from collections import Counter
from pathlib import Path

GENERIC_DOMAINS = {
    "gmail.com", "hotmail.com", "outlook.com", "icloud.com", "yahoo.com",
    "live.dk", "live.com", "me.com", "aol.com", "proton.me", "protonmail.com",
    "msn.com", "mail.com", "mac.com", "yahoo.dk", "hotmail.dk", "outlook.dk",
}

JUNK_PHONES = {"7777777777", "00000000", "11111111", "12345678", "99999999",
               "84629562839", "1234567890"}

DK_SUFFIX_RE = re.compile(r"\b(a/s|aps|p/s|i/s|k/s|holding)\b", re.I)

VERTICAL_PATTERNS = {
    "b2b_cleaning": [
        r"reng[øo]ring", r"cleaning", r"facility", r"ejendomsservice",
        r"vinduespolering", r"vinduespudsning", r"\bpolering\b",
    ],
    "b2b_accounting": [
        r"bogf[øo]ring", r"regnskab", r"revision", r"\brevisor\b",
        r"accounting", r"accountant", r"\bl[øo]n\b", r"payroll",
    ],
    "b2b_realestate": [
        r"\bejendom\b", r"ejendomme", r"erhvervsejendom", r"real estate",
        r"property", r"administration", r"udlejning", r"\bbolig\b",
    ],
    "home_services": [
        r"\bvvs\b", r"t[øo]mrer", r"\bmurer\b", r"\bmaler\b",
        r"elektriker", r"el[- ]?installat[øo]r", r"entreprise",
        r"entrepren[øo]r", r"\bbyg\b", r"bygge", r"anl[æa]g", r"\bkloak\b",
        r"\btag\b", r"glarmester", r"\bgulv\b", r"\bhave\b", r"brol[æa]gger",
    ],
    "b2b_services_misc": [
        r"logistik", r"transport", r"spedition", r"spedit[øo]r",
        r"\blager\b", r"distribution", r"grossist", r"engros",
        r"wholesale", r"industri", r"recycling", r"genbrug",
        r"\bauto\b", r"bilpleje", r"v[æa]rksted", r"skadecenter",
        r"\bservice\b",
    ],
    "b2b_office_supply_fitout": [
        # Brand names compound these freely (CustomOffice, NemKontor, etc.) —
        # so no \b boundaries on the core nouns.
        r"kontor", r"office", r"workspace", r"workplace",
        r"interi[øo]r", r"indretning", r"furniture", r"m[øo]bler",
        r"office supply", r"office supplies", r"kontorartik", r"kontorudstyr",
        r"kontorm[øo]bl", r"fit[- ]?out", r"ergonomi",
        r"h[æa]ve[- ]?s[æa]nke", r"skrivebord", r"kontorstol",
    ],
    "b2b_signage_print": [
        r"\bskilte\b", r"skiltning", r"facadeskilt", r"bilskilte",
        r"foliering", r"\bfolie\b", r"\bbanner\b", r"storformat",
        r"wayfinding", r"signage", r"\bsign\b", r"\bsigns\b",
        r"vehicle wrap", r"\bprint\b", r"\btryk\b", r"trykkeri",
        r"grafisk", r"profilbekl[æa]dning", r"reklameartik",
    ],
    "b2b_av_event_technical": [
        r"\bav\b", r"audio[- ]?visual", r"\blyd\b", r"\blys\b",
        r"\bscene\b", r"sceneteknik", r"konferenceudstyr", r"m[øo]deudstyr",
        r"projektor", r"sk[æa]rm", r"led[- ]?sk[æa]rm",
        r"eventudstyr", r"event[- ]?teknik", r"udlejning",
    ],
    "b2b_it_services": [
        r"\bit[- ]service\b", r"it[- ]?support", r"it[- ]?drift",
        r"managed services", r"\bmsp\b", r"hosting", r"\bcloud\b",
        r"\bcyber\b", r"\bbackup\b", r"netv[æa]rk", r"\bserver\b",
        r"helpdesk", r"microsoft 365", r"\berp\b", r"\bcrm\b",
    ],
    "b2b_security": [
        r"sikkerhed", r"\balarm\b", r"alarmsystem", r"alarmcentral",
        r"adgangskontrol", r"videoover[v]?[åa]gning", r"over[v]?[åa]gning",
        r"\bcctv\b", r"\bvagt\b", r"\bsecurity\b", r"access control",
        r"brandalarm", r"brandsikring", r"\blåse\b", r"\blaase\b",
        r"l[åa]sesmed",
    ],
    "b2b_facility_catering": [
        r"\bkantine\b", r"\bcatering\b", r"firmafrokost", r"frokostordning",
        r"kaffeordning", r"frugtordning", r"m[åa]ltidsservice",
        r"meal service", r"corporate catering",
    ],
    "b2b_landscaping_facility": [
        r"\bgartner\b", r"anl[æa]gsgartner", r"landscaping",
        r"gr[øo]n service", r"gr[øo]nt vedligehold",
        r"grounds maintenance", r"ejendomsdrift", r"vicev[æa]rt",
        r"snerydning", r"\bsaltning\b",
    ],
}

EXCLUDE_PATTERNS = [
    r"\bagency\b", r"\bbureau\b", r"\bmarketing\b", r"\bseo\b", r"\bads\b",
    r"\bad\b", r"\bmedia\b", r"\binfluencer\b", r"fashion", r"clothing",
    r"\bshop\b", r"\bstore\b", r"jewelry", r"jewellery", r"\bbeauty\b",
    r"cosmetic", r"\brestaurant\b", r"\bcafe\b", r"takeaway", r"\bbar\b",
    r"nightclub", r"\bparty\b", r"b[øo]rnef[øo]dselsdag", r"\bwedding\b",
    r"\bbryllup\b", r"\bgave\b", r"gift shop", r"webshop", r"\bb2c\b",
    r"\bfitness\b", r"\bcoach\b", r"\bartist\b", r"musician",
]

BOOL_FIELDS = ["Sent SMS", "Contacted", "Booked meeting", "Sendt mail",
               "Unqualified", "Converted", "Snitcher lead", "Bad", "Lost",
               "Onboarding", "Contacted 2", "Contacted 3", "Contacted 4",
               "Old lead"]


def truthy(v) -> bool:
    return str(v or "").strip().lower() in {"true", "1", "yes", "ja", "x"}


def norm(s) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip())


def clean_domain(value: str) -> str:
    s = norm(value).lower()
    s = re.sub(r"^https?://", "", s)
    s = re.sub(r"^www\.", "", s)
    s = s.split("/")[0]
    if "@" in s:
        s = s.split("@")[-1]
    return s.strip(" .,")


def email_domain(email: str) -> str:
    email = norm(email).lower()
    return email.split("@")[-1] if "@" in email else ""


def company_text(row: dict) -> str:
    return norm(row.get("Company")) or norm(row.get("Virksomhed"))


def is_probably_domain(s: str) -> bool:
    s = norm(s).lower()
    return bool(re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", s))


def valid_dk_phone(phone: str) -> bool:
    digits = re.sub(r"\D", "", str(phone or ""))
    if digits in JUNK_PHONES:
        return False
    if digits.startswith("45") and len(digits) == 10:
        return True
    if len(digits) == 8 and not digits.startswith(("0", "1")):
        return True
    return False


def junk_phone(phone: str) -> bool:
    digits = re.sub(r"\D", "", str(phone or ""))
    if not digits:
        return False
    if digits in JUNK_PHONES:
        return True
    if len(set(digits)) <= 2:
        return True
    return False


def pattern_hits(text: str, patterns: list[str]) -> list[str]:
    return [p for p in patterns if re.search(p, text, re.I)]


def classify(row: dict) -> dict:
    co = company_text(row)
    email = norm(row.get("Email")).lower()
    phone = norm(row.get("Phone number")) or norm(row.get("Company phone"))
    edomain = email_domain(email)
    co_domain = clean_domain(co) if is_probably_domain(co) else ""

    searchable = " ".join([co.lower(),
                           co_domain.replace(".", " "),
                           edomain.replace(".", " ")])

    flags = {f: truthy(row.get(f)) for f in BOOL_FIELDS}

    reasons: list[str] = []
    verticals: list[str] = []
    hard_exclude = False

    # Bad/Unqualified are flags from the OLD burst CRM — not necessarily
    # disqualifying for CarterCo ICP. The hand-curated 18-row shortlist
    # included 4 Bad-flagged leads (Dagrofa, Agri-Norcold, Tomrer & VVS,
    # TWO Teknik). Soft-flag them rather than hard-exclude when realness
    # is high enough to suggest the lead is a real DK SMB.
    soft_bad = False
    if flags["Bad"]:
        soft_bad = True
        reasons.append("bad_flag_(legacy_burst_judgment)")
    if flags["Unqualified"]:
        soft_bad = True
        reasons.append("unqualified_flag_(legacy_burst_judgment)")
    if junk_phone(phone):
        reasons.append("junk_phone")

    # generic-domain-as-company hard exclude
    co_low = co.lower()
    if co_low in GENERIC_DOMAINS or (edomain in GENERIC_DOMAINS
                                     and clean_domain(co) == edomain):
        hard_exclude = True
        reasons.append("generic_domain_as_company")

    exclude_hits = pattern_hits(searchable, EXCLUDE_PATTERNS)
    if exclude_hits:
        reasons.append("excluded:" + "|".join(exclude_hits))

    # realness
    realness = 0
    if co:
        realness += 1
    if DK_SUFFIX_RE.search(co):
        realness += 3
        reasons.append("dk_suffix")
    if valid_dk_phone(phone):
        realness += 2
        reasons.append("valid_dk_phone")
    if edomain and edomain not in GENERIC_DOMAINS:
        realness += 2
        reasons.append("business_email_domain")
    if (is_probably_domain(co) and clean_domain(co) not in GENERIC_DOMAINS):
        realness += 1
        reasons.append("company_is_business_domain")
    if norm(row.get("First name")):
        realness += 1
        reasons.append("named_contact")

    # engagement
    engagement = 0
    if flags["Onboarding"]:
        engagement += 5
        reasons.append("onboarding")
    if flags["Converted"]:
        engagement += 4
        reasons.append("converted")
    if flags["Booked meeting"]:
        engagement += 4
        reasons.append("booked_meeting")
    if flags["Snitcher lead"]:
        engagement += 2
        reasons.append("snitcher")
    for f in ["Contacted", "Contacted 2", "Contacted 3", "Contacted 4",
              "Sendt mail", "Sent SMS"]:
        if flags[f]:
            engagement += 1
    if flags["Old lead"]:
        engagement -= 1
        reasons.append("old_lead_penalty")
    if flags["Lost"]:
        engagement -= 2
        reasons.append("lost_penalty")

    # ICP
    icp = 0
    for vertical, pats in VERTICAL_PATTERNS.items():
        hits = pattern_hits(searchable, pats)
        if hits:
            verticals.append(vertical)
            icp += 4 if vertical != "b2b_services_misc" else 2
            reasons.append(f"{vertical}:" + "|".join(hits[:3]))
    if ("b2b_services_misc" in verticals and len(verticals) == 1
            and re.search(r"\bservice\b", searchable, re.I)):
        icp -= 1
        reasons.append("service_alone_penalty")

    total = realness + engagement + icp

    # bucket logic (top-down)
    high_engaged_unknown = (realness >= 4 and engagement >= 4
                            and icp == 0 and not hard_exclude)
    converted_or_onboarded = flags["Converted"] or flags["Onboarding"]
    booked_not_converted = (flags["Booked meeting"]
                            and not flags["Converted"]
                            and not flags["Onboarding"])
    strong_known_icp = realness >= 4 and icp >= 4
    weak_known_icp = realness >= 3 and icp >= 2
    strong_engagement = engagement >= 4
    medium_engagement = engagement >= 3
    # Cold DK SMB: high realness, no real funnel progress, no negative flags,
    # regex didn't recognize vertical. This is the natural "fresh cold lead"
    # lane — without it, untouched-or-barely-touched Dagrofa/Hoei/Zederkof-
    # class rows fall to rejects even though they have A/S suffix + DK phone
    # + named contact. "engagement <= 2" allows one prior SMS/contact attempt
    # but excludes anyone who reached Booked/Converted/Onboarding.
    no_funnel_progress = not (flags["Booked meeting"] or flags["Converted"]
                              or flags["Onboarding"])
    cold_dk_smb = (realness >= 4 and no_funnel_progress and icp == 0
                   and not hard_exclude and not flags["Lost"]
                   and DK_SUFFIX_RE.search(co))

    if hard_exclude:
        bucket = "rejects"
    elif converted_or_onboarded and weak_known_icp:
        bucket = "past_client_known_icp"
    elif converted_or_onboarded and high_engaged_unknown:
        bucket = "needs_llm_review_high_prio"
        reasons.append("vertical_unknown_but_converted")
    elif booked_not_converted and weak_known_icp:
        bucket = "tier_a_reengage"
    elif booked_not_converted and high_engaged_unknown:
        bucket = "needs_llm_review_high_prio"
        reasons.append("vertical_unknown_but_booked")
    elif strong_engagement and weak_known_icp:
        bucket = "tier_a_reengage"
    elif high_engaged_unknown:
        bucket = "needs_llm_review_high_prio"
        reasons.append("vertical_unknown_but_engaged")
    elif strong_known_icp:
        bucket = "tier_b_icp_new"
    elif cold_dk_smb:
        bucket = "cold_dk_smb_llm_review"
        reasons.append("cold_untouched_dk_aps_or_as")
    elif soft_bad and realness >= 6:
        bucket = "needs_llm_review"
        reasons.append("soft_bad_high_realness_override")
    elif realness >= 3 and (icp >= 2 or medium_engagement):
        bucket = "needs_llm_review"
    else:
        bucket = "rejects"

    return {
        **row,
        "mined_company": co,
        "email_domain": edomain,
        "realness_score": realness,
        "engagement_score": engagement,
        "icp_score": icp,
        "total_score": total,
        "verticals": ",".join(sorted(set(verticals))),
        "bucket": bucket,
        "reasons": ";".join(reasons),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--csv", default=str(Path.home() / "Downloads" / "Leads (79).csv"),
                    help="path to Adalo CSV export")
    ap.add_argument("--owner", default="hauge@burstcreators.com",
                    help="Sales Owner email to filter on")
    ap.add_argument("--outdir", default="clients/carterco/data/adalo_mined",
                    help="output directory for bucketed CSVs")
    args = ap.parse_args()

    src = Path(args.csv)
    if not src.exists():
        sys.exit(f"input not found: {src}")

    with src.open(newline="", encoding="utf-8-sig") as f:
        all_rows = list(csv.DictReader(f))

    owner_rows = [r for r in all_rows
                  if (r.get("Sales Owner") or "").strip().lower()
                  == args.owner.lower()]
    print(f"total rows in file: {len(all_rows)}")
    print(f"owner={args.owner!r} rows: {len(owner_rows)}")
    print()

    classified = [classify(r) for r in owner_rows]
    classified.sort(key=lambda r: int(r["total_score"]), reverse=True)

    buckets: dict[str, list[dict]] = {
        "past_client_known_icp": [],
        "tier_a_reengage": [],
        "tier_b_icp_new": [],
        "needs_llm_review_high_prio": [],
        "cold_dk_smb_llm_review": [],
        "needs_llm_review": [],
        "rejects": [],
    }
    for r in classified:
        buckets[r["bucket"]].append(r)

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    if classified:
        fieldnames = list(classified[0].keys())
        for bucket, bucket_rows in buckets.items():
            path = outdir / f"{bucket}.csv"
            with path.open("w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=fieldnames)
                w.writeheader()
                w.writerows(bucket_rows)

    # report
    print("=== BUCKET COUNTS ===")
    for bucket, bucket_rows in buckets.items():
        print(f"  {bucket:30s}  {len(bucket_rows):5d}")
    print()

    vertical_counter: Counter[str] = Counter()
    for r in classified:
        for v in r["verticals"].split(",") if r["verticals"] else []:
            vertical_counter[v] += 1
    print("=== VERTICAL HITS (across all non-rejected) ===")
    for v, n in vertical_counter.most_common():
        print(f"  {v:30s}  {n:5d}")
    print()

    # print top of each non-reject bucket
    for bucket in ("past_client_known_icp", "tier_a_reengage",
                   "tier_b_icp_new", "needs_llm_review_high_prio",
                   "cold_dk_smb_llm_review"):
        rows = buckets[bucket]
        if not rows:
            continue
        print(f"=== {bucket} (top 20 of {len(rows)}) ===")
        for r in rows[:20]:
            co = r["mined_company"][:40]
            name = norm(r.get("First name"))[:25]
            phone = norm(r.get("Phone number"))[:14]
            verts = r["verticals"][:30]
            print(f"  {co:42s} | {name:27s} | {phone:16s} | "
                  f"r={r['realness_score']} e={r['engagement_score']} i={r['icp_score']} | {verts}")
        print()

    print(f"wrote bucket CSVs to {outdir.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
