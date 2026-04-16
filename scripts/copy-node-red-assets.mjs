import fs from "node:fs";
import path from "node:path";

const srcNodesDir = path.resolve("src", "nodes");
const distNodesDir = path.resolve("dist", "nodes");
const srcIconsDir = path.join(srcNodesDir, "icons");
const distIconsDir = path.join(distNodesDir, "icons");

fs.mkdirSync(distNodesDir, { recursive: true });

for (const entry of fs.readdirSync(srcNodesDir, { withFileTypes: true })) {
	if (entry.isFile() && entry.name.endsWith(".html")) {
		fs.copyFileSync(
			path.join(srcNodesDir, entry.name),
			path.join(distNodesDir, entry.name),
		);
	}
}

if (fs.existsSync(srcIconsDir)) {
	fs.mkdirSync(distIconsDir, { recursive: true });
	for (const entry of fs.readdirSync(srcIconsDir, { withFileTypes: true })) {
		if (entry.isFile()) {
			fs.copyFileSync(
				path.join(srcIconsDir, entry.name),
				path.join(distIconsDir, entry.name),
			);
		}
	}
}
