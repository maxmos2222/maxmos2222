#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATOR_DIR="$ROOT_DIR/node_modules/github-profile-summary-cards"
OUTPUT_DIR="$ROOT_DIR/data/stats"

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "Error: GITHUB_TOKEN is not set." >&2
  exit 1
fi

if [[ ! -f "$GENERATOR_DIR/scripts/dev-server.ts" ]]; then
  echo "Error: The installed generator does not contain scripts/dev-server.ts." >&2
  echo "Run pnpm install and check the installed upstream revision." >&2
  exit 1
fi

TEMP_DIR="$(mktemp -d)"
SERVER_PID=""

cleanup() {
  if [[ -n "$SERVER_PID" ]]; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi

  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT

# Do not accidentally send requests to an unrelated local server.
if python3 - <<'PY'
import socket

with socket.socket() as sock:
    sock.bind(("127.0.0.1", 3000))
PY
then
  :
else
  echo "Error: Port 3000 is already in use." >&2
  exit 1
fi

# Use the root project's installed tsx, but run from the generator's
# directory so its relative paths and configuration resolve correctly.
TSX="$ROOT_DIR/node_modules/.bin/tsx"

(
  cd "$GENERATOR_DIR"
  exec "$TSX" scripts/dev-server.ts
) >"$TEMP_DIR/server.log" 2>&1 &
SERVER_PID=$!

echo "Waiting for the local card generator..."

READY=false

for attempt in $(seq 1 90); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Error: The generator stopped unexpectedly." >&2
    cat "$TEMP_DIR/server.log"
    exit 1
  fi

  if curl \
    --silent \
    --max-time 3 \
    "http://127.0.0.1:3000/" \
    --output /dev/null; then
    READY=true
    break
  fi

  sleep 2
done

if [[ "$READY" != true ]]; then
  echo "Error: The generator did not become ready." >&2
  cat "$TEMP_DIR/server.log"
  exit 1
fi

mkdir -p "$TEMP_DIR/cards"

generate_card() {
  local endpoint="$1"
  local key="$2"

  echo "Generating ${key}.svg..."

  if ! curl \
    --fail \
    --silent \
    --show-error \
    --get \
    --retry 3 \
    --retry-delay 5 \
    --connect-timeout 10 \
    --max-time 180 \
    "http://127.0.0.1:3000/api/cards/${endpoint}" \
    --data-urlencode "username=Master3307" \
    --data-urlencode "theme=zenburn" \
    --data-urlencode "animation=stagger" \
    --data-urlencode "duration=1.3" \
    --data-urlencode "utcOffset=2" \
    --data-urlencode "title_color=dc8add" \
    --data-urlencode "text_color=8e58d4" \
    --data-urlencode "bg_color=00000000" \
    --data-urlencode "border_color=00000000" \
    --data-urlencode "icon_color=8e58d4" \
    --data-urlencode "chart_color=dc8add" \
    --data-urlencode "mock=0" \
    --output "$TEMP_DIR/cards/${key}.svg"; then
    echo "Error: Failed to generate ${key}.svg." >&2
    cat "$TEMP_DIR/server.log"
    return 1
  fi
}

generate_card profile-details profile
generate_card repos-per-language repos
generate_card most-commit-language commits
generate_card stats stats
generate_card productive-time time

# Validate every result before replacing the existing files.
python3 - "$TEMP_DIR/cards" <<'PY'
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

directory = Path(sys.argv[1])
expected = {"profile", "repos", "commits", "stats", "time"}

for key in sorted(expected):
    path = directory / f"{key}.svg"

    if not path.is_file() or not path.stat().st_size:
        raise SystemExit(f"Missing or empty output: {path.name}")

    root = ET.parse(path).getroot()

    if root.tag.split("}")[-1] != "svg":
        raise SystemExit(f"Invalid SVG: {path.name}")

    print(f"Validated {path.name}")
PY

mkdir -p "$OUTPUT_DIR"
cp "$TEMP_DIR/cards/"*.svg "$OUTPUT_DIR/"

echo "Generated all five cards in data/stats/."

echo "Generating wakatime.svg..."

curl \
  --fail \
  --silent \
  --show-error \
  --location \
  --retry 3 \
  --retry-delay 5 \
  --connect-timeout 10 \
  --max-time 60 \
  "https://wakatime.com/badge/user/229ef515-6448-4da4-8301-8209d6e208dc.svg" \
  --output "$TEMP_DIR/wakatime-original.svg"

python3 - "$TEMP_DIR/wakatime-original.svg" "$OUTPUT_DIR/wakatime.svg" <<'PY'
import html
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

source = Path(sys.argv[1])
destination = Path(sys.argv[2])

root = ET.parse(source).getroot()

if root.tag.split("}")[-1] != "svg":
    raise SystemExit("WakaTime did not return an SVG.")

# Shields-style badges normally expose the complete label and value here.
candidates = []

aria_label = root.attrib.get("aria-label", "")
if aria_label:
    candidates.append(aria_label.rsplit(":", 1)[-1].strip())

# Fallback for badges that expose the value only in their text elements.
for element in root.iter():
    if element.tag.split("}")[-1] in {"text", "title"}:
        text = "".join(element.itertext()).strip()
        if text:
            candidates.append(text.rsplit(":", 1)[-1].strip())

time_pattern = re.compile(
    r"\d[\d,.]*\s*(?:hours?|hrs?|minutes?|mins?|seconds?|secs?|days?)\b",
    re.IGNORECASE,
)

value = next(
    (candidate for candidate in candidates if time_pattern.search(candidate)),
    None,
)

if not value:
    raise SystemExit(
        "Could not extract coding time from the WakaTime badge. "
        "Existing local badge was not replaced."
    )

# Avoid rendering an unexpected response as a huge card.
if len(value) > 100:
    raise SystemExit("Unexpectedly long WakaTime badge value.")

safe_value = html.escape(value)
accessible_label = html.escape(
    f"WakaTime coding time since Apr 11 2025: {value}",
    quote=True,
)

svg = f"""<svg xmlns="http://www.w3.org/2000/svg"
  width="440" height="88" viewBox="0 0 440 88"
  role="img" aria-label="{accessible_label}">
  <title>{accessible_label}</title>

  <style>
    text {{
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
                   Helvetica, Arial, sans-serif;
      text-anchor: middle;
    }}

    .content {{
      animation: appear 1.3s ease-out both;
    }}

    @keyframes appear {{
      from {{ opacity: 0; }}
      to {{ opacity: 1; }}
    }}

    @media (prefers-reduced-motion: reduce) {{
      .content {{ animation: none; }}
    }}
  </style>

  <g class="content">
    <!-- Centered heading: 18px icon + 8px gap + 68px text -->
    <svg x="173" y="7" width="18" height="18"
      viewBox="0 0 340 340" aria-hidden="true">
      <circle
        cx="170"
        cy="170"
        r="150"
        fill="none"
        stroke="#dc8add"
        stroke-width="40" />

      <path
        d="M190.183 213.541C188.74 215.443 186.576 216.667 184.151 216.667C183.913 216.667 183.677 216.651 183.443 216.627C183.042 216.579 182.823 216.545 182.606 216.497C182.337 216.434 182.137 216.375 181.94 216.308C181.561 216.176 181.392 216.109 181.228 216.035C180.843 215.849 180.707 215.778 180.572 215.701C180.205 215.478 180.109 215.412 180.014 215.345C179.856 215.233 179.698 215.117 179.547 214.992C179.251 214.746 179.147 214.65 179.044 214.552C178.731 214.241 178.531 214.018 178.341 213.785C177.982 213.331 177.69 212.888 177.438 212.415L168.6 198.214L159.766 212.415C158.38 214.939 155.874 216.667 152.995 216.667C150.106 216.667 147.588 214.926 146.243 212.346L107.607 156.061C106.337 154.529 105.556 152.499 105.556 150.258C105.556 145.514 109.043 141.665 113.344 141.665C116.127 141.665 118.564 143.282 119.942 145.708L152.555 193.9L161.735 178.952C163.058 176.288 165.626 174.478 168.575 174.478C171.273 174.478 173.652 175.996 175.049 178.298L184.517 193.839L235.684 120.583C237.075 118.226 239.475 116.667 242.213 116.667C246.514 116.667 250 120.514 250 125.258C250 127.332 249.337 129.232 248.23 130.715L190.183 213.541Z"
        fill="#dc8add"
        stroke="#dc8add"
        stroke-width="10" />
    </svg>

    <text x="199" y="22" fill="#dc8add"
      font-size="14" font-weight="600"
      style="text-anchor: start"
      textLength="68"
      lengthAdjust="spacingAndGlyphs">WakaTime</text>

    <text x="220" y="51" fill="#8e58d4"
      font-size="23" font-weight="700">{safe_value}</text>

    <text x="220" y="73" fill="#8e58d4"
      font-size="11">Tracked since Apr 11, 2025</text>
  </g>
</svg>
"""

ET.fromstring(svg)

destination.parent.mkdir(parents=True, exist_ok=True)
temporary = destination.with_suffix(".svg.tmp")
temporary.write_text(svg, encoding="utf-8")
temporary.replace(destination)

print(f"Generated {destination}: {value}")
PY
