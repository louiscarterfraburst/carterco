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
    "/contact",
    "/contact-us",
    "/contact/",
    "/da/kontakt",
    "/en/contact",
    "/about/contact",
    "/get-in-touch",
    "/skriv-til-os",
    "/book-mode",
    "/forespoergsel",
    "/get-quote",
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
  "notes": "kort beskrivelse hvis noget er specielt"
}

Regler:
- Brug specifikke selectors (id, name, type, aria-label, placeholder).
- Hvis et felt ikke findes, sæt værdien til null. NULL betyder springes over — fx hvis der ikke er et phone-felt.
- name_selector OG (first_name_selector + last_name_selector): brug name_selector hvis der er ét fuldt-navn-felt; ellers brug first/last hvis felterne er adskilt.
- consent_checkboxes: alle GDPR/marketing-tickbokse der skal sættes for at submission går igennem.
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
    """Try common paths, then scan nav. Return final URL on success."""
    base = base.rstrip("/")
    # Check landing page itself first
    try:
        page.goto(base, wait_until="domcontentloaded", timeout=20000)
        try_accept_cookies(page)
        if page_has_form(page):
            return page.url
    except Exception:
        pass

    # Common contact paths
    for path in CANDIDATE_PATHS:
        url = base + path
        try:
            resp = page.goto(url, wait_until="domcontentloaded", timeout=15000)
            if resp and resp.status == 200:
                try_accept_cookies(page)
                if page_has_form(page):
                    return page.url
        except Exception:
            continue

    # Scan nav links for "kontakt"/"contact"
    try:
        page.goto(base, wait_until="domcontentloaded", timeout=15000)
        try_accept_cookies(page)
        href = page.evaluate(
            """
            () => {
              const links = Array.from(document.querySelectorAll('a[href]'));
              const hit = links.find(a => /kontakt|contact|skriv|book/i.test(a.textContent || ''));
              return hit ? hit.href : null;
            }
            """
        )
        if href:
            page.goto(href, wait_until="domcontentloaded", timeout=15000)
            try_accept_cookies(page)
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


def detect_submission_success(page, before_url: str) -> tuple[bool, str]:
    """After clicking submit, did it look like it worked?"""
    page.wait_for_timeout(2500)
    after_url = page.url
    if after_url != before_url and "thank" in after_url.lower():
        return True, "url contains 'thank'"
    if after_url != before_url and re.search(r"(success|tak|received|done|sent)", after_url.lower()):
        return True, f"url changed to {after_url}"
    body = ""
    try:
        body = page.inner_text("body", timeout=3000)
    except Exception:
        pass
    if re.search(r"(tak for din henvendelse|thanks?\s+for|tak.*beskeden|message (has been )?sent|we'?ll get back|vi vender tilbage)",
                 body, re.IGNORECASE):
        return True, "success text on page"
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

    if dry_run:
        return False, "dry-run — fields filled, did not submit"

    submit_sel = fmap.get("submit_selector")
    if not submit_sel:
        return False, "no submit selector"

    before_url = page.url
    try:
        page.locator(submit_sel).first.click(timeout=5000)
    except Exception as e:
        return False, f"submit click failed: {e}"

    return detect_submission_success(page, before_url)


def process_one(playwright_ctx, sub: dict, dry_run: bool) -> dict:
    rc = sub["ref_code"]
    website = sub.get("website")
    if not website:
        return {"ok": False, "reason": "no website"}

    browser = playwright_ctx
    page = browser.new_page(viewport={"width": 1280, "height": 1600})
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
        pending = select_paged(
            "test_submissions",
            f"ref_code=eq.{args.only_ref}&select=*",
        )
    else:
        q = "status=eq.pending&website=not.is.null&select=*&order=inserted_at.asc&limit="
        q += str(args.limit if args.limit else 10000)
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
