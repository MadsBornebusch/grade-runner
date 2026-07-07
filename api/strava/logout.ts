import type { IncomingMessage, ServerResponse } from "node:http";
import { handleErrors, redirect } from "../_lib/http.js";
import { clearedCookieHeaders } from "../_lib/session.js";

export default handleErrors((_req: IncomingMessage, res: ServerResponse) => {
  redirect(res, "/", clearedCookieHeaders());
});
