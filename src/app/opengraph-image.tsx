import { ImageResponse } from "next/og";

export const dynamic = "force-static";
export const alt = "Carter & Co — Smed mens jernet er varmt";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 96px",
          background:
            "radial-gradient(ellipse at 78% 62%, rgba(218,96,34,0.45), transparent 55%), radial-gradient(ellipse at 14% 12%, rgba(25,70,58,0.40), transparent 50%), #0f0d0a",
          color: "#fff8ea",
          fontFamily: "sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div
            style={{
              width: 14,
              height: 14,
              borderRadius: 999,
              background: "#ff6b2c",
              boxShadow: "0 0 24px rgba(255,107,44,0.9)",
            }}
          />
          <div
            style={{
              fontSize: 22,
              letterSpacing: 6,
              textTransform: "uppercase",
              color: "rgba(255,248,234,0.65)",
              fontWeight: 700,
            }}
          >
            Carter &amp; Co · København
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 124,
            lineHeight: 0.95,
            letterSpacing: -3,
            fontWeight: 700,
          }}
        >
          <div style={{ display: "flex" }}>Smed mens</div>
          <div style={{ display: "flex" }}>
            jernet er{" "}
            <span
              style={{
                fontStyle: "italic",
                color: "#ff6b2c",
                marginLeft: 18,
              }}
            >
              varmt.
            </span>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div
            style={{
              fontSize: 26,
              color: "rgba(255,248,234,0.62)",
              maxWidth: 720,
              lineHeight: 1.35,
            }}
          >
            Vi kontakter dine leads inden for 5 minutter — 21× mere tilbøjelige
            til at blive kvalificeret.
          </div>
          <div
            style={{
              fontSize: 18,
              letterSpacing: 4,
              textTransform: "uppercase",
              color: "rgba(255,248,234,0.55)",
              fontWeight: 700,
            }}
          >
            carterco.dk
          </div>
        </div>
      </div>
    ),
    { ...size },
  );
}
