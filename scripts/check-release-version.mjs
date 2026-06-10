import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"));
const expectedTag = `v${manifest.version}`;
const actualTag = process.env.GITHUB_REF_NAME ?? process.argv[2];

if (!actualTag) {
  console.error("Release tag is missing. Set GITHUB_REF_NAME or pass the tag as the first argument.");
  process.exit(1);
}

if (actualTag !== expectedTag) {
  console.error(`Release tag ${actualTag} does not match package.json version ${manifest.version}. Expected ${expectedTag}.`);
  process.exit(1);
}

console.log(`Release tag ${actualTag} matches package.json version ${manifest.version}.`);
