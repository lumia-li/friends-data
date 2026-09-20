#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";

const DRY = process.env.DRY_RUN === "1";
const MANUAL = process.env.EVENT_NAME === "workflow_dispatch";
const BLOG_REPO = (process.env.BLOG_REPO || "lumia-li/liyueblog").trim();
const BLOG_BRANCH = (process.env.BLOG_BRANCH || "main").trim();
const SNAPSHOT_PATH = (process.env.SNAPSHOT_PATH || "src/data/friend-sync.json").trim();
const TOKEN = (process.env.BLOG_PUSH_TOKEN || "").trim();
const HOOK = (process.env.VERCEL_DEPLOY_HOOK || "").trim();
const DIRS = ["applications", "friends", "rejected"];

const git = (...args) => {
	try {
		return execFileSync("git", args, { encoding: "utf8" }).trim();
	} catch {
		return "";
	}
};

const readDisk = (p) => {
	try {
		return JSON.parse(fs.readFileSync(p, "utf8"));
	} catch {
		return undefined;
	}
};

const readBefore = (p) => {
	const before = (process.env.BEFORE_SHA || "").trim();
	if (!before || /^0+$/.test(before)) return undefined;
	const text = git("show", `${before}:${p}`);
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
};

const isFriendFile = (p) => DIRS.some((d) => p.startsWith(`data/${d}/`) && p.endsWith(".json"));

function changedFiles() {
	if (process.env.CHANGED_FILES) {
		return process.env.CHANGED_FILES.split("\n")
			.map((line) => {
				const [status, ...rest] = line.split("\t");
				return { status: (status || "").trim()[0] || "M", path: rest.join("\t").trim() };
			})
			.filter((x) => x.path);
	}

	const after = (process.env.AFTER_SHA || "HEAD").trim();
	let before = (process.env.BEFORE_SHA || "").trim();
	if (!before || /^0+$/.test(before)) before = git("rev-parse", `${after}~1`);

	const raw = before
		? git("diff", "--name-status", before, after)
		: git("show", "--name-status", "--format=", after);

	return raw
		.split("\n")
		.map((line) => {
			const parts = line.split("\t").map((s) => s.trim()).filter(Boolean);
			if (parts.length < 2) return null;
			// 重命名/复制会给出 R100 old new，取最后的（新）路径
			return { status: parts[0][0], path: parts[parts.length - 1] };
		})
		.filter(Boolean);
}

const bySlug = new Map();
for (const { status, path } of changedFiles()) {
	if (!isFriendFile(path)) continue;
	const slug = path.split("/").pop().replace(/\.json$/, "");
	const dir = path.split("/")[2];
	const now = status === "D" ? undefined : readDisk(path);
	const old = readBefore(path);
	const rec = { slug, dir, now, old, entry: now || old };

	const cur = bySlug.get(slug);
	bySlug.set(
		slug,
		cur
			? {
					...cur,
					now: now || cur.now,
					old: cur.old || old,
					dir: now ? dir : cur.dir,
					entry: now || cur.entry,
				}
			: rec,
	);
}

function label(rec) {
	const entry = rec.entry || {};
	const site = entry.name ? `${entry.name}（${entry.url || rec.slug}）` : entry.url || rec.slug;

	if (!rec.now) return `友链移除：${site}`;

	const now = String(rec.now.status || "").toLowerCase();
	const old = String(rec.old?.status || "").toLowerCase();

	if (now === "rejected") return `友链未通过：${site}`;
	if (now === "approved" || rec.dir === "friends") {
		return old === "approved" || old === "update" ? `友链信息更新：${site}` : `友链收录：${site}`;
	}
	if (now === "update") return `友链信息更新：${site}`;
	if (!rec.old) return `友链申请：${site}`;
	return `友链重新申请：${site}`;
}

const labels = [...bySlug.values()].map(label);
const message = MANUAL
	? "友链数据同步"
	: labels.length === 0
		? "友链数据同步"
		: labels.length === 1
			? labels[0]
			: `友链更新：${labels.length} 个站点（${[...bySlug.values()]
					.map((r) => (r.entry || {}).name || r.slug)
					.join("、")}）`;

function approvedFriends() {
	const out = [];
	for (const dir of ["friends", "applications"]) {
		let names = [];
		try {
			names = fs.readdirSync(`data/${dir}`);
		} catch {
			names = [];
		}
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const entry = readDisk(`data/${dir}/${name}`);
			if (!entry || !entry.url) continue;
			if (dir === "applications" && String(entry.status || "").toLowerCase() !== "approved") continue;
			out.push({
				name: entry.name || "",
				url: entry.url,
				avatar: entry.avatar || "",
				description: entry.description || "",
			});
		}
	}
	const seen = new Set();
	return out.filter((f) => {
		const key = f.url.replace(/\/+$/, "").toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

const friends = approvedFriends();
const snapshot = {
	syncedAt: new Date().toISOString(),
	source: "friends-data",
	lastChange: message,
	count: friends.length,
	friends,
};

async function pushSnapshot() {
	if (!TOKEN) return { ok: false, reason: "没配 BLOG_PUSH_TOKEN" };

	const headers = {
		Authorization: `Bearer ${TOKEN}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
		"User-Agent": "friend-sync",
	};
	const url = `https://api.github.com/repos/${BLOG_REPO}/contents/${SNAPSHOT_PATH}`;
	const current = await fetch(`${url}?ref=${BLOG_BRANCH}`, { headers });
	const sha = current.status === 200 ? (await current.json()).sha : undefined;

	const res = await fetch(url, {
		method: "PUT",
		headers,
		body: JSON.stringify({
			message,
			content: Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8").toString("base64"),
			branch: BLOG_BRANCH,
			...(sha ? { sha } : {}),
		}),
	});
	const detail = await res.json().catch(() => null);
	if (!res.ok) return { ok: false, reason: `GitHub ${res.status} ${detail?.message || ""}`.trim() };
	return { ok: true, commit: detail?.commit?.html_url || "" };
}

async function callHook() {
	if (!HOOK) return { ok: false, reason: "没配 VERCEL_DEPLOY_HOOK" };
	try {
		const res = await fetch(HOOK, { method: "POST" });
		const text = await res.text().catch(() => "");
		if (!res.ok) return { ok: false, reason: `HTTP ${res.status} ${text.slice(0, 120)}` };
		return { ok: true, text: text.slice(0, 120) };
	} catch (error) {
		return { ok: false, reason: error.message };
	}
}

console.log(`本次文案：${message}`);
console.log(`快照内容：${friends.length} 条已通过的友链`);

if (DRY) {
	console.log("DRY_RUN=1，不写入任何仓库。快照预览：");
	console.log(JSON.stringify(snapshot, null, 2));
	process.exit(0);
}

const pushed = await pushSnapshot();
if (pushed.ok) {
	console.log(`已写入 ${BLOG_REPO}/${SNAPSHOT_PATH}（提交即触发 Vercel 重新部署）`);
	console.log(`提交：${pushed.commit}`);
} else {
	console.log(`写入博客仓库失败：${pushed.reason}`);
	const hooked = await callHook();
	console.log(hooked.ok ? "已改用部署钩子触发重新部署（文案仍是旧的）" : `部署钩子也没成功：${hooked.reason}`);
	if (!hooked.ok) process.exit(1);
}
