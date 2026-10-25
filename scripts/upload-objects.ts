// Uploads farm data and label rules to SeaweedFS bucket `lotline` under prefix `spraywindow/`.
// Zetaris is already configured for that bucket; do not create a new bucket.
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env, need } from "../src/env.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const s3 = new S3Client({
  endpoint: need("S3_ENDPOINT"),
  region: "us-east-1",
  credentials: { accessKeyId: need("S3_ACCESS_KEY"), secretAccessKey: need("S3_SECRET_KEY") },
  forcePathStyle: true,
});

const BUCKET = "lotline";
const PREFIX = "spraywindow/";

async function uploadFile(localPath: string, key: string, asJsonArray = false) {
  // Zetaris reads a JSON file as one document, so JSON Lines go up as a JSON array.
  const text = readFileSync(localPath, "utf8");
  const body = asJsonArray ? JSON.stringify(text.split("\n").filter(Boolean).map(l => JSON.parse(l))) : text;
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body }));
  console.log(`Uploaded ${localPath} -> s3://${BUCKET}/${key}`);
}

async function main() {
  // Upload label rules CSV
  await uploadFile(path.join(ROOT, "data", "sources", "label_rules.csv"), `${PREFIX}label_rules.csv`);

  // Upload farm JSONL files
  const sourcesDir = path.join(ROOT, "data", "sources");
  for (const file of readdirSync(sourcesDir).filter(f => f.endsWith(".jsonl"))) {
    await uploadFile(path.join(sourcesDir, file), `${PREFIX}${file}`);
  }

  // Upload weather snapshot
  const snapshotDir = path.join(ROOT, "data", "snapshot");
  if (existsSync(snapshotDir)) {
    for (const file of readdirSync(snapshotDir).filter(f => f.endsWith(".jsonl"))) {
      await uploadFile(path.join(snapshotDir, file), `${PREFIX}${file}`, true);
    }
  }

  console.log("All objects uploaded to SeaweedFS");
}


main().catch(e => { console.error(e); process.exit(1); });