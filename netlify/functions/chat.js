import {
  answerQuestion,
  errorResponse,
  getSessionId,
  jsonResponse,
  readSessionData
} from "./_shared.js";

export default async (request) => {
  const session = getSessionId(request);
  try {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, session.setCookie);
    }
    const body = await request.json().catch(() => null);
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (question.length === 0 || question.length > 1000) {
      return jsonResponse({ error: "Question must be between 1 and 1,000 characters." }, 400, session.setCookie);
    }

    const data = await readSessionData(session.id);
    const answer = await answerQuestion(question, data.expenses);
    return jsonResponse({ answer }, 200, session.setCookie);
  } catch (error) {
    return errorResponse(error, session.setCookie);
  }
};
