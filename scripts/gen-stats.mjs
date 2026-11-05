#!/usr/bin/env node
/**
 * 生成 "Pinero's GitHub Stats" 卡片（浅色 / 深色两张 SVG）。
 *
 * 为什么不用 github-readme-stats 的公共实例：
 *   它的 Vercel 部署会挂（2026-11 查到的就是 DEPLOYMENT_PAUSED，503），
 *   挂掉后主页全是裂图。这里改成自己算、自己画，只依赖 GitHub 自己的 API。
 *
 * 数据来源：
 *   - GraphQL（GITHUB_TOKEN 可读公开数据）：贡献、PR、Issue、参与仓库、粉丝
 *   - REST /users/{login}/repos：星标（GraphQL 拿不到时兜底，不需要额外 PAT）
 *
 * 环境变量：
 *   GITHUB_TOKEN  仓库 Actions 自带的令牌即可
 *   GITHUB_LOGIN  默认 2310770803
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOGIN = process.env.GITHUB_LOGIN || "2310770803";
const TOKEN = process.env.GITHUB_TOKEN || "";
const API = "https://api.github.com";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(ROOT, "assets/stats");

function headers(auth = true) {
  const h = {
    accept: "application/vnd.github+json",
    "user-agent": "pinero-profile-stats",
    "x-github-api-version": "2022-11-28",
  };
  if (auth && TOKEN) h.authorization = `bearer ${TOKEN}`;
  return h;
}

async function rest(path, auth = true) {
  const res = await fetch(`${API}${path}`, { headers: headers(auth) });
  if (!res.ok) throw new Error(`REST ${path} -> ${res.status}`);
  return res.json();
}

async function graphql(query, variables) {
  const res = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`GraphQL -> ${res.status}`);
  if (Array.isArray(payload.errors) && payload.errors.length) {
    console.warn("GraphQL partial errors:", payload.errors.map((e) => e.message).join(" | "));
  }
  return payload.data;
}

async function collect() {
  const stats = { stars: 0, commits: 0, prs: 0, issues: 0, reviews: 0, contributed: 0, followers: 0 };

  try {
    const data = await graphql(
      `query ($login: String!) {
        user(login: $login) {
          followers { totalCount }
          pullRequests { totalCount }
          issues { totalCount }
          repositoriesContributedTo(first: 1) { totalCount }
          contributionsCollection {
            totalCommitContributions
            totalPullRequestReviewContributions
          }
          repositories(first: 100, ownerAffiliations: [OWNER], isFork: false) {
            nodes { stargazerCount }
          }
        }
      }`,
      { login: LOGIN }
    );
    const u = data?.user;
    if (u) {
      stats.followers = u.followers?.totalCount ?? 0;
      stats.prs = u.pullRequests?.totalCount ?? 0;
      stats.issues = u.issues?.totalCount ?? 0;
      stats.contributed = u.repositoriesContributedTo?.totalCount ?? 0;
      stats.commits = u.contributionsCollection?.totalCommitContributions ?? 0;
      stats.reviews = u.contributionsCollection?.totalPullRequestReviewContributions ?? 0;
      stats.stars = (u.repositories?.nodes ?? []).reduce(
        (sum, repo) => sum + (repo?.stargazerCount || 0),
        0
      );
    }
  } catch (err) {
    console.warn("GraphQL 失败，改用 REST 兜底：", err.message);
  }

  // 星标：GraphQL 只装了当前仓库的应用令牌可能读不到其它仓库，REST 公开接口兜底
  if (!stats.stars) {
    for (const auth of [true, false]) {
      try {
        const repos = await rest(`/users/${LOGIN}/repos?per_page=100&type=owner`, auth);
        stats.stars = repos
          .filter((repo) => !repo.fork)
          .reduce((sum, repo) => sum + (repo.stargazers_count || 0), 0);
        break;
      } catch (err) {
        console.warn(`REST 星标（${auth ? "带令牌" : "匿名"}）失败：`, err.message);
      }
    }
  }

  if (!stats.followers) {
    try {
      stats.followers = (await rest(`/users/${LOGIN}`)).followers ?? 0;
    } catch (err) {
      console.warn("REST 粉丝数失败：", err.message);
    }
  }

  return stats;
}

// 排名算法来自 github-readme-stats（MIT）：指数 CDF + 对数正态 CDF
// 新用户是 C，中位用户是 B+，活跃用户能到 A/A-
function exponentialCdf(x) {
  return 1 - 2 ** -x;
}

function logNormalCdf(x) {
  return x / (1 + x);
}

function rankOf({ commits, prs, issues, reviews, stars, followers }) {
  const COMMITS_MEDIAN = 250, COMMITS_WEIGHT = 2;
  const PRS_MEDIAN = 50, PRS_WEIGHT = 3;
  const ISSUES_MEDIAN = 25, ISSUES_WEIGHT = 1;
  const REVIEWS_MEDIAN = 2, REVIEWS_WEIGHT = 1;
  const STARS_MEDIAN = 50, STARS_WEIGHT = 4;
  const FOLLOWERS_MEDIAN = 10, FOLLOWERS_WEIGHT = 1;
  const TOTAL_WEIGHT = 11;

  const THRESHOLDS = [1, 12.5, 25, 37.5, 50, 62.5, 75, 87.5, 100];
  const LEVELS = ["S", "A+", "A", "A-", "B+", "B", "B-", "C+", "C"];

  const rank =
    1 -
    (COMMITS_WEIGHT * exponentialCdf(commits / COMMITS_MEDIAN) +
      PRS_WEIGHT * exponentialCdf(prs / PRS_MEDIAN) +
      ISSUES_WEIGHT * exponentialCdf(issues / ISSUES_MEDIAN) +
      REVIEWS_WEIGHT * exponentialCdf(reviews / REVIEWS_MEDIAN) +
      STARS_WEIGHT * logNormalCdf(stars / STARS_MEDIAN) +
      FOLLOWERS_WEIGHT * logNormalCdf(followers / FOLLOWERS_MEDIAN)) /
      TOTAL_WEIGHT;

  const level = LEVELS[THRESHOLDS.findIndex((t) => rank * 100 <= t)] ?? "C";
  return { grade: level, percent: Math.min(Math.max(rank, 0.02), 1) };
}

const fmt = (n) =>
  n >= 1000000 ? `${(n / 1000000).toFixed(1)}m` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;

const ICONS = {
  star: "M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.751.751 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z",
  commit:
    "M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z",
  pr: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
  issue:
    "M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z",
  repo: "M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8ZM5 12.25a.25.25 0 0 1 .25-.25h3.5a.25.25 0 0 1 .25.25v3.25a.25.25 0 0 1-.4.2l-1.45-1.087a.249.249 0 0 0-.3 0L5.4 15.7a.25.25 0 0 1-.4-.2Z",
};

const THEMES = {
  light: {
    bg: "#ffffff",
    border: "#e4e4e7",
    title: "#2f80ed",
    text: "#434d58",
    icon: "#2f80ed",
    track: "#e4e4e7",
    arc: "#2f80ed",
  },
  dark: {
    bg: "#0d1117",
    border: "#30363d",
    title: "#58a6ff",
    text: "#c9d1d9",
    icon: "#58a6ff",
    track: "#30363d",
    arc: "#58a6ff",
  },
};

const W = 495;
const H = 195;
const RING_R = 40;
const RING_CIRC = 2 * Math.PI * RING_R;

function render(stats, themeName) {
  const theme = THEMES[themeName];
  const { grade, percent } = rankOf(stats);
  const rows = [
    ["star", "Total Stars Earned:", fmt(stats.stars)],
    ["commit", "Total Commits:", fmt(stats.commits)],
    ["pr", "Total PRs:", fmt(stats.prs)],
    ["issue", "Total Issues:", fmt(stats.issues)],
    ["repo", "Contributed to (last year):", fmt(stats.contributed)],
  ];

  const rowsSvg = rows
    .map(([icon, label, value], i) => {
      const y = 72 + i * 27;
      return `  <g transform="translate(25 ${y - 13})" fill="${theme.icon}">
    <path d="${ICONS[icon]}" />
  </g>
  <text x="50" y="${y}" class="label">${label}</text>
  <text x="300" y="${y}" class="value">${value}</text>`;
    })
    .join("\n");

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Pinero's GitHub Stats">
  <style>
    .title { font: 600 18px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; fill: ${theme.title}; }
    .label { font: 400 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; fill: ${theme.text}; }
    .value { font: 700 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; fill: ${theme.text}; }
    .grade { font: 700 26px -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif; fill: ${theme.title}; }
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="6" fill="${theme.bg}" stroke="${theme.border}" />
  <text x="25" y="35" class="title">Pinero's GitHub Stats</text>
${rowsSvg}
  <g transform="translate(430 100)">
    <circle r="${RING_R}" stroke="${theme.track}" stroke-width="8" />
    <circle r="${RING_R}" stroke="${theme.arc}" stroke-width="8" stroke-linecap="round"
      stroke-dasharray="${RING_CIRC.toFixed(2)}"
      stroke-dashoffset="${(RING_CIRC * (1 - percent)).toFixed(2)}"
      transform="rotate(-90)" />
    <text class="grade" text-anchor="middle" dominant-baseline="central">${grade}</text>
  </g>
</svg>
`;
}

async function main() {
  const stats = await collect();
  console.log("stats:", stats);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(resolve(OUT_DIR, "stats-light.svg"), render(stats, "light"), "utf8");
  await writeFile(resolve(OUT_DIR, "stats-dark.svg"), render(stats, "dark"), "utf8");
  console.log("已写入 assets/stats/stats-{light,dark}.svg");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
