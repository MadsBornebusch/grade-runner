import type { IncomingMessage, ServerResponse } from "node:http";
import { handleErrors, sendJson } from "../_lib/http.js";
import { getSession } from "../_lib/session.js";

export default handleErrors((req: IncomingMessage, res: ServerResponse) => {
  const session = getSession(req);
  sendJson(res, 200, session ? { connected: true, athleteName: session.athleteName } : { connected: false });
});
