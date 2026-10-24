import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT = path.join(ROOT, "data/stats");

const USERNAME = "Master3307";
const TIMEZONE = "Europe/Berlin";

const WEEKS = 13;
const PROJECT_DAYS = 30;
const MAX_PROJECTS = 13;

const WIDTH = 720;
const PADDING = 24;

const TEXT_COLOR = "#8e58d4";
const TITLE_COLOR = "#dc8add";

const SECTION_GAP = 28;
const MIN_REPOSITORY_WIDTH = 320;

const token = process.env.GITHUB_TOKEN;

if (!token) {
  throw new Error("GITHUB_TOKEN is required.");
}

if (!Number.isInteger(WEEKS) || WEEKS < 1 || WEEKS > 52) {
  throw new Error("WEEKS must be an integer between 1 and 52.");
}

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character],
  );

function dateInTimezone(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );

  return `${values.year}-${values.month}-${values.day}`;
}

function shift(date, amount) {
  const result = new Date(`${date}T12:00:00Z`);
  result.setUTCDate(result.getUTCDate() + amount);
  return result.toISOString().slice(0, 10);
}

function weekday(date) {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

// Conservative width estimates for the configured sans-serif font.
// A clip path also prevents names from entering the count column.
function estimatedTextWidth(value, fontSize = 14) {
  return Array.from(String(value)).reduce((width, character) => {
    if (/[ilI1.,:;!'|]/.test(character)) {
      return width + fontSize * 0.34;
    }

    if (/[MW@#%&]/.test(character)) {
      return width + fontSize * 0.95;
    }

    return width + fontSize * 0.64;
  }, 0);
}

function clipToWidth(value, maximumWidth, fontSize = 14) {
  const original = String(value);

  if (estimatedTextWidth(original, fontSize) <= maximumWidth) {
    return original;
  }

  const characters = Array.from(original);

  while (
    characters.length &&
    estimatedTextWidth(`${characters.join("")}…`, fontSize) > maximumWidth
  ) {
    characters.pop();
  }

  return `${characters.join("")}…`;
}

async function graphql(query, variables) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "MrKoby07-profile-generator",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(60_000),
      });

      if (!response.ok) {
        const error = new Error(`GitHub returned HTTP ${response.status}`);

        error.retryable = response.status === 429 || response.status >= 500;

        throw error;
      }

      const result = await response.json();

      if (result.errors?.length || !result.data) {
        const error = new Error(
          "GitHub GraphQL query failed: " +
            (result.errors ?? []).map(({ message }) => message).join("; "),
        );

        error.retryable = false;
        throw error;
      }

      return result.data;
    } catch (error) {
      if (attempt === 2 || error.retryable === false) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000 * (attempt + 1)));
    }
  }
}

const now = new Date();
const today = dateInTimezone(now);
const monday = shift(today, -weekday(today));
const calendarStart = shift(monday, -(WEEKS - 1) * 7);
const projectStart = shift(today, -(PROJECT_DAYS - 1));

const data = await graphql(
  `
    query (
      $login: String!
      $calendarFrom: DateTime!
      $projectsFrom: DateTime!
      $to: DateTime!
    ) {
      user(login: $login) {
        id

        calendar: contributionsCollection(from: $calendarFrom, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
              }
            }
          }
        }

        recent: contributionsCollection(from: $projectsFrom, to: $to) {
          commitContributionsByRepository(maxRepositories: 100) {
            repository {
              owner {
                login
              }
              name
              nameWithOwner
              isPrivate
              url
            }

            contributions(first: 100) {
              nodes {
                occurredAt
              }
            }
          }
        }
      }
    }
  `,
  {
    login: USERNAME,
    calendarFrom: `${calendarStart}T00:00:00Z`,
    projectsFrom: `${projectStart}T00:00:00Z`,
    to: now.toISOString(),
  },
);

if (!data.user) {
  throw new Error(`GitHub user not found: ${USERNAME}`);
}

const user = data.user;
const days = {};

for (const week of user.calendar.contributionCalendar.weeks) {
  for (const day of week.contributionDays) {
    if (day.date >= calendarStart && day.date <= today) {
      days[day.date] = day.contributionCount;
    }
  }
}

const repositories = user.recent.commitContributionsByRepository
  .filter(({ repository }) => !repository.isPrivate)
  .map(({ repository, contributions }) => ({
    ...repository,
    lastActivity:
      contributions.nodes
        .map(({ occurredAt }) => occurredAt)
        .sort()
        .at(-1) ?? "",
  }))
  .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

// Fetch exact counts instead of summing a limited page of commits.
// No commit messages, hashes, or individual commit records are requested.
const projects = [];

for (const repository of repositories) {
  if (projects.length >= MAX_PROJECTS) {
    break;
  }

  const result = await graphql(
    `
      query (
        $owner: String!
        $name: String!
        $author: ID!
        $since: GitTimestamp!
        $until: GitTimestamp!
      ) {
        repository(owner: $owner, name: $name) {
          isPrivate

          defaultBranchRef {
            target {
              ... on Commit {
                history(
                  first: 1
                  author: { id: $author }
                  since: $since
                  until: $until
                ) {
                  totalCount
                }
              }
            }
          }
        }
      }
    `,
    {
      owner: repository.owner.login,
      name: repository.name,
      author: user.id,
      since: `${projectStart}T00:00:00Z`,
      until: now.toISOString(),
    },
  );

  if (result.repository?.isPrivate !== false) {
    throw new Error(
      `Cannot safely render repository details: ${repository.nameWithOwner}`,
    );
  }

  const history = result.repository.defaultBranchRef?.target?.history;

  if (!history || history.totalCount === 0) {
    continue;
  }

  projects.push({
    ...repository,
    count: history.totalCount,
  });
}

const colors = ["#8e58d4", "#49305f", "#70429a", "#a566c0", "#dc8add"];

function level(count) {
  if (count === 0) return 0;
  if (count < 3) return 1;
  if (count < 6) return 2;
  if (count < 10) return 3;
  return 4;
}

const fragments = [];
const definitions = [];

function text(x, y, value, attributes = "") {
  fragments.push(
    `<text x="${x}" y="${y}" ${attributes}>${escape(value)}</text>`,
  );
}

function linkedText(url, x, y, value, attributes = "", title = "") {
  fragments.push(
    `<a href="${escape(url)}">
      <text x="${x}" y="${y}" ${attributes}>
        ${title ? `<title>${escape(title)}</title>` : ""}
        ${escape(value)}
      </text>
    </a>`,
  );
}

function square(x, y, size, value, title, current = false) {
  fragments.push(
    `<rect
      x="${x}"
      y="${y}"
      width="${size}"
      height="${size}"
      rx="${Math.min(3, size / 4)}"
      fill="${colors[level(value)]}"
      fill-opacity="${value === 0 ? ".14" : "1"}"
      stroke="${current ? TITLE_COLOR : TEXT_COLOR}"
      stroke-opacity="${current ? "1" : ".18"}"
      stroke-width="${current ? "1.4" : ".6"}">
      <title>${escape(title)}</title>
    </rect>`,
  );
}

// Calendar layout

const gridX = 67;
const gridY = 94;
const availableGridWidth = WIDTH - PADDING - gridX;

const pitch = Math.min(21, Math.floor(availableGridWidth / WEEKS));

const cellSize = Math.min(15, pitch - 4);
const gridWidth = (WEEKS - 1) * pitch + cellSize;
const gridRight = gridX + gridWidth;
const gridBottom = gridY + 6 * pitch + cellSize;

// Include the legend and heading when calculating the left section width.

const legendSize = 15;
const legendPitch = 22;
const legendWidth = 188;

const gridCenterX = gridX + gridWidth / 2;
const legendX = gridCenterX - legendWidth / 2;

const legendY = gridBottom + 13;
const legendBottom = legendY + legendSize;

const activityRight = Math.max(gridRight, legendX + legendWidth, PADDING + 200);

const sideRepositoryX = activityRight + SECTION_GAP;
const sideRepositoryWidth = WIDTH - PADDING - sideRepositoryX;

const repositoriesBeside = sideRepositoryWidth >= MIN_REPOSITORY_WIDTH;

const repositoryX = repositoriesBeside ? sideRepositoryX : PADDING;

const repositoryRight = WIDTH - PADDING;
const repositoryWidth = repositoryRight - repositoryX;

const repositoryHeadingY = repositoriesBeside ? 31 : legendBottom + 42;

// Activity header

text(PADDING, 31, "Recent Activity", 'class="heading"');

text(PADDING, 55, `Last ${WEEKS} weeks`, 'class="muted"');

// Calendar cells and month labels

let previousMonth = "";
let lastMonthLabelX = -Infinity;

for (let week = 0; week < WEEKS; week++) {
  const weekStart = shift(calendarStart, week * 7);
  const month = weekStart.slice(0, 7);
  const monthX = gridX + week * pitch;

  if (month !== previousMonth) {
    const label = new Intl.DateTimeFormat("en", {
      month: "short",
      timeZone: "UTC",
    }).format(new Date(`${weekStart}T12:00:00Z`));

    if (monthX - lastMonthLabelX >= 34) {
      text(monthX, gridY - 13, label, 'class="small"');

      lastMonthLabelX = monthX;
    }

    if (week > 0) {
      fragments.push(
        `<path
          d="M ${monthX - 3} ${gridY - 3} V ${gridBottom + 3}"
          stroke="${TEXT_COLOR}"
          stroke-opacity=".13"
          stroke-dasharray="2 4"
          fill="none"/>`,
      );
    }

    previousMonth = month;
  }

  for (let row = 0; row < 7; row++) {
    const date = shift(weekStart, row);

    if (date > today) {
      continue;
    }

    const x = gridX + week * pitch;
    const y = gridY + row * pitch;
    const count = days[date];

    if (count === undefined) {
      fragments.push(
        `<rect
          x="${x}"
          y="${y}"
          width="${cellSize}"
          height="${cellSize}"
          rx="${Math.min(3, cellSize / 4)}"
          fill="none"
          stroke="${TEXT_COLOR}"
          stroke-opacity=".4"
          stroke-dasharray="2 2">
          <title>${date}: unavailable</title>
        </rect>`,
      );

      continue;
    }

    square(
      x,
      y,
      cellSize,
      count,
      `${date}: ${count} contributions${
        date === today ? "・today, incomplete" : ""
      }`,
      date === today,
    );
  }
}

[
  ["Mon", 0],
  ["Wed", 2],
  ["Fri", 4],
  ["Sun", 6],
].forEach(([label, row]) => {
  text(PADDING, gridY + row * pitch + cellSize - 2, label, 'class="small"');
});

// Heatmap legend, directly beneath the grid

text(legendX, legendY + 11, "Less", 'class="small"');

[0, 1, 3, 6, 10].forEach((value, index) => {
  const labels = {
    0: "0 contributions",
    1: "1–2 contributions",
    3: "3–5 contributions",
    6: "6–9 contributions",
    10: "10 or more contributions",
  };

  square(
    legendX + 39 + index * legendPitch,
    legendY,
    legendSize,
    value,
    labels[value],
  );
});

text(legendX + 158, legendY + 11, "More", 'class="small"');

// Recent repositories: beside the calendar only when enough width exists.

text(repositoryX, repositoryHeadingY, "Recent Repositories", 'class="heading"');

text(
  repositoryX,
  repositoryHeadingY + 23,
  `Last ${PROJECT_DAYS} days`,
  'class="muted"',
);

let cursor = repositoryHeadingY + 57;

const countLabels = projects.map(
  (project) => `${project.count} ${project.count === 1 ? "commit" : "commits"}`,
);

const countWidth = Math.max(
  85,
  ...countLabels.map((label) => estimatedTextWidth(label)),
);

const countGap = 18;
const repositoryNameWidth = Math.max(
  30,
  repositoryWidth - countWidth - countGap,
);

projects.forEach((project, index) => {
  const clipId = `repository-name-${index}`;

  definitions.push(
    `<clipPath id="${clipId}">
      <rect
        x="${repositoryX}"
        y="${cursor - 19}"
        width="${repositoryNameWidth}"
        height="27"/>
    </clipPath>`,
  );

  linkedText(
    project.url,
    repositoryX,
    cursor,
    clipToWidth(project.nameWithOwner, repositoryNameWidth),
    `class="repo" clip-path="url(#${clipId})"`,
    project.nameWithOwner,
  );

  text(repositoryRight, cursor, countLabels[index], 'text-anchor="end"');

  cursor += 32;
});

if (projects.length === 0) {
  text(
    repositoryX,
    cursor,
    repositoriesBeside
      ? "No matching public commits in this period."
      : "No matching public repository commits in this period.",
    'class="muted"',
  );

  cursor += 32;
}

const height = Math.max(legendBottom + PADDING, cursor + 8);

const style = `
  text {
    font-family: "Segoe UI", Ubuntu, Arial, sans-serif;
    font-size: 14px;
    font-weight: 400;
    fill: ${TEXT_COLOR};
  }

  .heading {
    font-size: 20px;
    fill: ${TITLE_COLOR};
  }

  .repo {
    font-size: 14px;
    fill: ${TITLE_COLOR};
  }

  .muted {
    font-size: 13px;
    fill-opacity: .9;
  }

  .small {
    font-size: 11px;
    fill-opacity: .85;
  }

  .content {
    animation: appear 1.3s ease-out both;
  }

  @keyframes appear {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .content {
      animation: none;
    }
  }
`;

const recentSvg = `<svg xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="${height}"
  viewBox="0 0 ${WIDTH} ${height}"
  role="img"
  aria-labelledby="title description">
  <title id="title">Recent GitHub activity</title>
  <desc id="description">
    A ${WEEKS}-week contribution heatmap and recent public
    repositories with exact counts of your commits in their current
    default-branch histories over the last ${PROJECT_DAYS} days.
    Today is incomplete. Calendar dates follow GitHub contribution buckets.
  </desc>
  <defs>
    ${definitions.join("\n")}
  </defs>
  <style>${style}</style>
  <g class="content">
    ${fragments.join("\n")}
  </g>
</svg>`;

// Separate generation timestamp

const stampDate = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIMEZONE,
  day: "2-digit",
  month: "long",
  year: "numeric",
}).format(now);

const stampTime = new Intl.DateTimeFormat("de-DE", {
  timeZone: TIMEZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
  timeZoneName: "short",
})
  .formatToParts(now)
  .map(({ type, value }) => {
    if (type === "timeZoneName") {
      return (
        {
          MEZ: "CET",
          MESZ: "CEST",
        }[value] ?? value
      );
    }

    return value;
  })
  .join("");

const stampValue = `${stampDate}・${stampTime}`;

const updatedSvg = `<svg xmlns="http://www.w3.org/2000/svg"
  width="${WIDTH}"
  height="75"
  viewBox="0 0 ${WIDTH} 75"
  role="img"
  aria-labelledby="title">
  <title id="title">
    Last updated: ${escape(stampValue)}・${TIMEZONE}
  </title>
  <style>
    text {
      font-family: "Segoe UI", Ubuntu, Arial, sans-serif;
      text-anchor: middle;
      font-weight: 400;
    }
  </style>
  <text
    x="${WIDTH / 2}"
    y="23"
    fill="${TITLE_COLOR}"
    font-size="15">
    Last updated
  </text>
  <text
    x="${WIDTH / 2}"
    y="47"
    fill="${TEXT_COLOR}"
    font-size="15">
    ${escape(stampValue)}
  </text>
  <text
    x="${WIDTH / 2}"
    y="65"
    fill="${TEXT_COLOR}"
    font-size="11">
    ${TIMEZONE}
  </text>
</svg>`;

// Write generated files

await fs.mkdir(OUTPUT, { recursive: true });

for (const [filename, contents] of [
  ["recent.svg", recentSvg],
  ["updated.svg", updatedSvg],
]) {
  const destination = path.join(OUTPUT, filename);

  await fs.writeFile(`${destination}.tmp`, contents);
  await fs.rename(`${destination}.tmp`, destination);

  console.log(`Generated data/stats/${filename}`);
}

console.log(
  `Recent repositories layout: ${
    repositoriesBeside ? "beside heatmap" : "below heatmap"
  }`,
);
