#!/usr/bin/env python3
"""
Bucket-hook generator — OFFLINE DEMO.

Apify free tier is tapped out ($5/mo), so this runs the Haiku step only, on
REAL posts already pulled during the hit-rate run (2026-06-02). Includes the
three landmine cases (job-search, personal humblebrag, job-change) to show the
floor-up classifier drops them to the role floor instead of referencing them.

Costs only Anthropic (cheap). To run the full live pipeline once Apify is
topped up: scripts/bucket-hooks/generate_hooks.py
"""
from generate_hooks import load_env, detect_target_lang, draft_hook, build_user  # noqa

ENV = load_env()
ANTHROPIC = ENV["ANTHROPIC_API_KEY"]

# (name, title, company, [posts]) — posts = list of (kind, age_days, text) or []
CACHED = [
    ("Thomas Koed", "Head of Sales & Country Manager 🚀 WE>ME", "Nordic Charge",
     [("ORIGINAL", 5, "Hvor skal vi hen – DU? Ingen ville sætte sig ind i et fly uden at vide destinationen. På samme måde skaber ledelse først for alvor værdi, når retningen er tydelig. Som leder ser jeg det som min vigtigste opgave at sætte retningen tydeligt.")]),
    ("Anja Hagen", "Client Executive, Director | Employer of Record in Denmark", "DenConnect",
     [("ORIGINAL", 7, "“Wait… this is mandatory?” A Danish employment contract is not just an English contract with æ, ø and å. We often speak with companies that assume they can just use their standard global template when hiring in Denmark — and then hit the rules the hard way.")]),
    ("Aleksander York Horner", "Consultative sales professional", "MindMind",
     [("ORIGINAL", 60, "Hej kære virksomheder. Jeg driver til daglig Strategien.dk, hvor jeg arbejder med hjemmesider, SEO, Google Ads og speedoptimering. Jeg hjælper virksomheder med at få deres online tilstedeværelse til at performe bedre.")]),
    ("Philippe Robert", "Business Angel — Sonoscanner", "Sonoscanner",
     [("ORIGINAL", 60, "Il y a parfois des symboles que l'on ne remarque qu'après coup. Il y a un an, étaient annoncés les lauréats du Fonds Ukraine parmi lesquels Industrial Park, un projet que nous soutenons.")]),
    # --- LANDMINES: should be dropped, fall to Bucket 3 ---
    ("Klaus Lodberg", "Sales Director & Head of Utility & Energy, Howden Danmark", "Howden",
     [("ORIGINAL", 90, "Kære netværk i og omkring Esbjerg. Jeg er på udkig efter mit næste job og vil derfor gerne bringe mit lokale netværk i spil. Del endelig opslaget, hvis du kender en ejerleder eller virksomhed, der mangler en erfaren sælger.")]),
    ("Lasse Sindahl Ejlersen", "Operating CEO and Head of Sales at Ospra", "Ospra",
     [("ORIGINAL", 90, "Last weekend, I completed the Hammertrail half marathon on Bornholm, often considered one of the more demanding courses in Denmark. The experience served as a practical reminder of how much consistency beats intensity.")]),
    ("Pernille Callesøe Thomsen", "Export Director | Sales Director | Head of Sales", "DRYK",
     [("ORIGINAL", 30, "After five fantastic years at possibly the world's best workplace, #RAWBITE, it's time for me to cycle on to the next adventure. It has been an incredibly exciting challenge to build the export business.")]),
    # --- NO FRESH POSTS: Bucket 3 floor ---
    ("Jesper Holme Kalhave", "Chief Sales Officer (CSO) at GoFact", "GoFact", []),
    ("Lars Qvistgaard", "Executing Sales Director — Solution Selling, CRM-Salesforce, VP of Sales", "IoT Fabrikken", []),
    ("Bo Jakobsen", "Sales and Marketing Director i CA Auto Bank og Drivalia Danmark", "CA Auto Bank", []),
    ("Simon Sheard", "Operations & Development Specialist", "Convifood", []),  # only stale posts -> floor
]


def make_hook(name, title, company, posts):
    # posts here are (kind, age, text) tuples; adapt to the dict shape build_user wants.
    pd = [{"is_repost": k == "REPOST", "age_days": a, "text": t} for (k, a, t) in posts]
    lang = detect_target_lang(pd)
    return draft_hook(build_user(name, title, company, pd, lang))


print("=" * 100)
counts = {}
for name, title, company, posts in CACHED:
    out = make_hook(name, title, company, posts)
    b = str(out.get("bucket", "?"))
    counts[b] = counts.get(b, 0) + 1
    tag = "LANDMINE→floor" if (posts and b == "3") else ""
    print(f"\n● {name}  —  {title[:55]}")
    print(f"  bucket {b}  {tag} | why: {out.get('reasoning','')}")
    print(f"  HOOK: {out.get('hook','')}")
print("\n" + "=" * 100)
print("Bucket mix:", {k: counts[k] for k in sorted(counts)})
