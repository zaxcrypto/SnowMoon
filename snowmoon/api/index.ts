import type { IncomingMessage, ServerResponse } from "node:http";
import { createSnowMoonApp } from "../src/server.ts";

const app = createSnowMoonApp();

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app.server.emit("request", req, res);
}

