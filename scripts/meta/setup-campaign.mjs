#!/usr/bin/env node
// Full Meta lead-gen build from a single config file:
//   campaign → ad set (targeting/budget/optimization) → creatives → lead form → ads
//
// Everything is created PAUSED at all three levels (campaign, ad set, ads), so
// running this NEVER spends money. You un-pause in Ads Manager when ready.
//
// This is the layer ABOVE scripts/meta/upload_carterco_leadgen.mjs: that script
// creates ads under a hand-made ad set; this one creates the campaign + ad set too,
// driven entirely by config so it's reusable per client.
//
// Reads META_ACCESS_TOKEN from .env.local. That is the ADS token (scopes:
// ads_management, leads_retrieval, pages_manage_ads, pages_read_engagement) —
// NOT the META_CAPI_ACCESS_TOKEN, which is dataset-scoped and won't work here.
//
// Idempotent — a per-client manifest at .meta-setup-manifest-<client>.json
// (gitignored) stores campaign id / ad set id / image hashes / form id / ad ids,
// so re-runs skip work already done.
//
// Usage:   node scripts/meta/setup-campaign.mjs clients/carterco/meta-campaign.json
// Reset:   rm .meta-setup-manifest-<client>.json   (then re-run)

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "../..");
const GRAPH = "https://graph.facebook.com/v21.0";

// ── config / token / manifest ───────────────────────────────────────────────

async function loadConfig() {
  const rel = process.argv[2];
  if (!rel) throw new Error("Usage: node scripts/meta/setup-campaign.mjs <config.json>");
  const abs = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const cfg = JSON.parse(await fs.readFile(abs, "utf8"));
  for (const k of ["client", "account_id", "page_id", "assets_dir", "campaign", "ad_set", "lead_form", "ad_copy", "ads"]) {
    if (!cfg[k]) throw new Error(`config missing required key: ${k}`);
  }
  return cfg;
}

async function loadToken() {
  const envPath = path.join(ROOT, ".env.local");
  let raw;
  try { raw = await fs.readFile(envPath, "utf8"); }
  catch { throw new Error(`Missing ${envPath}`); }
  for (const line of raw.split("\n")) {
    const m = line.match(/^META_ACCESS_TOKEN\s*=\s*(.+)$/);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error(
    "META_ACCESS_TOKEN not found in .env.local.\n" +
    "  This is the ADS token (ads_management, leads_retrieval, pages_manage_ads),\n" +
    "  NOT META_CAPI_ACCESS_TOKEN. Generate one at\n" +
    "  https://developers.facebook.com/tools/explorer (or a System User token for\n" +
    "  a non-expiring one) and add META_ACCESS_TOKEN=... to .env.local."
  );
}

function manifestPath(client) {
  return path.join(ROOT, `.meta-setup-manifest-${client}.json`);
}
async function loadManifest(client) {
  try { return JSON.parse(await fs.readFile(manifestPath(client), "utf8")); }
  catch { return { campaign_id: null, adset_id: null, images: {}, lead_form_id: null, ad_ids: {} }; }
}
async function saveManifest(client, m) {
  await fs.writeFile(manifestPath(client), JSON.stringify(m, null, 2));
}

// ── graph helper ────────────────────────────────────────────────────────────

async function graphPost(urlPath, body, token, formData = false) {
  const opts = formData
    ? { method: "POST", body }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, access_token: token }) };
  const res = await fetch(`${GRAPH}${urlPath}`, opts);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    throw new Error(`${urlPath} → ${res.status}: ${JSON.stringify(json.error ?? json)}`);
  }
  return json;
}

// ── campaign + ad set (the new layer) ───────────────────────────────────────

async function createCampaign(token, cfg, manifest) {
  if (manifest.campaign_id) { console.log(`  · campaign cached (${manifest.campaign_id})`); return manifest.campaign_id; }
  const body = {
    name: cfg.campaign.name,
    objective: cfg.campaign.objective,
    special_ad_categories: cfg.campaign.special_ad_categories ?? [],
    status: "PAUSED",
  };
  const json = await graphPost(`/act_${cfg.account_id}/campaigns`, body, token);
  manifest.campaign_id = json.id;
  await saveManifest(cfg.client, manifest);
  console.log(`  ↑ campaign → ${json.id}`);
  return json.id;
}

async function createAdSet(token, cfg, campaignId, manifest) {
  if (manifest.adset_id) { console.log(`  · ad set cached (${manifest.adset_id})`); return manifest.adset_id; }
  const a = cfg.ad_set;
  const body = {
    name: a.name,
    campaign_id: campaignId,
    daily_budget: a.daily_budget,                 // minor units (øre for DKK)
    billing_event: a.billing_event,               // IMPRESSIONS
    optimization_goal: a.optimization_goal,       // LEAD_GENERATION (→ QUALITY_LEAD once CAPI volume supports it)
    bid_strategy: a.bid_strategy,                  // LOWEST_COST_WITHOUT_CAP
    destination_type: a.destination_type,         // ON_AD (instant lead form)
    targeting: a.targeting,
    promoted_object: { page_id: cfg.page_id },     // instant form attaches to the page
    status: "PAUSED",
    ...(a.start_time ? { start_time: a.start_time } : {}),
  };
  const json = await graphPost(`/act_${cfg.account_id}/adsets`, body, token);
  manifest.adset_id = json.id;
  await saveManifest(cfg.client, manifest);
  console.log(`  ↑ ad set → ${json.id}`);
  return json.id;
}

// ── creatives / form / ads (same proven logic as upload_carterco_leadgen.mjs) ─

async function uploadImage(token, cfg, relPath, manifest) {
  if (manifest.images[relPath]?.hash) {
    console.log(`  · ${relPath} cached (${manifest.images[relPath].hash.slice(0, 10)}…)`);
    return manifest.images[relPath].hash;
  }
  const bytes = await fs.readFile(path.join(ROOT, cfg.assets_dir, relPath));
  const filename = relPath.replace(/[^a-zA-Z0-9.]/g, "_");
  const form = new FormData();
  form.append("access_token", token);
  form.append(filename, new Blob([bytes], { type: "image/jpeg" }), filename);
  const json = await graphPost(`/act_${cfg.account_id}/adimages`, form, token, true);
  const entry = Object.values(json.images ?? {})[0];
  const hash = entry?.hash;
  if (!hash) throw new Error(`no hash in response for ${relPath}: ${JSON.stringify(json)}`);
  manifest.images[relPath] = { hash, uploaded_at: new Date().toISOString() };
  await saveManifest(cfg.client, manifest);
  console.log(`  ↑ ${relPath} → ${hash.slice(0, 10)}…`);
  return hash;
}

async function createLeadForm(token, cfg, manifest) {
  if (manifest.lead_form_id) { console.log(`  · lead form cached (${manifest.lead_form_id})`); return manifest.lead_form_id; }
  const f = cfg.lead_form;
  const questions = f.questions.map(q =>
    q.type !== "CUSTOM" ? { type: q.type } : { type: "CUSTOM", key: q.key, label: q.label, options: q.options }
  );
  const body = {
    name: f.name,
    locale: f.locale,
    follow_up_action_url: f.follow_up_action_url,
    privacy_policy: { url: f.privacy_policy_url, link_text: "Privatlivspolitik" },
    questions,
    context_card: { title: f.intro_headline, content: [f.intro_paragraph], style: "PARAGRAPH_STYLE", button_text: "Fortsæt" },
    thank_you_page: {
      title: f.thank_you_headline, body: f.thank_you_body,
      button_text: f.thank_you_button, button_type: "VIEW_WEBSITE",
      website_url: f.follow_up_action_url,
    },
  };
  const json = await graphPost(`/${cfg.page_id}/leadgen_forms`, body, token);
  manifest.lead_form_id = json.id;
  await saveManifest(cfg.client, manifest);
  console.log(`  ↑ lead form → ${json.id}`);
  return json.id;
}

// Deterministic placement → ratio mapping (4:5 feeds, 9:16 stories, 16:9 video, 1:1 square).
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

async function createAd(token, cfg, ad, hashes, leadFormId, manifest) {
  if (manifest.ad_ids[ad.key]) { console.log(`  · ad "${ad.name}" cached (${manifest.ad_ids[ad.key]})`); return; }
  const c = cfg.ad_copy;
  const defaultHash = hashes["4x5"];
  const images = Object.keys(ad.images).map(ratio => ({ hash: hashes[ratio], adlabels: [{ name: RATIO_TO_LABEL[ratio] }] }));

  const linkData = {
    link: c.link_url, message: c.primary_text, name: c.headline, description: c.description,
    image_hash: defaultHash,
    call_to_action: { type: "APPLY_NOW", value: { lead_gen_form_id: leadFormId } },
  };

  const creative = {
    name: `${ad.name} — creative`,
    object_story_spec: { page_id: cfg.page_id, link_data: linkData },
    asset_feed_spec: {
      images,
      bodies: [{ text: c.primary_text }],
      titles: [{ text: c.headline }],
      descriptions: [{ text: c.description }],
      link_urls: [{ website_url: c.link_url }],
      ad_formats: ["SINGLE_IMAGE"],
      call_to_action_types: ["APPLY_NOW"],
      asset_customization_rules: PLACEMENT_RULES.map(r => ({ customization_spec: r.spec, image_label: { name: r.label } })),
    },
  };

  const body = { name: ad.name, adset_id: manifest.adset_id, status: "PAUSED", creative };

  let json;
  try {
    json = await graphPost(`/act_${cfg.account_id}/ads`, body, token);
  } catch (err) {
    // Fallback: if asset_feed_spec is gated/rejected, ship a working single 4:5 ad.
    console.log(`  ! asset_feed_spec failed for "${ad.name}", falling back to single 4:5 image`);
    console.log(`    (${err.message.slice(0, 200)})`);
    const simpleBody = {
      name: ad.name, adset_id: manifest.adset_id, status: "PAUSED",
      creative: { name: `${ad.name} — creative`, object_story_spec: { page_id: cfg.page_id, link_data: linkData } },
    };
    json = await graphPost(`/act_${cfg.account_id}/ads`, simpleBody, token);
  }

  manifest.ad_ids[ad.key] = json.id;
  await saveManifest(cfg.client, manifest);
  console.log(`  ↑ ad "${ad.name}" → ${json.id}`);
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const cfg = await loadConfig();
  const token = await loadToken();
  const manifest = await loadManifest(cfg.client);

  console.log(`\n[1/5] Campaign …`);
  const campaignId = await createCampaign(token, cfg, manifest);

  console.log(`\n[2/5] Ad set …`);
  await createAdSet(token, cfg, campaignId, manifest);

  console.log(`\n[3/5] Uploading creatives …`);
  const hashesByAd = {};
  for (const ad of cfg.ads) {
    hashesByAd[ad.key] = {};
    for (const [ratio, relPath] of Object.entries(ad.images)) {
      hashesByAd[ad.key][ratio] = await uploadImage(token, cfg, relPath, manifest);
    }
  }

  console.log(`\n[4/5] Lead form …`);
  const leadFormId = await createLeadForm(token, cfg, manifest);

  console.log(`\n[5/5] Ads (PAUSED) …`);
  for (const ad of cfg.ads) {
    await createAd(token, cfg, ad, hashesByAd[ad.key], leadFormId, manifest);
  }

  console.log(`\n✓ Done. Everything is PAUSED — nothing is spending.`);
  console.log(`  Campaign: ${manifest.campaign_id}`);
  console.log(`  Ad set:   ${manifest.adset_id}`);
  console.log(`  Form:     ${leadFormId}`);
  console.log(`  Review:   https://business.facebook.com/adsmanager/manage/campaigns?act=${cfg.account_id}&selected_campaign_ids=${manifest.campaign_id}`);
  console.log(`  Un-pause the ad set + ads in Ads Manager when you're ready to spend.`);
}

main().catch(err => {
  console.error("\nERROR:", err.message);
  console.error("\nState is saved in the manifest — re-run safely.");
  process.exit(1);
});
