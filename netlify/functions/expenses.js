import {
  errorResponse,
  getSessionId,
  jsonResponse,
  readSessionData,
  writeSessionData
} from "./_shared.js";

export default async (request) => {
  const session = getSessionId(request);
  try {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed." }, 405, session.setCookie);
    }
    const body = await request.json().catch(() => null);
    const amount = Number(body?.amount);
    const category = typeof body?.category === "string" ? body.category.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
      return jsonResponse({ error: "Enter an amount greater than ₹0 and no more than ₹1,000,000,000." }, 400, session.setCookie);
    }
    if (category.length === 0 || category.length > 60) {
      return jsonResponse({ error: "Category must be between 1 and 60 characters." }, 400, session.setCookie);
    }
    if (description.length === 0 || description.length > 200) {
      return jsonResponse({ error: "Description must be between 1 and 200 characters." }, 400, session.setCookie);
    }

    const data = await readSessionData(session.id);
    const expense = {
      id: `expense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      amount: Number(amount.toFixed(2)),
      category,
      description,
      date: new Date().toISOString()
    };
    data.expenses.push(expense);
    await writeSessionData(session.id, data);
    return jsonResponse({ expense }, 201, session.setCookie);
  } catch (error) {
    return errorResponse(error, session.setCookie);
  }
};
