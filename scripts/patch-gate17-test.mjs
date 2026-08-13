import { readFileSync, writeFileSync } from "node:fs";

const path = "C:\\Dev\\HuAIChatroomSystem\\apps\\bot-service\\test\\http-webhook-e2e.test.ts";
const oldText = [
  '    assert.equal(store.snapshot().outbox[0]?.target.kind, "local_gateway");',
  "    const payload = store.snapshot().outbox[0]?.payload as Record<string, unknown>;"
].join("\n");
const newText = [
  '    const gatewayOutbox = store.snapshot().outbox.find((item) => item.target.kind === "local_gateway");',
  '    assert.equal(gatewayOutbox?.target.kind, "local_gateway");',
  "    const payload = gatewayOutbox?.payload as Record<string, unknown>;"
].join("\n");

const source = readFileSync(path, "utf8");
if (!source.includes(oldText)) throw new Error("target text not found");
writeFileSync(path, source.replace(oldText, newText), "utf8");
