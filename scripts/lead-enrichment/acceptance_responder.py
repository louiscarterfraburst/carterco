#!/usr/bin/env python3
"""Watch webhook.site for SendPilot connection.accepted events, render a
personalized SendSpark video for each accepted lead, and send it as a
LinkedIn message via SendPilot's /v1/inbox/send.

Designed to run as a long-lived process. Resumable via JSONL logs.

Setup:
  1. In SendPilot UI → Integrations → Webhooks → Add Webhook
       URL: https://webhook.site/<YOUR-TOKEN>
       Events: connection.accepted (at minimum)
  2. SendSpark webhook (already configured) also points at webhook.site —
     this script handles both event types via eventType dispatch.
  3. Start a SendPilot campaign so connection requests go out.
  4. Run this script — it polls every 15s and processes events.

Env vars:
  SENDPILOT_API_KEY
  SENDSPARK_API_KEY, SENDSPARK_API_SECRET, SENDSPARK_WORKSPACE, SENDSPARK_DYNAMIC
  WEBHOOK_SITE_TOKEN
  MESSAGE_TEMPLATE_PATH (optional, default: data/message_template.txt)
"""
import argparse
import csv
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SENDPILOT_KEY = os.environ.get("SENDPILOT_API_KEY") or sys.exit("SENDPILOT_API_KEY not set")
SS_KEY = os.environ.get("SENDSPARK_API_KEY") or sys.exit("SENDSPARK_API_KEY not set")
SS_SECRET = os.environ.get("SENDSPARK_API_SECRET") or sys.exit("SENDSPARK_API_SECRET not set")
SS_WS = os.environ.get("SENDSPARK_WORKSPACE") or sys.exit("SENDSPARK_WORKSPACE not set")
SS_DYN = os.environ.get("SENDSPARK_DYNAMIC") or sys.exit("SENDSPARK_DYNAMIC not set")
WH_TOKEN = os.environ.get("WEBHOOK_SITE_TOKEN") or sys.exit("WEBHOOK_SITE_TOKEN not set")

SP_BASE = "https://api.sendpilot.ai/v1"
SS_BASE = "https://api-gw.sendspark.com/v1"
WH_BASE = f"https://webhook.site/token/{WH_TOKEN}"

SYNTH_EMAIL_BASE = os.environ.get("SYNTH_EMAIL_BASE", "haugefrom+li-{tag}@haugefrom.com")
DEFAULT_TEMPLATE = (
    "Hej {firstName},\n\n"
    "Tak for accept! Lavede en kort hilsen til dig:\n{videoLink}\n\n"
    "Spørg løs hvis det er relevant for jer hos {company}.\n\n"
    "/Louis"
)


def http(url, method="GET", payload=None, headers=None, timeout=30):
    data = json.dumps(payload).encode() if payload else None
    h = {"Content-Type": "application/json"}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as f:
            return f.status, f.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def synth_email(linkedin_url):
    import hashlib
    slug = (urllib.parse.urlparse(linkedin_url).path or "").rstrip("/").split("/")[-1]
    slug = re.sub(r"[^a-z0-9-]+", "-", slug.lower())[:30] or "lead"
    h = hashlib.sha1(linkedin_url.encode()).hexdigest()[:6]
    return SYNTH_EMAIL_BASE.format(tag=f"{slug}-{h}")


def webhook_drain():
    code, body = http(f"{WH_BASE}/requests?sorting=oldest&per_page=100",
                      headers={"Accept": "application/json"})
    if code != 200:
        return []
    out = []
    for r in json.loads(body).get("data", []):
        try:
            out.append({
                "uuid": r["uuid"],
                "ts": r.get("created_at"),
                "body": json.loads(r.get("content") or "{}"),
            })
        except Exception:
            continue
    return out


def webhook_delete(uuid):
    http(f"{WH_BASE}/request/{uuid}", "DELETE")


def render_prospect(lead):
    """POST a SendSpark prospect, return the synthesized email (used as
    correlation key for the upcoming video_generated_dv webhook)."""
    email = synth_email(lead["linkedinUrl"])
    payload = {
        "processAndAuthorizeCharge": True,
        "prospect": {
            "contactName": (lead.get("firstName") or "").strip(),
            "contactEmail": email,
            "company": (lead.get("company") or "")[:80],
            "jobTitle": (lead.get("title") or "")[:120],
            "backgroundUrl": lead.get("website") or "",
        },
    }
    code, body = http(
        f"{SS_BASE}/workspaces/{SS_WS}/dynamics/{SS_DYN}/prospect",
        "POST", payload,
        {"x-api-key": SS_KEY, "x-api-secret": SS_SECRET},
    )
    if code != 200:
        return None, code, body[:200]
    return email, code, body


def send_linkedin_message(lead_id, message):
    code, body = http(
        f"{SP_BASE}/inbox/send", "POST",
        {"leadId": lead_id, "message": message},
        {"X-API-Key": SENDPILOT_KEY},
    )
    return code, body


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--leads-csv", required=True,
                    help="master_sendable_*.csv — used to look up firstName/company by linkedinUrl")
    ap.add_argument("--template", default=os.environ.get("MESSAGE_TEMPLATE_PATH", "data/message_template.txt"),
                    help="text file with {firstName}, {company}, {videoLink} placeholders")
    ap.add_argument("--accepted-log", default="data/accepted.jsonl")
    ap.add_argument("--responded-log", default="data/responded.jsonl")
    ap.add_argument("--rendered-log", default="data/sendspark_rendered.jsonl")
    ap.add_argument("--sent-log", default="data/connection_sent.jsonl",
                    help="leads where SendPilot sent a cold connection request")
    ap.add_argument("--pending-log", default="data/pending_approvals.jsonl",
                    help="leads pending human approval (already-connected on accept)")
    ap.add_argument("--pending-csv", default="data/pending_approvals.csv",
                    help="human-readable approval queue exported from --pending-log")
    ap.add_argument("--poll-every", type=float, default=15.0)
    ap.add_argument("--dry-run", action="store_true",
                    help="print the message instead of POSTing to /inbox/send")
    ap.add_argument("--once", action="store_true",
                    help="run one polling pass then exit")
    args = ap.parse_args()

    if os.path.exists(args.template):
        template = open(args.template).read()
    else:
        template = DEFAULT_TEMPLATE
        print(f"(no template at {args.template}, using built-in default)")

    def li_slug(url):
        """Last non-empty path segment, lowercased — robust to country
        subdomain (dk./www./etc.) and trailing slashes."""
        path = (urllib.parse.urlparse(url or "").path or "").rstrip("/")
        return path.rsplit("/", 1)[-1].lower()

    # Build linkedinUrl + slug → lead lookup
    leads_by_url = {}
    leads_by_slug = {}
    for r in csv.DictReader(open(args.leads_csv)):
        leads_by_url[r["linkedinUrl"]] = r
        s = li_slug(r["linkedinUrl"])
        if s:
            leads_by_slug.setdefault(s, r)
    print(f"loaded {len(leads_by_url)} leads from {args.leads_csv}  ({len(leads_by_slug)} unique slugs)")

    def find_lead(url):
        return leads_by_url.get(url) or leads_by_slug.get(li_slug(url))

    accepted = {a["linkedinUrl"]: a for a in load_jsonl(args.accepted_log)}
    rendered = {r["contactEmail"]: r for r in load_jsonl(args.rendered_log)}
    responded = {r["leadId"]: r for r in load_jsonl(args.responded_log)}
    sent_log = load_jsonl(args.sent_log)
    sent_lead_ids = {s["leadId"] for s in sent_log}
    pending = {p["leadId"]: p for p in load_jsonl(args.pending_log)}
    print(f"state: {len(accepted)} accepted, {len(rendered)} rendered, "
          f"{len(responded)} responded, {len(sent_lead_ids)} cold-requests-sent, "
          f"{len(pending)} pending-approval")

    os.makedirs(os.path.dirname(args.accepted_log) or ".", exist_ok=True)
    af = open(args.accepted_log, "a")
    rf = open(args.rendered_log, "a")
    rsf = open(args.responded_log, "a")
    sf = open(args.sent_log, "a")
    pf = open(args.pending_log, "a")

    while True:
        events = webhook_drain()
        for evt in events:
            body = evt["body"]
            etype = body.get("eventType")
            uuid = evt["uuid"]

            # --- SendPilot connection.sent --- (used to gate already-connected leads)
            if etype == "connection.sent":
                d = body.get("data", {})
                lid = d.get("leadId", "").strip()
                if lid and lid not in sent_lead_ids:
                    sf.write(json.dumps({"leadId": lid, "linkedinUrl": d.get("linkedinUrl"), "ts": time.time()}, ensure_ascii=False) + "\n"); sf.flush()
                    sent_lead_ids.add(lid)
                webhook_delete(uuid); continue

            # --- SendPilot connection.accepted ---
            if etype == "connection.accepted":
                d = body.get("data", {})
                lurl = d.get("linkedinUrl", "").strip()
                lead_id = d.get("leadId", "").strip()
                if not lurl or not lead_id:
                    print(f"  skip: connection.accepted missing linkedinUrl/leadId  uuid={uuid}")
                    webhook_delete(uuid); continue
                if lurl in accepted:
                    webhook_delete(uuid); continue
                # Trigger SendSpark render
                lead = find_lead(lurl)
                if not lead:
                    print(f"  ✗ ACCEPT  {lurl}  — linkedinUrl not in CSV; skipping render")
                    webhook_delete(uuid); continue
                email, code, _ = render_prospect(lead)
                if not email:
                    print(f"  ✗ ACCEPT  {lurl}  — SendSpark POST failed: {code}")
                    webhook_delete(uuid); continue
                cold = lead_id in sent_lead_ids
                acc = {
                    "linkedinUrl": lurl,
                    "csvLinkedinUrl": lead["linkedinUrl"],
                    "contactEmail": email,
                    "leadId": lead_id,
                    "campaignId": d.get("campaignId"),
                    "cold": cold,
                    "ts": time.time(),
                }
                af.write(json.dumps(acc, ensure_ascii=False) + "\n"); af.flush()
                accepted[lurl] = acc
                tag = "COLD-ACCEPT" if cold else "ALREADY-CONNECTED"
                print(f"  ✓ {tag}  {lead['firstName']} {lead.get('lastName','')} @ {lead.get('company','')}  email={email}")
                webhook_delete(uuid); continue

            # --- SendSpark video_generated_dv ---
            if etype == "video_generated_dv":
                email = body.get("contactEmail", "")
                video_link = body.get("videoLink", "")
                if not email or not video_link:
                    webhook_delete(uuid); continue
                if email not in rendered:
                    rec = {"contactEmail": email, "videoLink": video_link, "ts": time.time()}
                    rf.write(json.dumps(rec, ensure_ascii=False) + "\n"); rf.flush()
                    rendered[email] = rec
                else:
                    # Refresh latest videoLink for this email
                    rendered[email]["videoLink"] = video_link
                print(f"  ✓ RENDER  {email}  →  {video_link}")
                # Find which accepted lead this corresponds to (match by stored contactEmail)
                acc = next((a for a in accepted.values() if a.get("contactEmail") == email), None)
                if not acc:
                    print(f"    no matching ACCEPT for {email} (rendered ahead of accept? leftover from test?)")
                    webhook_delete(uuid); continue
                if acc["leadId"] in responded:
                    print(f"    already responded to leadId={acc['leadId']} — skipping")
                    webhook_delete(uuid); continue
                lead = find_lead(acc["linkedinUrl"]) or {}
                msg = template.format(
                    firstName=lead.get("firstName", "there"),
                    company=lead.get("company", ""),
                    videoLink=video_link,
                )
                # Route based on lead type
                if not acc.get("cold", True):
                    # Already-connected → queue for approval, do NOT auto-send
                    pending_rec = {
                        "leadId": acc["leadId"],
                        "linkedinUrl": acc["linkedinUrl"],
                        "firstName": lead.get("firstName"),
                        "lastName": lead.get("lastName"),
                        "company": lead.get("company"),
                        "videoLink": video_link,
                        "message": msg,
                        "queuedAt": time.time(),
                    }
                    pf.write(json.dumps(pending_rec, ensure_ascii=False) + "\n"); pf.flush()
                    pending[acc["leadId"]] = pending_rec
                    # Also append to human-readable CSV
                    new_csv = not os.path.exists(args.pending_csv)
                    with open(args.pending_csv, "a", newline="") as cf:
                        w = csv.writer(cf)
                        if new_csv:
                            w.writerow(["approved","leadId","firstName","lastName","company","videoLink","message","linkedinUrl","queuedAt"])
                        w.writerow(["", acc["leadId"], lead.get("firstName",""), lead.get("lastName",""),
                                    lead.get("company",""), video_link, msg, acc["linkedinUrl"],
                                    time.strftime("%Y-%m-%d %H:%M", time.localtime(pending_rec["queuedAt"]))])
                    print(f"    ⏸  ALREADY-CONNECTED → queued for approval (data/pending_approvals.csv)")
                    webhook_delete(uuid); continue
                if args.dry_run:
                    print(f"    DRY RUN — would POST to /inbox/send leadId={acc['leadId']}:\n{msg}\n")
                    code, body_resp = 200, '{"dryRun":true}'
                else:
                    code, body_resp = send_linkedin_message(acc["leadId"], msg)
                rsp = {"leadId": acc["leadId"], "linkedinUrl": acc["linkedinUrl"],
                       "videoLink": video_link, "status": code,
                       "response": body_resp[:300], "ts": time.time()}
                rsf.write(json.dumps(rsp, ensure_ascii=False) + "\n"); rsf.flush()
                responded[acc["leadId"]] = rsp
                print(f"    /inbox/send → {code}")
                webhook_delete(uuid); continue

            # --- Other events (heartbeat, video.played, etc.) — ignore + clean up ---
            webhook_delete(uuid)

        if args.once:
            break
        time.sleep(args.poll_every)


if __name__ == "__main__":
    main()
