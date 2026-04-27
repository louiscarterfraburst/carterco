#!/usr/bin/env python3
"""Audit master_sendable.csv for outreach readiness.

This is intentionally conservative: it flags rows for human review rather than
rewriting lead data. The checks focus on first-name hygiene, website/company
fit, and whether the current title is a plausible website-consultancy buyer.
"""
import argparse
import csv
import difflib
import re
from urllib.parse import urlparse


TARGET_TITLE = re.compile(
    r"\b("
    r"marketing|communications?|kommunikation|kommunikations|"
    r"information technology|it[- ]?(chef|manager|director|lead|head)|"
    r"digital|platform|fundraising|web(site)?|"
    r"web development|digital product|user experience|ux|"
    r"cmo|cio|cto|chief marketing officer|chief information officer"
    r")\b",
    re.IGNORECASE,
)

DECISION_LEVEL = re.compile(
    r"\b("
    r"director|manager|head|chef|lead|leder|ansvarlig|owner|founder|"
    r"partner|chief|cmo|cio|cto"
    r")\b",
    re.IGNORECASE,
)

NON_TARGET_TITLE = re.compile(
    r"\b("
    r"student|studerende|intern|praktikant|retired|pensioneret|"
    r"sales|salg|account manager|business development|"
    r"finance|økonomi|hr|human resources|recruit|"
    r"teacher|professor|researcher|developer|engineer|architect|"
    r"consultant|freelance|self.?employed|selvst"
    r")\b",
    re.IGNORECASE,
)

TITLE_IN_NAME = re.compile(
    r"\b("
    r"marketing|manager|director|head|kommunikation|digital|web|"
    r"consultant|founder|owner|chef|leder|it"
    r")\b",
    re.IGNORECASE,
)

LEGAL_SUFFIXES = {
    "a", "s", "as", "a/s", "aps", "ivs", "is", "i/s", "amba", "am",
    "fmba", "fonden", "fond", "foundation", "group", "holding", "danmark",
    "denmark", "dk", "ab", "ltd", "inc", "co", "company", "the",
}

GENERIC_DOMAINS = {
    "linkedin.com", "facebook.com", "instagram.com", "x.com", "twitter.com",
    "youtube.com", "gmail.com", "hotmail.com", "outlook.com", "yahoo.com",
    "wixsite.com", "wordpress.com", "sites.google.com",
}


def clean_token(value):
    return re.sub(r"[^a-z0-9æøå]+", "", value.lower())


def company_tokens(company):
    parts = re.split(r"[^A-Za-z0-9ÆØÅæøå]+", company.lower())
    return [clean_token(p) for p in parts if clean_token(p) and clean_token(p) not in LEGAL_SUFFIXES]


def host_for(url):
    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = parsed.netloc.lower().split("@")[-1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def registrable_ish(host):
    if not host:
        return ""
    parts = host.split(".")
    if len(parts) >= 3 and parts[-2] in {"co", "com", "org", "net"}:
        return parts[-3]
    return parts[-2] if len(parts) >= 2 else parts[0]


def name_flags(row):
    flags = []
    first = (row.get("firstName") or "").strip()
    last = (row.get("lastName") or "").strip()
    full = (row.get("fullName") or "").strip()
    if not first:
        flags.append("missing_first_name")
    if len(first) > 24:
        flags.append("long_first_name")
    if len(first.split()) > 1:
        flags.append("multi_word_first_name")
    if re.search(r"https?://|www\.|@", first, re.I):
        flags.append("url_or_email_in_first_name")
    if re.search(r"\d", first):
        flags.append("digit_in_first_name")
    if TITLE_IN_NAME.search(first) or TITLE_IN_NAME.search(last):
        flags.append("title_words_in_name")
    if first and first.upper() == first and len(first) > 2:
        flags.append("all_caps_first_name")
    if full and first and not full.lower().startswith(first.lower()):
        flags.append("full_name_does_not_start_with_first_name")
    return flags


def website_flags(row):
    flags = []
    company = (row.get("company") or "").strip()
    website = (row.get("website") or "").strip()
    host = host_for(website)
    domain = registrable_ish(host)
    tokens = company_tokens(company)
    if not website:
        flags.append("missing_website")
        return flags, host, 0.0
    if not host or "." not in host:
        flags.append("malformed_website")
    if host in GENERIC_DOMAINS or any(host.endswith("." + d) for d in GENERIC_DOMAINS):
        flags.append("generic_or_social_website")
    if "linkedin.com" in host:
        flags.append("linkedin_as_website")
    if company and domain:
        token_match = any(t and (t in domain or domain in t) for t in tokens)
        best = max((difflib.SequenceMatcher(None, domain, t).ratio() for t in tokens), default=0.0)
        if not token_match and best < 0.58:
            flags.append("company_domain_low_similarity")
        return flags, host, best
    return flags, host, 0.0


def title_status(title):
    t = (title or "").strip()
    if not t or t in {"-", "--", "."}:
        return "review_blank_title"
    target = bool(TARGET_TITLE.search(t))
    senior = bool(DECISION_LEVEL.search(t))
    non_target = bool(NON_TARGET_TITLE.search(t))
    if target and senior and not non_target:
        return "target_role"
    if target and not non_target:
        return "target_keyword_but_seniority_unclear"
    if senior and not non_target:
        return "senior_but_not_listed_role"
    return "review_non_target_title"


def extract_title_company(title):
    t = (title or "").strip()
    patterns = [
        r"@([^|,;]+)",
        r"\bat\s+([A-ZÆØÅ0-9\"'][^|,;]+)",
        r"\bhos\s+([A-ZÆØÅ0-9\"'][^|,;]+)",
        r"\bved\s+([A-ZÆØÅ0-9\"'][^|,;]+)",
    ]
    for pattern in patterns:
        m = re.search(pattern, t, re.IGNORECASE)
        if m:
            value = m.group(1).strip(" .:-")
            value = re.split(r"\s+-\s+|\s+\|\s+|\s+/\s+", value)[0].strip()
            if value and len(value) <= 80:
                return value
    return ""


def company_similarity(a, b):
    a_tokens = company_tokens(a)
    b_tokens = company_tokens(b)
    if not a_tokens or not b_tokens:
        return 0.0
    scores = []
    for left in a_tokens:
        for right in b_tokens:
            if left in right or right in left:
                scores.append(1.0)
            else:
                scores.append(difflib.SequenceMatcher(None, left, right).ratio())
    return max(scores, default=0.0)


def contact_flags(row):
    flags = []
    title = (row.get("title") or "").strip()
    company = (row.get("company") or "").strip()
    explicit_company = extract_title_company(title)
    if explicit_company and company_similarity(company, explicit_company) < 0.58:
        flags.append(f"title_company_mismatch:{explicit_company}")
    if len(title) > 140 or title.count("|") >= 3:
        flags.append("headline_not_clean_current_title")
    return flags


def severity(name_issues, website_issues, contact_issues, status):
    high = {
        "missing_first_name", "url_or_email_in_first_name", "title_words_in_name",
        "missing_website", "malformed_website", "generic_or_social_website",
        "linkedin_as_website",
    }
    if any(i in high for i in name_issues + website_issues):
        return "high"
    if any(i.startswith("title_company_mismatch:") for i in contact_issues):
        return "high"
    if status in {"review_blank_title", "review_non_target_title"}:
        return "high"
    if contact_issues:
        return "medium"
    if website_issues or name_issues or status != "target_role":
        return "medium"
    return "ok"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="in_csv", default="data/master_sendable.csv")
    ap.add_argument("--audit-out", default="data/master_sendable_audit.csv")
    ap.add_argument("--review-out", default="data/master_sendable_manual_review.csv")
    ap.add_argument("--errors-out", default="data/master_sendable_probable_data_errors.csv")
    ap.add_argument("--strict-out", default="data/master_sendable_target_roles.csv")
    args = ap.parse_args()

    with open(args.in_csv, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
        fieldnames = list(rows[0].keys()) if rows else []

    audit_fields = fieldnames + [
        "audit_severity", "role_status", "name_issues", "website_issues",
        "contact_issues", "website_host", "company_domain_similarity",
    ]
    audited = []
    for row in rows:
        n = name_flags(row)
        w, host, sim = website_flags(row)
        c = contact_flags(row)
        status = title_status(row.get("title", ""))
        out = dict(row)
        out.update({
            "audit_severity": severity(n, w, c, status),
            "role_status": status,
            "name_issues": ";".join(n),
            "website_issues": ";".join(w),
            "contact_issues": ";".join(c),
            "website_host": host,
            "company_domain_similarity": f"{sim:.2f}",
        })
        audited.append(out)

    with open(args.audit_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=audit_fields)
        w.writeheader()
        w.writerows(audited)

    review = [r for r in audited if r["audit_severity"] != "ok"]
    with open(args.review_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=audit_fields)
        w.writeheader()
        w.writerows(review)

    probable_errors = [
        r for r in audited
        if r["name_issues"]
        or r["website_issues"]
        or any(i.startswith("title_company_mismatch:") for i in r["contact_issues"].split(";"))
    ]
    with open(args.errors_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=audit_fields)
        w.writeheader()
        w.writerows(probable_errors)

    strict = [
        r for r in audited
        if r["audit_severity"] == "ok" and r["role_status"] == "target_role"
    ]
    with open(args.strict_out, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows([{k: r[k] for k in fieldnames} for r in strict])

    print(f"Input rows: {len(rows)}")
    print(f"OK target-role rows: {len(strict)}")
    print(f"Manual review rows: {len(review)}")
    print(f"Probable data-error rows: {len(probable_errors)}")
    print(f"Audit: {args.audit_out}")
    print(f"Review: {args.review_out}")
    print(f"Probable data errors: {args.errors_out}")
    print(f"Strict target roles: {args.strict_out}")


if __name__ == "__main__":
    main()
