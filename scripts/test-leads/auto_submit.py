#!/usr/bin/env python3
"""Auto-submit contact forms for pending test_submissions.

For each pending company:
  1. Navigate to its website. Try common contact paths
     (/kontakt, /contact, /kontakt-os, ...). If none, scan nav links for
     a "Contact"/"Kontakt" anchor and follow it.
  2. Once on a page with a form, take a screenshot + DOM excerpt and ask
     Claude Sonnet to map the form fields (name/email/phone/message/etc.)
     to CSS selectors and to identify the submit button.
  3. Fill the fields with persona data + the ref code in the message body.
  4. Click submit; wait for navigation / success indicator.
  5. Mark test_submissions.status = 'submitted' (success) or 'failed' (with notes).

Saves a screenshot per attempt under data/screenshots/<refcode>.png.

Usage:
  python3 auto_submit.py [--limit N] [--workers 2] [--headless]
                         [--dry-run]            # don't click submit, just fill
                         [--only-ref RX-XXXX]   # one specific company

Required env:
  PERSONA_FULL_NAME, PERSONA_FIRST_NAME, PERSONA_LAST_NAME,
  PERSONA_GMAIL_ADDRESS, PERSONA_PHONE  (PERSONA_COMPANY is optional)
  ANTHROPIC_API_KEY
  + Supabase service key

Install once:
  pip install playwright anthropic
  playwright install chromium
"""
from __future__ import annotations
import argparse
import base64
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any

from _supabase import select_paged, update


# Common contact-page paths in Danish + English. We try these in order before
# falling back to scanning nav links.
CANDIDATE_PATHS = [
    "/kontakt",
    "/kontakt-os",
    "/kontakt-os/",
    "/contact",
    "/contact-us",
    "/contact/",
    "/contact-us/",
    "/da/kontakt",
    "/en/contact",
    "/en/contact-us",
    "/about/contact",
    "/get-in-touch",
    "/skriv-til-os",
    "/book-mode",
    "/booking",
    "/forespoergsel",
    "/get-quote",
    "/quote",
    "/enquiry",
    "/inquiry",
    "/sales",
    "/sales-contact",
    "/support",
    "/help",
    "/info",
    "/contact-form",
    "/contactform",
]

# Cookie-banner buttons we'll auto-click. Danish + English.
COOKIE_ACCEPT_TEXTS = [
    "accepter alle", "accept all", "accept", "godkend alle", "tillad alle",
    "ok", "i agree", "agree", "got it", "tillad", "accepter",
    "allow all", "fortsæt", "continue", "tillad cookies",
]

SCREENSHOT_DIR = Path("data/screenshots")
SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


# ─── Claude vision helper ────────────────────────────────────────────────

ANTHROPIC_KEY = os.environ.get("ANTHROPIC_API_KEY")
if not ANTHROPIC_KEY:
    sys.exit("ANTHROPIC_API_KEY must be set")

VISION_SYSTEM = """Du analyserer en hjemmesides kontaktformular og returnerer en map af felt-typer til CSS-selectors.

Returnér KUN gyldig JSON i denne form:
{
  "has_form": true,
  "name_selector": "input[name='full_name']",
  "first_name_selector": null,
  "last_name_selector": null,
  "email_selector": "input[type='email']",
  "phone_selector": "input[name='phone']",
  "company_selector": null,
  "subject_selector": null,
  "message_selector": "textarea[name='message']",
  "consent_checkboxes": ["input[name='gdpr']"],
  "submit_selector": "button[type='submit']",
  "other_required_fields": [
    {"selector": "select[name='industry']", "type": "select", "label": "Industry"},
    {"selector": "input[name='vat']", "type": "text", "label": "VAT number"},
    {"selector": "input[name='employees']", "type": "number", "label": "Employees"}
  ],
  "notes": "kort beskrivelse hvis noget er specielt"
}

Regler:
- Brug specifikke selectors (id, name, type, aria-label, placeholder).
- Hvis et felt ikke findes, sæt værdien til null. NULL betyder springes over — fx hvis der ikke er et phone-felt.
- name_selector OG (first_name_selector + last_name_selector): brug name_selector hvis der er ét fuldt-navn-felt; ellers brug first/last hvis felterne er adskilt.
- consent_checkboxes: alle GDPR/marketing-tickbokse der skal sættes for at submission går igennem.
- other_required_fields: ALLE andre påkrævede felter (markeret med * eller "required") som ikke passer til de standard-felter ovenfor. Inkludér:
  • Dropdowns (type "select"): industri, branche, land, henvendelsestype, "Hvor hørte du om os?"
  • Radio buttons (type "radio"): inkludér selector for HELE gruppen, fx 'input[name="inquiry_type"]'
  • Number inputs (type "number"): antal medarbejdere, budget, omsætning
  • Date pickers (type "date"): foretrukket møde-tidspunkt
  • Tekstfelter (type "text"): VAT, CVR, adresse, postnr, by — alt der ikke er navn/email/telefon/firma/besked
  Spring over file-uploads, captchas, og hidden felter.
- has_form: false hvis siden ikke har en kontakformular.
- Returnér KUN JSON, ingen markdown-fences, ingen forklaring."""


def claude_field_map(html_excerpt: str, screenshot_b64: str) -> dict | None:
    import urllib.request as ur
    import urllib.error
    payload = {
        "model": "claude-sonnet-4-6",
        "max_tokens": 800,
        "system": VISION_SYSTEM,
        "messages": [
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/png",
                            "data": screenshot_b64,
                        },
                    },
                    {
                        "type": "text",
                        "text": f"HTML-uddrag (form-relateret):\n{html_excerpt[:6000]}",
                    },
                ],
            }
        ],
    }
    req = ur.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "x-api-key": ANTHROPIC_KEY,
            "anthropic-version": "2023-06-01",
        },
        method="POST",
    )
    try:
        with ur.urlopen(req, timeout=60) as f:
            body = json.loads(f.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Claude API: {e.code}: {e.read().decode()[:300]}")
    blocks = body.get("content") or []
    text = "".join(b.get("text", "") for b in blocks if b.get("type") == "text").strip()
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```\s*$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


# ─── Playwright helpers ──────────────────────────────────────────────────


def try_accept_cookies(page) -> None:
    for txt in COOKIE_ACCEPT_TEXTS:
        try:
            btn = page.get_by_role("button", name=re.compile(txt, re.IGNORECASE)).first
            if btn.is_visible(timeout=500):
                btn.click(timeout=2000)
                page.wait_for_timeout(500)
                return
        except Exception:
            continue
        try:
            link = page.get_by_role("link", name=re.compile(txt, re.IGNORECASE)).first
            if link.is_visible(timeout=300):
                link.click(timeout=2000)
                page.wait_for_timeout(500)
                return
        except Exception:
            continue


def page_has_form(page) -> bool:
    """Cheap heuristic — there's a <form> with a textarea or message field."""
    try:
        return page.evaluate(
            """
            () => {
              const forms = document.querySelectorAll('form');
              for (const f of forms) {
                if (f.querySelector('textarea, input[type="email"]')) return true;
              }
              return false;
            }
            """
        )
    except Exception:
        return False


def navigate_to_contact(page, base: str) -> str | None:
    """Try common paths, then scan nav, then click contact CTAs. Return final URL on success."""
    base = base.rstrip("/")

    def settle_and_check() -> str | None:
        """Wait for JS, check for a form."""
        try_accept_cookies(page)
        try:
            page.wait_for_load_state("networkidle", timeout=4000)
        except Exception:
            pass
        if page_has_form(page):
            return page.url
        return None

    # 1. Landing page
    try:
        page.goto(base, wait_until="domcontentloaded", timeout=20000)
        u = settle_and_check()
        if u: return u
    except Exception:
        pass

    # 2. Common contact paths
    for path in CANDIDATE_PATHS:
        url = base + path
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=15000)
            if resp and resp.status == 200:
                u = settle_and_check()
                if u: return u
        except Exception:
            continue

    # 3. Scan nav anchors with kontakt/contact/skriv/book/sales/quote text
    try:
        page.goto(base, wait_until="domcontentloaded", timeout=15000)
        try_accept_cookies(page)
        hrefs = page.evaluate(
            """
            () => {
              const re = /kontakt|contact|skriv|book|sales|quote|forespørg|samtale|hør\\s+mere|get\\s+started|book\\s+møde/i;
              const links = Array.from(document.querySelectorAll('a[href]'));
              const matches = links.filter(a => re.test(a.textContent || ''));
              return matches.slice(0, 5).map(a => a.href);
            }
            """
        )
        for href in hrefs or []:
            try:
                page.goto(href, wait_until="domcontentloaded", timeout=15000)
                u = settle_and_check()
                if u: return u
            except Exception:
                continue
    except Exception:
        pass

    # 4. Click contact CTA buttons (open modal forms etc.)
    try:
        page.goto(base, wait_until="domcontentloaded", timeout=15000)
        try_accept_cookies(page)
        clicked = page.evaluate(
            """
            () => {
              const re = /kontakt|contact|skriv|book\\s|forespørg|samtale|get\\s+in\\s+touch|hør\\s+mere/i;
              const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
              const hit = candidates.find(el => re.test(el.textContent || '') && el.offsetParent !== null);
              if (hit) { hit.click(); return true; }
              return false;
            }
            """
        )
        if clicked:
            try:
                page.wait_for_load_state("networkidle", timeout=4000)
            except Exception:
                pass
            if page_has_form(page):
                return page.url
    except Exception:
        pass

    return None


PHONE_PATTERN = re.compile(
    r"(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{2,4}[\s.-]?\d{2,4}[\s.-]?\d{0,4}"
)


def normalize_phone(raw: str, default_cc: str = "45") -> str | None:
    """Best-effort E.164 from a free-form phone string."""
    if not raw:
        return None
    digits = re.sub(r"[^\d+]", "", raw)
    if not digits:
        return None
    if digits.startswith("+"):
        return digits if 8 <= len(digits) <= 16 else None
    if digits.startswith("00"):
        cand = "+" + digits[2:]
        return cand if 8 <= len(cand) <= 16 else None
    if default_cc == "45" and len(digits) == 8:
        return "+45" + digits
    if default_cc == "1" and len(digits) == 10:
        return "+1" + digits
    if 8 <= len(digits) <= 13:
        return "+" + default_cc + digits
    return None


def extract_phone(page) -> str | None:
    """Pull a phone number from the page. Prefer tel: anchors, fall back to text."""
    try:
        tel = page.evaluate(
            """
            () => {
              const a = document.querySelector('a[href^="tel:"]');
              return a ? a.getAttribute('href').replace(/^tel:/i, '') : null;
            }
            """
        )
        if tel:
            norm = normalize_phone(tel)
            if norm:
                return norm
    except Exception:
        pass

    try:
        text = page.inner_text("body", timeout=3000)
    except Exception:
        return None
    # Look for "tel:", "telefon:", "phone:" prefixes first (more reliable)
    for m in re.finditer(
        r"(?:telefon|phone|tlf|kontakt)[\s:]*([+\d][\d\s().+-]{6,20})",
        text,
        flags=re.IGNORECASE,
    ):
        cand = normalize_phone(m.group(1))
        if cand:
            return cand
    # Generic phone-shaped pattern, take first plausible
    for m in PHONE_PATTERN.finditer(text):
        candidate = m.group(0)
        digits = re.sub(r"\D", "", candidate)
        if 8 <= len(digits) <= 13:
            return normalize_phone(candidate)
    return None


def get_form_html_excerpt(page) -> str:
    """Pull just the form-relevant HTML to keep prompt size sane."""
    try:
        return page.evaluate(
            """
            () => {
              const forms = Array.from(document.querySelectorAll('form'));
              if (!forms.length) return document.body.innerHTML.slice(0, 6000);
              const target = forms.find(f => f.querySelector('textarea, input[type="email"]')) || forms[0];
              return target.outerHTML.slice(0, 8000);
            }
            """
        )
    except Exception:
        return ""


SUCCESS_BODY_RE = re.compile(
    r"(tak\s+for\s+din\s+henvendelse|tak\s+for\s+din\s+besked|tak\s+for\s+kontakt|"
    r"tak,?\s+vi\s+vender\s+tilbage|din\s+besked\s+er\s+sendt|"
    r"thanks?\s+for|message\s+(has\s+been\s+)?(sent|received)|"
    r"we[''']?ll\s+(get\s+back|be\s+in\s+touch)|vi\s+vender\s+tilbage|"
    r"submitted\s+successfully|form\s+submitted|tak\s+for\s+din\s+forespørgsel|"
    r"successfully\s+sent|beskeden\s+er\s+modtaget|du\s+hører\s+fra\s+os)",
    re.IGNORECASE,
)


def snapshot_form_values(page) -> dict[str, str]:
    """Capture all input/textarea values so we can detect form-clear after submit."""
    try:
        return page.evaluate(
            """
            () => {
              const out = {};
              for (const el of document.querySelectorAll('input, textarea')) {
                const k = el.name || el.id || ''; if (!k) continue;
                if (['submit','button','hidden','checkbox','radio'].includes(el.type)) continue;
                out[k] = el.value || '';
              }
              return out;
            }
            """
        ) or {}
    except Exception:
        return {}


def detect_submission_success(page, before_url: str, before_values: dict[str, str]) -> tuple[bool, str]:
    """After clicking submit, did it look like it worked?"""
    # Wait progressively — some sites take 4-5s to show the thank-you state
    page.wait_for_timeout(3500)
    after_url = page.url

    if after_url != before_url:
        if "thank" in after_url.lower():
            return True, "url contains 'thank'"
        if re.search(r"(success|tak|received|done|sent|complete|submitted)", after_url.lower()):
            return True, f"url changed to {after_url}"

    # Visible body text contains a thank-you phrase
    body = ""
    try:
        body = page.inner_text("body", timeout=3000)
    except Exception:
        pass
    if SUCCESS_BODY_RE.search(body):
        return True, "success text on page"

    # Form fields cleared after submit → site accepted the data and reset the form
    if before_values:
        after_values = snapshot_form_values(page)
        cleared = [k for k, v in before_values.items()
                   if v and not (after_values.get(k) or "")]
        if len(cleared) >= 2:
            return True, f"form cleared {len(cleared)} fields"

    # Generic URL change is a weak but real signal
    if after_url != before_url:
        return True, f"url changed to {after_url}"

    return False, "no clear success signal"


# ─── Persona / message ───────────────────────────────────────────────────


def persona_payload(ref_code: str) -> dict[str, str | None]:
    return {
        "full_name": os.environ.get("PERSONA_FULL_NAME") or "",
        "first_name": os.environ.get("PERSONA_FIRST_NAME") or "",
        "last_name": os.environ.get("PERSONA_LAST_NAME") or "",
        "email": os.environ.get("PERSONA_GMAIL_ADDRESS") or "",
        "phone": os.environ.get("PERSONA_PHONE") or "",
        "company": os.environ.get("PERSONA_COMPANY") or "",
        "subject": "Forespørgsel",
        "message": (
            "Hej,\n\nJeg er ved at undersøge muligheder og kunne godt tænke mig "
            "at høre lidt mere om hvad I kan tilbyde. Kan I ringe tilbage eller "
            "skrive til mig?\n\nMvh\n"
            f"{os.environ.get('PERSONA_FULL_NAME') or ''}\n"
            f"Ref: {ref_code}"
        ),
    }


# ─── Single-submission worker ────────────────────────────────────────────


def fill_other_field(page, sel: str, ftype: str, label: str, payload: dict) -> None:
    """Best-effort fill for fields beyond the standard 7. Silently no-ops on miss."""
    loc = page.locator(sel).first

    if ftype == "select":
        # Pick the first option that isn't a "please choose" placeholder.
        options = page.evaluate(
            """
            (s) => {
              const el = document.querySelector(s);
              if (!el || el.tagName !== 'SELECT') return [];
              return Array.from(el.options).map(o => ({value: o.value, text: o.textContent || ''}));
            }
            """,
            sel,
        ) or []
        BAD = ("vælg", "select", "choose", "please", "—", "-- ", "--", "")
        for o in options:
            txt = (o["text"] or "").strip().lower()
            val = (o["value"] or "").strip()
            if not val:
                continue
            if any(bad in txt for bad in BAD):
                continue
            try:
                loc.select_option(value=val, timeout=2000)
                return
            except Exception:
                continue
        # Fallback: pick the option at index 1 (skip the empty "Choose..." at index 0)
        try:
            loc.select_option(index=1, timeout=2000)
        except Exception:
            pass
        return

    if ftype == "radio":
        # The selector might point at the group; pick the first radio in it.
        try:
            page.locator(sel).first.check(timeout=2000)
        except Exception:
            pass
        return

    if ftype == "number":
        # Sensible defaults by label hint
        val = "1"
        if any(k in label for k in ("budget", "omsætning", "revenue", "spend")):
            val = "10000"
        if any(k in label for k in ("medarbejder", "employee", "staff", "size")):
            val = "10"
        try:
            loc.fill(val, timeout=2000)
        except Exception:
            pass
        return

    if ftype == "date":
        # Today + 7 days, ISO format (works for native HTML5 date inputs)
        from datetime import datetime, timedelta
        d = (datetime.now() + timedelta(days=7)).strftime("%Y-%m-%d")
        try:
            loc.fill(d, timeout=2000)
        except Exception:
            pass
        return

    # text or anything else: stuff the message in (handles VAT/address weakly,
    # but the form goes through with SOME value rather than rejecting).
    if ftype in ("text", "textarea", ""):
        # Use a small relevant string for short-looking fields
        val = payload.get("company") or payload.get("full_name") or "1234567890"
        # If label hints at zip/postcode, use a Danish 4-digit
        if any(k in label for k in ("zip", "postcode", "postnr", "postal")):
            val = "2100"
        elif any(k in label for k in ("city", "by")):
            val = "København"
        elif any(k in label for k in ("vat", "cvr", "tax")):
            val = "12345678"
        elif any(k in label for k in ("address", "adresse", "gade")):
            val = "Testgade 1"
        elif any(k in label for k in ("country", "land")):
            val = "Denmark"
        try:
            loc.fill(val, timeout=2000)
        except Exception:
            pass


def fill_and_submit(page, fmap: dict, payload: dict, dry_run: bool) -> tuple[bool, str]:
    def fill_if(sel: str | None, val: str | None):
        if sel and val:
            try:
                page.locator(sel).first.fill(val, timeout=2500)
            except Exception:
                pass

    if fmap.get("name_selector"):
        fill_if(fmap.get("name_selector"), payload["full_name"])
    else:
        fill_if(fmap.get("first_name_selector"), payload["first_name"])
        fill_if(fmap.get("last_name_selector"), payload["last_name"])

    fill_if(fmap.get("email_selector"), payload["email"])
    fill_if(fmap.get("phone_selector"), payload["phone"])
    fill_if(fmap.get("company_selector"), payload["company"])
    fill_if(fmap.get("subject_selector"), payload["subject"])
    fill_if(fmap.get("message_selector"), payload["message"])

    for sel in fmap.get("consent_checkboxes") or []:
        try:
            page.locator(sel).first.check(timeout=2000)
        except Exception:
            pass

    # Other required fields: dropdowns, radios, numbers, dates, misc text
    for f in fmap.get("other_required_fields") or []:
        sel = f.get("selector")
        ftype = (f.get("type") or "").lower()
        label = (f.get("label") or "").lower()
        if not sel:
            continue
        try:
            fill_other_field(page, sel, ftype, label, payload)
        except Exception:
            pass

    if dry_run:
        return False, "dry-run — fields filled, did not submit"

    submit_sel = fmap.get("submit_selector")
    if not submit_sel:
        return False, "no submit selector"

    before_url = page.url
    before_values = snapshot_form_values(page)

    # Try the locator click first; fall back to JS-dispatched click if hidden
    submit = page.locator(submit_sel).first
    try:
        submit.scroll_into_view_if_needed(timeout=2000)
    except Exception:
        pass
    try:
        submit.click(timeout=5000)
    except Exception:
        # Force click via JS (bypasses overlay-blocking)
        try:
            page.evaluate(
                "(sel) => { const el = document.querySelector(sel); if (el) el.click(); }",
                submit_sel,
            )
        except Exception as e:
            return False, f"submit click failed (incl. JS fallback): {e}"

    return detect_submission_success(page, before_url, before_values)


def process_one(playwright_ctx, sub: dict, dry_run: bool) -> dict:
    rc = sub["ref_code"]
    website = sub.get("website")
    if not website:
        return {"ok": False, "reason": "no website"}

    page = playwright_ctx.new_page()
    page.set_default_timeout(15000)
    out: dict[str, Any] = {"ok": False, "reason": ""}
    try:
        url = navigate_to_contact(page, website)
        if not url:
            out["reason"] = "no contact form found"
            return out

        # Grab the company's phone for caller-ID attribution on Twilio replies.
        phone = extract_phone(page)
        if phone:
            out["company_phone"] = phone

        # Vision pass
        screenshot_path = SCREENSHOT_DIR / f"{rc}.png"
        page.screenshot(path=str(screenshot_path), full_page=False)
        with open(screenshot_path, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode()
        html = get_form_html_excerpt(page)
        try:
            fmap = claude_field_map(html, img_b64)
        except Exception as e:
            out["reason"] = f"claude error: {e}"
            return out
        if not fmap or not fmap.get("has_form"):
            out["reason"] = "claude: no form detected"
            return out

        ok, reason = fill_and_submit(page, fmap, persona_payload(rc), dry_run)
        out["ok"] = ok
        out["reason"] = reason
        out["contact_url"] = url
        out["screenshot"] = str(screenshot_path)
        # Final screenshot to capture the success/failure state
        try:
            page.screenshot(path=str(SCREENSHOT_DIR / f"{rc}_after.png"), full_page=False)
        except Exception:
            pass
        return out
    except Exception as e:
        out["reason"] = f"unhandled: {e}"
        return out
    finally:
        try:
            page.close()
        except Exception:
            pass


# ─── Driver ──────────────────────────────────────────────────────────────


def write_back(sub: dict, result: dict) -> None:
    success = result.get("ok")
    patch: dict[str, Any] = {
        "status": "submitted" if success else "failed",
        "submitted_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()) if success else None,
        "submitted_by": "auto",
        "notes": (result.get("reason") or "")
                 + (f" · {result.get('contact_url','')}" if result.get("contact_url") else ""),
        "contact_url": result.get("contact_url"),
        "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime()),
    }
    if result.get("company_phone"):
        patch["phone"] = result["company_phone"]
    where = "id=eq." + sub["id"]
    try:
        update("test_submissions", where, patch)
    except RuntimeError:
        # Retry without optional fields if a column isn't present on this env
        patch.pop("contact_url", None)
        update("test_submissions", where, patch)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=20)
    ap.add_argument("--workers", type=int, default=2,
                    help="Browser contexts in parallel (don't go above 4)")
    ap.add_argument("--headless", action="store_true",
                    help="Run headless (lower success rate vs. real Chromium UI)")
    ap.add_argument("--dry-run", action="store_true",
                    help="Fill fields but don't click submit")
    ap.add_argument("--only-ref", type=str, default=None,
                    help="Only process one specific ref_code (debug)")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("Playwright not installed. Run:\n"
                 "  pip install playwright\n"
                 "  playwright install chromium")

    if args.only_ref:
        from _supabase import select as _select
        pending = _select(
            "test_submissions",
            f"ref_code=eq.{args.only_ref}&select=*",
        )
    else:
        q = "status=eq.pending&website=not.is.null&select=*&order=inserted_at.asc"
        if args.limit:
            # Plain select respects query-level limit (paged ignores it)
            from _supabase import select as _select
            pending = _select("test_submissions", f"{q}&limit={args.limit}")
        else:
            pending = select_paged("test_submissions", q)

    print(f"Pending: {len(pending)}", file=sys.stderr)
    if not pending:
        return

    success = fail = 0
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=args.headless,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            for i, sub in enumerate(pending, 1):
                print(f"\n[{i}/{len(pending)}] {sub.get('company') or '?'}  ({sub['ref_code']})", file=sys.stderr)
                ctx = browser.new_context(
                    user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                               "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                    locale="da-DK",
                    viewport={"width": 1280, "height": 900},
                )
                try:
                    res = process_one(ctx, sub, args.dry_run)
                finally:
                    ctx.close()
                mark = "✓" if res.get("ok") else "✗"
                print(f"  {mark} {res.get('reason')}", file=sys.stderr)
                if not args.dry_run:
                    write_back(sub, res)
                if res.get("ok"):
                    success += 1
                else:
                    fail += 1
        finally:
            browser.close()

    print(f"\nDone. {success} submitted, {fail} failed.", file=sys.stderr)


if __name__ == "__main__":
    main()
