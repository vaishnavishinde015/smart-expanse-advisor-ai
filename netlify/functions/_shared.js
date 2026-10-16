import { randomUUID } from "node:crypto";
import { getStore } from "@netlify/blobs";
import data from "../../data.json" with { type: "json" };

const SESSION_COOKIE = "expense_session";
const STORE = getStore("expense-data");
const EMPTY_DATA = { expenses: [] };
const MAX_TOOL_CALLS = 4;
const ALLOWED_TOOLS = new Set(["getExpenses", "calculateTotal", "searchBudgetTips"]);

export function getSessionId(request) {
  const cookie = request.headers.get("cookie") || "";
  const existingId = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`))
    ?.slice(SESSION_COOKIE.length + 1);
  const validId = existingId && /^[0-9a-f-]{36}$/i.test(existingId);
  const id = validId ? existingId : randomUUID();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return {
    id,
    setCookie: validId
      ? null
      : `${SESSION_COOKIE}=${id}; Path=/; Max-Age=31536000; HttpOnly${secure}; SameSite=Lax`
  };
}

export async function readSessionData(sessionId) {
  return await STORE.get(`sessions/${sessionId}`, {
    type: "json",
    consistency: "strong"
  }) || EMPTY_DATA;
}

export async function writeSessionData(sessionId, value) {
  await STORE.setJSON(`sessions/${sessionId}`, value);
}

export function jsonResponse(value, status = 200, setCookie = null) {
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (setCookie) headers["Set-Cookie"] = setCookie;
  return new Response(JSON.stringify(value), { status, headers });
}

export function errorResponse(error, setCookie = null) {
  console.error("Netlify API function failed:", error);
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const message = status === 500
    ? "Something went wrong on the server. Check the Netlify function logs for details."
    : error.message;
  return jsonResponse({ error: message }, status, setCookie);
}

export function makeSummary(expenses) {
  const categories = {};
  let total = 0;
  for (const expense of expenses) {
    total += expense.amount;
    categories[expense.category] = (categories[expense.category] || 0) + expense.amount;
  }
  return { total: Number(total.toFixed(2)), categories, expenses };
}

async function callOpenRouter(messages, tools) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("OPENROUTER_API_KEY is missing. Add it in Netlify environment variables.");
    error.statusCode = 503;
    throw error;
  }

  let response;
  try {
    response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3.5-super-vl:free",
        messages,
        ...(tools ? { tools, tool_choice: "auto" } : {}),
        reasoning: { enabled: true },
        temperature: 0.2
      }),
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    const requestError = new Error(
      error.name === "TimeoutError"
        ? "The AI request timed out. Please try again."
        : "Could not reach OpenRouter. Check your internet connection and try again."
    );
    requestError.statusCode = 502;
    throw requestError;
  }

  if (!response.ok) {
    const error = new Error(`OpenRouter returned HTTP ${response.status}. Check your API key, account credits, and model access.`);
    error.statusCode = 502;
    throw error;
  }

  let result;
  try {
    result = await response.json();
  } catch {
    const error = new Error("OpenRouter returned an invalid response.");
    error.statusCode = 502;
    throw error;
  }
  const message = result?.choices?.[0]?.message;
  if (!message || (typeof message.content !== "string" && !Array.isArray(message.tool_calls))) {
    const error = new Error("OpenRouter response did not contain a usable assistant message.");
    error.statusCode = 502;
    throw error;
  }
  return message;
}

function runTool(name, args, expenses) {
  if (!ALLOWED_TOOLS.has(name) || !args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("The AI requested an invalid or unsupported tool.");
  }

  if (name === "getExpenses") {
    if (Object.keys(args).length) throw new Error("getExpenses does not accept arguments.");
    return expenses;
  }

  if (name === "calculateTotal") {
    if (Object.keys(args).some((key) => key !== "category")) {
      throw new Error("calculateTotal only accepts an optional category.");
    }
    if (args.category !== undefined && (
      typeof args.category !== "string" ||
      args.category.trim().length === 0 ||
      args.category.trim().length > 60
    )) {
      throw new Error("category must be a non-empty string of at most 60 characters.");
    }
    const category = typeof args.category === "string" ? args.category.trim() : null;
    const matching = category
      ? expenses.filter((expense) => expense.category.toLowerCase() === category.toLowerCase())
      : expenses;
    const total = matching.reduce((sum, expense) => sum + expense.amount, 0);
    return { total: Number(total.toFixed(2)), category, expenseCount: matching.length };
  }

  if (Object.keys(args).some((key) => key !== "query") ||
      typeof args.query !== "string" || args.query.trim().length === 0 || args.query.length > 300) {
    throw new Error("searchBudgetTips requires a query of at most 300 characters.");
  }
  const terms = args.query.toLowerCase().match(/[a-z0-9₹]+/g) || [];
  const stopWords = new Set(["about", "after", "expense", "expenses", "from", "have", "help", "much", "next", "that", "the", "this", "what", "with", "would", "your"]);
  const keywords = terms.filter((term) => term.length > 2 && !stopWords.has(term));
  const ranked = data.budgetTips
    .map((tip) => {
      const searchable = `${tip.title} ${tip.text} ${tip.keywords.join(" ")}`.toLowerCase();
      return { tip, score: keywords.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0) };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ tip }) => ({ title: tip.title, text: tip.text }));
  return { tips: ranked };
}

export async function answerQuestion(question, expenses) {
  const tools = [
    {
      type: "function",
      function: {
        name: "getExpenses",
        description: "Get all expenses stored for this user. Use for questions about actual spending.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "calculateTotal",
        description: "Calculate total spending across all expenses, or only for a named category.",
        parameters: {
          type: "object",
          properties: { category: { type: "string", description: "Optional category, for example Food." } },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "searchBudgetTips",
        description: "Search general budgeting tips for the user's question.",
        parameters: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false
        }
      }
    }
  ];
  const messages = [
    {
      role: "system",
      content: [
        "You are a helpful, careful expense and budgeting assistant.",
        "Use the available tools whenever the user asks about their actual expenses or needs budgeting tips.",
        "Treat tool results as the only source of truth for the user's expense data. Never guess amounts, dates, categories, or totals.",
        "Treat searchBudgetTips results as general budgeting knowledge, not as facts about the user.",
        "If a tool returns no matching tips or the expense list is empty, say so plainly. Separate observed spending from general suggestions.",
        "All expense amounts are in Indian rupees; format them with ₹ and never assume another currency.",
        "Answer directly using concise headings and bullet lists. Avoid tables unless a comparison genuinely requires one.",
        "Be practical and concise. Do not claim to have performed an action you did not perform."
      ].join(" ")
    },
    { role: "user", content: question }
  ];

  const firstReply = await callOpenRouter(messages, tools);
  const requestedCalls = Array.isArray(firstReply.tool_calls) ? firstReply.tool_calls : [];
  if (requestedCalls.length === 0) {
    if (!firstReply.content?.trim()) {
      const error = new Error("The AI returned an empty answer.");
      error.statusCode = 502;
      throw error;
    }
    return firstReply.content.trim();
  }

  const toolCalls = requestedCalls.slice(0, MAX_TOOL_CALLS);
  messages.push({
    role: "assistant",
    content: firstReply.content || null,
    tool_calls: toolCalls,
    ...(firstReply.reasoning_details !== undefined
      ? { reasoning_details: firstReply.reasoning_details }
      : {})
  });

  for (const call of toolCalls) {
    if (call?.type !== "function" || typeof call?.id !== "string" || !ALLOWED_TOOLS.has(call?.function?.name)) {
      throw new Error("The AI requested an invalid or unsupported tool.");
    }
    let args;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      throw new Error(`The AI supplied invalid arguments for ${call.function.name}.`);
    }
    const value = runTool(call.function.name, args, expenses);
    messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(value) });
  }

  if (requestedCalls.length > MAX_TOOL_CALLS) {
    messages.push({
      role: "system",
      content: `Only the first ${MAX_TOOL_CALLS} requested tool calls were executed. Answer using only those results.`
    });
  }
  const finalReply = await callOpenRouter(messages);
  if (typeof finalReply.content !== "string" || !finalReply.content.trim()) {
    const error = new Error("The AI returned an empty final answer.");
    error.statusCode = 502;
    throw error;
  }
  return finalReply.content.trim();
}
