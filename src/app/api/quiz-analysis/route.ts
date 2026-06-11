// 410 stub — the lead-quiz (and its AI website analysis) was replaced by the
// Lead Flex scoping flow on 2026-06-11 (CEO plan 2026-06-10-leadflex-website-cta).
// Kept for one release so stale tabs / in-flight sessions get a clean answer
// instead of a 404. Delete after the next release.
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return NextResponse.json(
    { error: "gone", detail: "the lead quiz was retired" },
    { status: 410 },
  );
}
