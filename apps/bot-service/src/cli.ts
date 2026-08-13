import { startBotServiceFromEnv } from "./server.js";

const server = await startBotServiceFromEnv();
console.log(`bot-service listening on 127.0.0.1:${server.port}`);

process.once("SIGINT", () => {
  void server.close().then(() => process.exit(0));
});

process.once("SIGTERM", () => {
  void server.close().then(() => process.exit(0));
});
