#!/usr/bin/env node
// Uploads creative images, creates the Meta lead form, and creates 3 paused ads
// under the existing MAVICO ad set 120248410702800782 (Carter & Co — DK B2B broad).
//
// Reads META_ACCESS_TOKEN from .env.local. Idempotent — a manifest at
// .meta-upload-manifest.json (gitignored) stores hashes / form id / ad ids so
// re-runs skip work already done.
//
// Usage: node scripts/meta/upload_carterco_leadgen.mjs
//
// To wipe and start over: rm .meta-upload-manifest.json

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const ASSETS = path.join(ROOT, "clients/carterco/assets/fb-ads-raw");
const MANIFEST_PATH = path.join(ROOT, ".meta-upload-manifest.json");

const GRAPH = "https://graph.facebook.com/v21.0";
const AD_ACCOUNT_ID = "882167586766471";
const PAGE_ID = "1138136299380303";
const AD_SET_ID = "120248410702800782";

// 3 ads, Caption A ("AI-process") only — one per photo, all 4 ratios per ad.
const ADS = [
  {
    key: "coffee",
    name: "Carter & Co — Coffee (Caption A)",
    images: { "4x5": "4x5/1.jpg", "9x16": "9x16/1.jpg", "16x9": "16x9/1.jpg", "1x1": "1x1/1.jpg" },
  },
  {
    key: "beer",
    name: "Carter & Co — Beer (Caption A)",
    images: { "4x5": "4x5/3.jpg", "9x16": "9x16/3.jpg", "16x9": "16x9/3.jpg", "1x1": "1x1/2.jpg" },
  },
  {
    key: "sunset",
    name: "Carter & Co — Sunset (Caption A)",
    images: { "4x5": "4x5/5.jpg", "9x16": "9x16/5.jpg", "16x9": "16x9/5.jpg", "1x1": "1x1/3.jpg" },
  },
];

const AD_COPY = {
  primary_text: "Hvis I allerede får B2B-leads, er spørgsmålet ikke flere leads — det er om I får nok møder ud af dem.\n\nDe fleste falder, fordi ingen følger op hurtigt nok, eller fordi opfølgningen sker i hånden på tværs af email, SMS og LinkedIn.\n\nJeg bygger systemet, der fanger jeres leads med det samme og følger op, så færre falder mellem stolene.\n\nBook 20 minutter, så finder jeg ét konkret sted, hvor I taber møder i dag. Finder jeg ikke noget brugbart, stopper vi der.",
  headline: "Få flere møder ud af de leads I allerede får",
  description: "Carter & Co — fra leads til møder",
  // Click destination if a user clicks the ad outside the lead form CTA
  link_url: "https://www.carterco.dk",
};

const LEAD_FORM = {
  name: "Carter & Co — Lead Gen Test 1",
  locale: "da_DK",
  privacy_policy_url: "https://www.carterco.dk/privatlivspolitik",
  follow_up_action_url: "https://cal.com/louis-carter-3twilu/20min",
  intro_headline: "Find ét sted, hvor I taber møder i dag",
  intro_paragraph: "Fortæl kort om jeres lead-flow. Så ringer Louis og finder ét konkret sted, hvor I kan få flere møder ud af de leads, I allerede får.",
  thank_you_headline: "Tak — vælg en tid med Louis",
  thank_you_body: "Det tager 20 minutter. Vi kigger på jeres lead-flow sammen, og I går fra samtalen med mindst én konkret ting, I kan rette.",
  thank_you_button: "Vælg en tid",
  questions: [
    { type: "FULL_NAME" },
    { type: "EMAIL" },
    { type: "PHONE" },
    { type: "COMPANY_NAME" },
    {
      type: "CUSTOM",
      key: "moeder_per_uge",
      label: "Hvor mange møder/uge har jeres sælgere?",
      options: [
        { value: "0–2" },
        { value: "3–5" },
        { value: "6–10" },
        { value: "11+" },
      ],
    },
  ],
};

async function loadToken() {
  const envPath = path.join(ROOT, ".env.local");
  let raw;
  try { raw = await fs.readFile(envPath, "utf8"); }
  catch { throw new Error(`Missing ${envPath} — add META_ACCESS_TOKEN=... and re-run`); }
  for (const line of raw.split("\n")) {
    const m = line.match(/^META_ACCESS_TOKEN\s*=\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("META_ACCESS_TOKEN not found in .env.local");
}

async function loadManifest() {
  try { return JSON.parse(await fs.readFile(MANIFEST_PATH, "utf8")); }
  catch { return { images: {}, lead_form_id: null, ad_ids: {} }; }
}

async function saveManifest(m) {
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

async function graphPost(urlPath, body, token, formData = false) {
  const url = `${GRAPH}${urlPath}`;
  let opts;
  if (formData) {
    opts = { method: "POST", body }; // body is FormData; token included as field
  } else {
    opts = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, access_token: token }),
    };
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`${urlPath} → ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  }
  return json;
}

async function uploadImage(token, relPath, manifest) {
  if (manifest.images[relPath]?.hash) {
    console.log(`  · ${relPath} cached (${manifest.images[relPath].hash.slice(0, 10)}…)`);
    return manifest.images[relPath].hash;
  }
  const bytes = await fs.readFile(path.join(ASSETS, relPath));
  const filename = relPath.replace(/[^a-zA-Z0-9.]/g, "_");
  const form = new FormData();
  form.append("access_token", token);
  form.append(filename, new Blob([bytes], { type: "image/jpeg" }), filename);
  const json = await graphPost(`/act_${AD_ACCOUNT_ID}/adimages`, form, token, true);
  // Response shape: { images: { "<filename>": { hash, url, ... } } }
  const entry = Object.values(json.images ?? {})[0];
  const hash = entry?.hash;
  if (!hash) throw new Error(`no hash in response for ${relPath}: ${JSON.stringify(json)}`);
  manifest.images[relPath] = { hash, uploaded_at: new Date().toISOString() };
  await saveManifest(manifest);
  console.log(`  ↑ ${relPath} → ${hash.slice(0, 10)}…`);
  return hash;
}

async function createLeadForm(token, manifest) {
  if (manifest.lead_form_id) {
    console.log(`  · lead form cached (${manifest.lead_form_id})`);
    return manifest.lead_form_id;
  }
  const questions = LEAD_FORM.questions.map(q => {
    if (q.type !== "CUSTOM") return { type: q.type };
    return {
      type: "CUSTOM",
      key: q.key,
      label: q.label,
      options: q.options,
    };
  });
  const body = {
    name: LEAD_FORM.name,
    locale: LEAD_FORM.locale,
    follow_up_action_url: LEAD_FORM.follow_up_action_url,
    privacy_policy: {
      url: LEAD_FORM.privacy_policy_url,
      link_text: "Privatlivspolitik",
    },
    questions,
    // Meta accepts both "questions_page_custom_headline" and a context_card.
    // context_card is the rich intro screen.
    context_card: {
      title: LEAD_FORM.intro_headline,
      content: [LEAD_FORM.intro_paragraph],
      style: "PARAGRAPH_STYLE",
      button_text: "Fortsæt",
    },
    thank_you_page: {
      title: LEAD_FORM.thank_you_headline,
      body: LEAD_FORM.thank_you_body,
      button_text: LEAD_FORM.thank_you_button,
      button_type: "VIEW_WEBSITE",
      website_url: LEAD_FORM.follow_up_action_url,
    },
  };
  const json = await graphPost(`/${PAGE_ID}/leadgen_forms`, body, token);
  manifest.lead_form_id = json.id;
  await saveManifest(manifest);
  console.log(`  ↑ lead form → ${json.id}`);
  return json.id;
}

// Deterministic placement → ratio mapping.
// 4:5 → main feeds (FB feed, IG feed)
// 9:16 → stories/reels
// 16:9 → in-stream video, audience network video
// 1:1 → marketplace, right column, search
const PLACEMENT_RULES = [
  { label: "feed", spec: { publisher_platforms: ["facebook"], facebook_positions: ["feed"] } },
  { label: "feed", spec: { publisher_platforms: ["instagram"], instagram_positions: ["stream"] } },
  { label: "story", spec: { publisher_platforms: ["facebook"], facebook_positions: ["story"] } },
  { label: "story", spec: { publisher_platforms: ["instagram"], instagram_positions: ["story", "reels"] } },
  { label: "video", spec: { publisher_platforms: ["facebook"], facebook_positions: ["instream_video", "video_feeds"] } },
  { label: "video", spec: { publisher_platforms: ["audience_network"], audience_network_positions: ["instream_video"] } },
  { label: "square", spec: { publisher_platforms: ["facebook"], facebook_positions: ["marketplace", "search", "right_hand_column"] } },
];

const RATIO_TO_LABEL = { "4x5": "feed", "9x16": "story", "16x9": "video", "1x1": "square" };

async function createAd(token, ad, hashes, leadFormId, manifest) {
  if (manifest.ad_ids[ad.key]) {
    console.log(`  · ad "${ad.name}" cached (${manifest.ad_ids[ad.key]})`);
    return;
  }

  // Default image (used for the underlying post): use the 4:5 hash since that
  // covers the main feeds. Placement variants come from asset_feed_spec below.
  const defaultHash = hashes["4x5"];

  // asset_feed_spec: list each image with an adlabel matching PLACEMENT_RULES.
  // Meta auto-picks the labelled image per matched placement.
  const images = Object.entries(ad.images).map(([ratio]) => ({
    hash: hashes[ratio],
    adlabels: [{ name: RATIO_TO_LABEL[ratio] }],
  }));

  const creative = {
    name: `${ad.name} — creative`,
    object_story_spec: {
      page_id: PAGE_ID,
      link_data: {
        link: AD_COPY.link_url,
        message: AD_COPY.primary_text,
        name: AD_COPY.headline,
        description: AD_COPY.description,
        image_hash: defaultHash,
        call_to_action: {
          type: "APPLY_NOW",
          value: { lead_gen_form_id: leadFormId },
        },
      },
    },
    asset_feed_spec: {
      images,
      bodies: [{ text: AD_COPY.primary_text }],
      titles: [{ text: AD_COPY.headline }],
      descriptions: [{ text: AD_COPY.description }],
      link_urls: [{ website_url: AD_COPY.link_url }],
      ad_formats: ["SINGLE_IMAGE"],
      call_to_action_types: ["APPLY_NOW"],
      asset_customization_rules: PLACEMENT_RULES.map(r => ({
        customization_spec: r.spec,
        image_label: { name: r.label },
      })),
    },
  };

  const body = {
    name: ad.name,
    adset_id: AD_SET_ID,
    status: "PAUSED",
    creative,
  };

  let json;
  try {
    json = await graphPost(`/act_${AD_ACCOUNT_ID}/ads`, body, token);
  } catch (err) {
    // Fallback: if asset_feed_spec is rejected (gated feature), retry with
    // just the 4:5 image. Better to ship a working ad than fail the script.
    console.log(`  ! asset_feed_spec failed for "${ad.name}", falling back to single 4:5 image`);
    console.log(`    (${err.message.slice(0, 200)})`);
    const simpleBody = {
      name: ad.name,
      adset_id: AD_SET_ID,
      status: "PAUSED",
      creative: {
        name: `${ad.name} — creative`,
        object_story_spec: {
          page_id: PAGE_ID,
          link_data: {
            link: AD_COPY.link_url,
            message: AD_COPY.primary_text,
            name: AD_COPY.headline,
            description: AD_COPY.description,
            image_hash: defaultHash,
            call_to_action: {
              type: "APPLY_NOW",
              value: { lead_gen_form_id: leadFormId },
            },
          },
        },
      },
    };
    json = await graphPost(`/act_${AD_ACCOUNT_ID}/ads`, simpleBody, token);
  }

  manifest.ad_ids[ad.key] = json.id;
  await saveManifest(manifest);
  console.log(`  ↑ ad "${ad.name}" → ${json.id}`);
}

async function main() {
  const token = await loadToken();
  const manifest = await loadManifest();

  console.log("\n[1/3] Uploading images …");
  const hashesByAd = {};
  for (const ad of ADS) {
    hashesByAd[ad.key] = {};
    for (const [ratio, relPath] of Object.entries(ad.images)) {
      hashesByAd[ad.key][ratio] = await uploadImage(token, relPath, manifest);
    }
  }

  console.log("\n[2/3] Creating lead form …");
  const leadFormId = await createLeadForm(token, manifest);

  console.log("\n[3/3] Creating ads (PAUSED) …");
  for (const ad of ADS) {
    await createAd(token, ad, hashesByAd[ad.key], leadFormId, manifest);
  }

  console.log("\n✓ Done.");
  console.log(`  Lead form: ${leadFormId}`);
  console.log(`  Review ads: https://business.facebook.com/adsmanager/manage/ads?act=${AD_ACCOUNT_ID}&selected_adset_ids=${AD_SET_ID}`);
  console.log(`  All ads are PAUSED — un-pause in Ads Manager when ready.`);
}

main().catch(err => {
  console.error("\nERROR:", err.message);
  console.error("\nState is saved in .meta-upload-manifest.json — re-run safely.");
  process.exit(1);
});
