/**
 * Package metadata and documentation that regress silently: what npm and the
 * π catalog show, what the README promises, what trusted publishing needs, and
 * what search engines, language models and OpenSSF tools read: the landing
 * site, llms.txt, the bundled skill, Security Insights and the Best Practices
 * answers.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, DEFAULT_EXCLUDES, parseConfig } from "../config.ts";
import { failureNotice, repeatBlocked, repeatNotice } from "../guard/loop.ts";
import { pending } from "../scripts/changelog.ts";

const root = resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const pkg = JSON.parse(read("package.json"));
const readme = read("README.md").replaceAll("\\|", "|"); // pipes are escaped inside markdown tables

const SITE = "https://jlrrequina.github.io/pi-edit-guard/";
const RAW = "https://raw.githubusercontent.com/jlrrequina/pi-edit-guard/main/";
const COMMANDS = ["/undo", "/undo <n>", "/undo pre-undo-<k>", "--yes", "/checkpoints", "/guard", "/guard on", "/guard freshness on|off", "/guard snapshots on|off", "/guard loop on|off"];
const MESSAGES = [repeatBlocked(3), repeatNotice(3), failureNotice(2), "exists but was not read in this context. Read it, then retry.", "changed since you read it (call #12). Read it again, then retry."];
const CONFIG_KEYS = Object.keys(parseConfig({}).config);

/** Repository paths that links into this repository (blob or raw, on main) point at. */
function repoPaths(text: string): string[] {
  const into = { "github.com": "/jlrrequina/pi-edit-guard/blob/main/", "raw.githubusercontent.com": "/jlrrequina/pi-edit-guard/main/" } as Record<string, string>;
  const out: string[] = [];
  for (const [href] of text.matchAll(/https:\/\/[^\s)"'<>`]+/g)) {
    const url = new URL(href);
    const prefix = into[url.host];
    if (prefix && url.pathname.startsWith(prefix)) out.push(url.pathname.slice(prefix.length));
  }
  return out;
}

// Text without markup, to compare one answer written in markdown, HTML and JSON-LD.
const words = (s: string) => s.replace(/\s+/g, " ").trim();
const fromMarkdown = (s: string) => words(s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replaceAll("`", ""));
// split/join, not replace: CodeQL reads a tag-stripping replace as an incomplete HTML sanitizer. This only reads our own page.
const fromHtml = (s: string) => words(s.split(/<[^>]*>/).join("").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&"));

type Faq = { q: string; a: string }[];

function readmeFaq(): Faq {
  const section = readme.split("\n## FAQ\n")[1]!.split("\n## ")[0]!;
  return section
    .split("\n### ")
    .slice(1)
    .map((block) => {
      const [q, ...rest] = block.split("\n");
      return { q: fromMarkdown(q!), a: fromMarkdown(rest.join(" ")) };
    });
}

test("package.json: description within npm's limit, catalog keyword, manifest and published files exist", () => {
  assert.ok(pkg.description.length <= 250, `description is ${pkg.description.length} chars`);
  assert.match(pkg.description, /^Pi \(\u03c0\) coding-agent extension: .*\.$/);
  assert.ok(pkg.keywords.includes("pi-package"), "pi-package makes the package eligible for the π catalog");
  assert.equal(new Set(pkg.keywords).size, pkg.keywords.length);
  for (const k of pkg.keywords) assert.match(k, /^[a-z0-9.-]+$/);
  for (const p of [...pkg.pi.extensions, ...pkg.pi.skills]) {
    assert.ok(existsSync(join(root, p)), p);
    const rel = p.replace(/^\.\//, "");
    assert.ok(pkg.files.some((f: string) => f === rel || f === `${rel}/` || (f.endsWith("/") && rel.startsWith(f))), `${p} is in "files", so π can load it from the npm package`);
  }
  assert.equal(pkg.pi.image, `${RAW}docs/cover.png`, "the catalog image is the cover in this repository");
  assert.equal(pkg.homepage, SITE);
  for (const f of pkg.files) assert.ok(existsSync(join(root, f)), `${f} is published and exists`);
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], "no runtime dependencies");
  assert.match(pkg.peerDependencies["@earendil-works/pi-coding-agent"], /^>=1\.2\.0$/);
});

test("trusted publishing: repository.url, the workflow's repository guard and the npm environment agree", () => {
  assert.equal(pkg.repository.url, "git+https://github.com/jlrrequina/pi-edit-guard.git");
  const release = read(".github/workflows/release.yml");
  assert.equal(release.match(/github\.repository == 'jlrrequina\/pi-edit-guard'/g)?.length, 2);
  assert.match(release, /environment:\n\s+name: npm/);
  assert.match(release, /id-token: write/);
  assert.match(release, /npm publish "\.\/\$FILE" --provenance --access public/);
});

test("CHANGELOG.md: the Unreleased heading parses, so a push to main can release", () => {
  const p = pending(read("CHANGELOG.md"));
  assert.ok(p, 'CHANGELOG.md has a "## Unreleased" section');
});

test("README: install command first, every command, config key, default list and message documented", () => {
  assert.ok(readme.startsWith("# pi-edit-guard\n"));
  assert.ok(readme.indexOf("pi install npm:@lenard9191/pi-edit-guard") < 1500, "install command above the fold");
  for (const c of COMMANDS) assert.ok(readme.includes(c), `README documents ${c}`);
  for (const k of CONFIG_KEYS) assert.ok(readme.includes(`\`${k}\``), `README documents config key ${k}`);
  for (const t of [...DEFAULTS.readOnlyTools, ...DEFAULTS.volatileTools, ...DEFAULT_EXCLUDES]) assert.ok(readme.includes(`\`${t}\``), `README lists the default ${t}`);
  for (const m of MESSAGES) assert.ok(readme.includes(m), `README shows: ${m}`);
  for (const s of ["## Decided out", "## Secrets", "## Coverage", "PI_EDIT_GUARD_DEBUG=1"]) assert.ok(readme.includes(s), s);
  assert.ok(!readme.includes("PERFORMANCE_TABLE"), "the measured table is filled in");
});

test("README: badges, cover, FAQ and links; a relative link points only at a published file", () => {
  const badges = new Map([...readme.matchAll(/^\[!\[([^\]]+)\]\(([^)]+)\)\]\(([^)]+)\)$/gm)].map((m) => [m[1]!, { image: new URL(m[2]!), link: m[3]! }]));
  assert.deepEqual([...badges.keys()], ["npm version", "npm downloads", "π package", "CI", "OpenSSF Scorecard", "license"]);
  assert.equal(badges.get("π package")!.link, "https://pi.dev/packages/@lenard9191/pi-edit-guard");
  assert.equal(badges.get("OpenSSF Scorecard")!.image.href, "https://api.scorecard.dev/projects/github.com/jlrrequina/pi-edit-guard/badge");
  // ci.yml runs on pull requests; on main, CI runs inside the Release workflow, so its status is the one to show.
  const ci = badges.get("CI")!.image;
  assert.deepEqual([ci.host, ci.pathname, ci.searchParams.get("branch")], ["img.shields.io", "/github/actions/workflow/status/jlrrequina/pi-edit-guard/release.yml", "main"]);
  assert.ok(readme.includes(`](${pkg.pi.image})`), "the README shows the catalog image");
  assert.ok(readme.includes(SITE) && readme.includes("(llms.txt)") && readme.includes("/skill:edit-guard"));
  assert.ok(readmeFaq().length >= 5, "an FAQ");
  // npm resolves relative links against the repository, but the π catalog resolves them against the published
  // tarball (cdn.jsdelivr.net/npm/<package>@<version>/...): a file outside "files" is a broken link there.
  const relative = [...readme.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1]!).filter((href) => !/^[a-z]+:/.test(href));
  assert.ok(relative.length > 0);
  for (const href of relative) assert.ok(pkg.files.some((f: string) => href === f || (f.endsWith("/") && href.startsWith(f))), `${href} is published (or link it absolutely)`);
});

test("skill: π's loader accepts it, and it documents every command, message and config key that exists", () => {
  const { skills, diagnostics } = loadSkillsFromDir({ dir: join(root, "skills"), source: "test" });
  assert.deepEqual(diagnostics, []);
  assert.deepEqual(
    skills.map((s) => s.name),
    ["edit-guard"],
    "one skill, named like its directory",
  );
  const description = skills[0]!.description;
  assert.ok(description.length <= 1024, `description is ${description.length} chars`);
  assert.match(description, /\bUse when\b/, "the description says when to load it");
  const src = read("skills/edit-guard/SKILL.md").replaceAll("\\|", "|");
  assert.ok(src.split("\n").length <= 500, "SKILL.md stays small: all of it loads on activation");
  assert.ok(src.match(/^compatibility: (.*)$/m)![1]!.length <= 500);
  for (const c of COMMANDS) assert.ok(src.includes(c), `the skill documents ${c}`);
  for (const m of MESSAGES) assert.ok(src.includes(m), `the skill explains: ${m}`);
  for (const k of CONFIG_KEYS) assert.ok(src.includes(`\`${k}\``), `the skill documents config key ${k}`);
});

test("llms.txt: the llmstxt.org structure, and its links into this repository resolve", () => {
  const txt = read("llms.txt");
  const lines = txt.split("\n");
  assert.equal(lines[0], "# pi-edit-guard", "an H1 with the name");
  assert.ok(lines[2]!.startsWith("> "), "a blockquote summary after the H1");
  assert.ok(txt.includes("pi install npm:@lenard9191/pi-edit-guard"));
  assert.deepEqual(
    [...txt.matchAll(/^## (.*)$/gm)].map((m) => m[1]),
    ["Documentation", "Contributing and security", "Optional"],
  );
  const paths = repoPaths(txt);
  for (const f of ["README.md", "skills/edit-guard/SKILL.md", "CHANGELOG.md", "SECURITY.md"]) assert.ok(paths.includes(f), `llms.txt links ${f}`);
});

test("site: landing page, sitemap and Pages workflow agree; the FAQ is the same in the page, its structured data and the README", () => {
  const html = read("docs/site/index.html");
  const graph = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)![1]!)["@graph"];
  assert.deepEqual(
    graph.map((n: { "@type": string }) => n["@type"]),
    ["SoftwareApplication", "SoftwareSourceCode", "FAQPage"],
  );
  const faq = html.split('<section id="faq">')[1]!.split("</section>")[0]!;
  const visible: Faq = [...faq.matchAll(/<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)].map((m) => ({ q: fromHtml(m[1]!), a: fromHtml(m[2]!) }));
  const structured: Faq = graph[2].mainEntity.map((e: { name: string; acceptedAnswer: { text: string } }) => ({ q: words(e.name), a: words(e.acceptedAnswer.text) }));
  assert.deepEqual(structured, visible, "structured data mirrors the visible FAQ");
  assert.deepEqual(readmeFaq(), visible, "the README FAQ and the site FAQ are the same");
  const title = html.match(/<title>(.*?)<\/title>/)![1]!;
  const description = html.match(/name="description" content="(.*?)"/)![1]!;
  assert.ok(title.length <= 70, `title is ${title.length} chars`);
  assert.ok(description.length <= 160, `meta description is ${description.length} chars`);
  assert.equal(html.match(/rel="canonical" href="(.*?)"/)![1], SITE);
  assert.ok(html.includes(`<meta property="og:image" content="${SITE}cover.png">`));
  assert.ok(read("docs/site/sitemap.xml").includes(`<loc>${SITE}</loc>`));
  assert.ok(html.includes(`rel="sitemap" type="application/xml" href="${SITE}sitemap.xml"`), "the page links its sitemap (a project site cannot serve the host's robots.txt)");
  // Every relative reference on the page is a file that the Pages workflow copies into the artifact.
  const copied = read(".github/workflows/pages.yml").match(/^\s*cp (.+) _site\/$/m)![1]!.split(/\s+/);
  for (const ref of new Set([...html.matchAll(/(?:href|src)="([^"#:]+)"/g)].map((m) => m[1]!))) assert.ok(copied.some((c) => c.split("/").pop() === ref), `${ref} is copied by the Pages workflow`);
  for (const f of ["docs/site/index.html", "docs/site/sitemap.xml", "docs/cover.png", "llms.txt"]) assert.ok(copied.includes(f) && existsSync(join(root, f)), `${f} exists and is published`);
  const png = readFileSync(join(root, "docs/cover.png"));
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [2560, 1280], "the cover is 1280×640 at 2x (the og:image and catalog ratio)");
});

test("OpenSSF: Best Practices answers and Security Insights are well-formed, and every link into this repository resolves", () => {
  const answers: Record<string, string> = JSON.parse(read(".bestpractices.json"));
  for (const [key, value] of Object.entries(answers)) {
    const m = key.match(/^([a-z0-9_]+)_(status|justification)$/);
    assert.ok(m, `${key} is a criterion field`);
    if (m[2] === "status") {
      assert.ok(["Met", "Unmet", "N/A"].includes(value), `${key}: ${value}`);
      assert.ok(answers[`${m[1]}_justification`], `${m[1]} has a justification`);
    } else assert.ok(answers[`${m[1]}_status`], `${key} belongs to a status`);
  }
  const insights = read(".github/security-insights.yml");
  assert.match(insights, /^ {2}schema-version: 2\.\d+\.\d+$/m);
  assert.match(insights, /^ {2}last-reviewed: '\d{4}-\d{2}-\d{2}'$/m);
  assert.ok(insights.includes(`  url: ${RAW}.github/security-insights.yml`), "header.url is the raw URL of the file itself");
  for (const [file, text] of [
    ["README.md", readme],
    ["llms.txt", read("llms.txt")],
    ["docs/site/index.html", read("docs/site/index.html")],
    ["skills/edit-guard/SKILL.md", read("skills/edit-guard/SKILL.md")],
    [".bestpractices.json", read(".bestpractices.json")],
    [".github/security-insights.yml", insights],
  ] as const) {
    for (const p of repoPaths(text)) assert.ok(existsSync(join(root, p)), `${file} links ${p}, which exists`);
  }
});
