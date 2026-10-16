import {
  errorResponse,
  getSessionId,
  jsonResponse,
  makeSummary,
  readSessionData
} from "./_shared.js";

export default async (request) => {
  const session = getSessionId(request);
  try {
    if (request.method !== "GET") {
      return jsonResponse({ error: "Method not allowed." }, 405, session.setCookie);
    }
    const data = await readSessionData(session.id);
    return jsonResponse(makeSummary(data.expenses), 200, session.setCookie);
  } catch (error) {
    return errorResponse(error, session.setCookie);
  }
};
