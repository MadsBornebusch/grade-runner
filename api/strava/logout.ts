import type { IncomingMessage, ServerResponse } from "node:http";
import { handleErrors, redirect } from "../_lib/http.ts";
import { clearedCookieHeaders } from "../_lib/session.ts";

export default handleErrors((_req: IncomingMessage, res: ServerResponse) => {
  redirect(res, "/", clearedCookieHeaders());
});
