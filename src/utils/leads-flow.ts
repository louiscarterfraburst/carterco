// Per-workspace /leads flow description — the machine a lead runs through,
// derived from the workspace's configuration (outcome_preset, booking_url,
// sms_enabled) so the Flow page always shows what is actually wired, not a
// static diagram.

import type { Workspace } from "@/utils/workspace";

// Workspaces with the Nexudus booking webhook attached: a booking made by the
// lead auto-flips outcome to Booket and fires the Meta CAPI "booket" event.
// Operator-maintained (matches SOHO_WORKSPACE_ID on the nexudus-webhook fn).
const NEXUDUS_WORKSPACE_IDS = new Set(["7f13f551-9514-4a5a-b1bf-98eb95c1a469"]);

export type FlowBranch = {
  label: string;
  detail: string;
  closes?: boolean;
};

export type FlowStep = {
  key: string;
  title: string;
  actor: "auto" | "operatør";
  detail: string;
  branches?: FlowBranch[];
};

export function buildLeadsFlow(ws: Pick<Workspace, "id" | "name" | "booking_url" | "signoff" | "sms_enabled" | "outcome_preset">): FlowStep[] {
  const preset = ws.outcome_preset ?? "standard";
  const nexudus = NEXUDUS_WORKSPACE_IDS.has(ws.id);

  const steps: FlowStep[] = [];

  steps.push({
    key: "intake",
    title: "Lead lander",
    actor: "auto",
    detail:
      "Meta lead ads (instant form) routes til dette workspace. Leadet vises live i panelet, og medlemmer med push-notifikationer slået til får besked med det samme.",
  });

  steps.push({
    key: "call",
    title: "Ring først",
    actor: "operatør",
    detail:
      "Ring-knappen åbner et tel:-opkald fra den enhed, der klikker. Klikket logges automatisk på leadet (hvem ringede, hvornår), så dobbeltopkald undgås.",
  });

  steps.push({
    key: "no_answer",
    title: "Intet svar",
    actor: "operatør",
    detail: [
      "Leadet bliver i Aktive-køen og dukker op igen til nyt forsøg (forsøgstæller på leadet). Et lead lukker aldrig af sig selv.",
      ws.booking_url
        ? `“Skriv mail” laver et personligt udkast: fornavn + link til ${ws.booking_url} + afsluttes “${ws.signoff ?? ws.name}”. Sendes fra operatørens egen mailboks.`
        : "“Skriv mail” bruger standardskabelonen (intet booking-link sat på workspacet endnu).",
    ].join(" "),
  });

  if (ws.sms_enabled) {
    steps.push({
      key: "sms",
      title: "SMS efter ubesvaret kald",
      actor: "operatør",
      detail:
        "Operatør-fyret SMS-handoff efter kald uden svar — teksten varierer med antal forsøg. Aldrig kold SMS.",
    });
  }

  const meetingRoomStep = (key: string, title: string): FlowStep => ({
    key,
    title,
    actor: "operatør",
    detail: "Fire knapper i leadets sprog — kun “Ikke relevant” lukker.",
    branches: [
      {
        label: "Delt link",
        detail:
          "Leadet overvåges: genopdukker til et nudge dag 1, 2 og 4 efter linket blev delt — derefter stille. Lukker aldrig.",
      },
      {
        label: "Ring tilbage",
        detail: "Aftalt tidspunkt sættes på leadet, og det resurfacer i køen til tiden.",
      },
      {
        label: "Booket",
        detail: nexudus
          ? "Sættes automatisk når leadet booker i Nexudus (webhook matcher på e-mail) — og bookingen meldes til Meta (CAPI), så annoncerne optimerer mod bookinger. Kan også sættes manuelt."
          : "Sættes manuelt når aftalen (fremvisning/prøvedag) er i hus — mødetidspunkt registreres på leadet.",
      },
      {
        label: "Ikke relevant",
        detail: "Lukker leadet. Den eneste vej til lukket.",
        closes: true,
      },
    ],
  });

  const officeStep = (key: string, title: string): FlowStep => ({
    key,
    title,
    actor: "operatør",
    detail: "Kontor-leads lukker via fremvisning → lejet — kun “Ikke relevant” lukker.",
    branches: [
      {
        label: "Fremvisning booket",
        detail: "Fremvisningen er i kalenderen — mødetidspunkt registreres på leadet.",
      },
      {
        label: "Lejet",
        detail: "Kontoret er lejet — den endelige konvertering.",
      },
      {
        label: "Interesseret",
        detail: "Holdes varm: leadet resurfacer efter 2 dage til opfølgning. Lukker aldrig.",
      },
      {
        label: "Ring tilbage",
        detail: "Aftalt tidspunkt sættes på leadet, og det resurfacer i køen til tiden.",
      },
      {
        label: "Ikke relevant",
        detail: "Lukker leadet. Den eneste vej til lukket.",
        closes: true,
      },
    ],
  });

  // Soho's workspace receives both mødelokale-leads (CR New-copy form) and
  // kontor-leads (Office-carter form); the panel picks outcome buttons per
  // lead via meta_form_id (src/utils/lead-presets.ts), so the flow shows both.
  const SOHO_SPLIT_WS = "7f13f551-9514-4a5a-b1bf-98eb95c1a469";

  if (ws.id === SOHO_SPLIT_WS) {
    steps.push(meetingRoomStep("outcome", "Udfald — mødelokale-leads"));
    steps.push(officeStep("outcome_office", "Udfald — kontor-leads"));
  } else if (preset === "meeting_room") {
    steps.push(meetingRoomStep("outcome", "Udfald efter samtale"));
  } else {
    steps.push({
      key: "outcome",
      title: "Udfald efter samtale",
      actor: "operatør",
      detail: "Standard-udfald — kun “Ikke relevant” lukker.",
      branches: [
        { label: "Booket", detail: "Møde i kalenderen — mødetidspunkt registreres på leadet." },
        { label: "Kunde", detail: "Vundet — den endelige konvertering." },
        { label: "Interesseret", detail: "Varm, men ikke booket endnu — leadet holdes åbent og følges op." },
        { label: "Ikke relevant", detail: "Lukker leadet.", closes: true },
      ],
    });
  }

  return steps;
}
