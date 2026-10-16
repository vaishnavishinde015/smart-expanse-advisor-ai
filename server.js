import "dotenv/config";
import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_PATH = path.join(ROOT, "data.json");
const MCP_SERVER_PATH = path.join(ROOT, "mcp-server.js");
const MAX_TOOL_CALLS = 4;
const ALLOWED_TOOLS = new Set(["getExpenses", "calculateTotal", "searchBudgetTips"]);

app.use(express.json({ limit: "20kb" }));

async function readData() {
  let data;
  try {
    data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  } catch (error) {
    throw new Error(`Could not read data.json: ${error.message}`);
  }
  if (!data || !Array.isArray(data.expenses) || !Array.isArray(data.budgetTips)) {
    throw new Error("data.json must contain expenses and budgetTips arrays.");
  }
  if (data.expenses.some((expense) =>
    typeof expense?.amount !== "number" ||
    !Number.isFinite(expense.amount) ||
    expense.amount <= 0 ||
    typeof expense?.category !== "string" ||
    expense.category.trim().length === 0 ||
    typeof expense?.description !== "string" ||
    expense.description.trim().length === 0
  )) {
    throw new Error("data.json contains invalid expense data.");
  }
  return data;
}

function makeSummary(expenses) {
  const categories = {};
  let total = 0;
  for (const expense of expenses) {
    total += expense.amount;
    categories[expense.category] = (categories[expense.category] || 0) + expense.amount;
  }
  return { total: Number(total.toFixed(2)), categories, expenses };
}

let writeQueue = Promise.resolve();

function addExpense(expense) {
  const operation = writeQueue.then(async () => {
    const data = await readData();
    data.expenses.push(expense);
    await writeFile(DATA_PATH, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: [MCP_SERVER_PATH],
  stderr: "inherit"
});
const mcpClient = new Client(
  { name: "smart-expense-advisor", version: "1.0.0" },
  { capabilities: {} }
);

async function connectMcp() {
  await mcpClient.connect(mcpTransport);
  const { tools } = await mcpClient.listTools();
  const requiredTools = [...ALLOWED_TOOLS];
  for (const name of requiredTools) {
    if (!tools.some((tool) => tool.name === name)) {
      throw new Error(`MCP server did not expose the required tool: ${name}`);
    }
  }
  return tools;
}

function validateToolResult(name, result) {
  if (result.isError) {
    throw new Error(`MCP tool ${name} reported an error.`);
  }
  if (!Array.isArray(result.content)) {
    throw new Error(`MCP tool ${name} returned an invalid response.`);
  }
  const textContent = result.content.find((item) => item.type === "text");
  if (!textContent || typeof textContent.text !== "string") {
    throw new Error(`MCP tool ${name} returned no text result.`);
  }

  let value;
  try {
    value = JSON.parse(textContent.text);
  } catch {
    throw new Error(`MCP tool ${name} returned invalid JSON.`);
  }

  if (name === "getExpenses") {
    if (!Array.isArray(value) || value.some((item) =>
      typeof item?.amount !== "number" ||
      !Number.isFinite(item.amount) ||
      typeof item?.category !== "string" ||
      typeof item?.description !== "string"
    )) {
      throw new Error("MCP getExpenses returned invalid expense data.");
    }
  } else if (name === "calculateTotal") {
    if (
      typeof value?.total !== "number" ||
      !Number.isFinite(value.total) ||
      !Number.isInteger(value.expenseCount) ||
      !(typeof value.category === "string" || value.category === null)
    ) {
      throw new Error("MCP calculateTotal returned invalid totals.");
    }
  } else if (name === "searchBudgetTips") {
    if (!Array.isArray(value?.tips) || value.tips.some((tip) =>
      typeof tip?.title !== "string" || typeof tip?.text !== "string"
    )) {
      throw new Error("MCP searchBudgetTips returned invalid tip data.");
    }
  } else {
    throw new Error(`MCP tool is not allowed: ${name}`);
  }
  return value;
}

async function callOpenRouter(messages, tools) {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    const error = new Error("OPENROUTER_API_KEY is missing. Add your key to the local .env file and restart the server.");
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

async function answerQuestion(question, availableTools) {
  const openRouterTools = availableTools
    .filter((tool) => ALLOWED_TOOLS.has(tool.name))
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }
    }));
  const messages = [
    {
      role: "system",
      content: [
        "You are a helpful, careful expense and budgeting assistant.",
        "Use the available tools whenever the user asks about their actual expenses or needs budgeting tips.",
        "Treat getExpenses and calculateTotal results as the only source of truth for the user's expense data. Never guess amounts, dates, categories, or totals.",
        "Treat searchBudgetTips results as general budgeting knowledge, not as facts about the user.",
        "If a tool returns no matching tips or the expense list is empty, say so plainly. Separate observed spending from general suggestions.",
        "All expense amounts are in Indian rupees; format them with ₹ and never assume another currency.",
        "Answer the question directly using concise headings and bullet lists. Avoid tables unless a comparison genuinely requires one.",
        "Explain calculations using the returned figures. Be practical and concise. Do not claim to have performed an action you did not perform."
      ].join(" ")
    },
    { role: "user", content: question }
  ];

  const firstReply = await callOpenRouter(messages, openRouterTools);
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
    const name = call?.function?.name;
    if (
      call?.type !== "function" ||
      typeof call?.id !== "string" ||
      !ALLOWED_TOOLS.has(name)
    ) {
      throw new Error("The AI requested an invalid or unsupported tool.");
    }
    let input;
    try {
      input = JSON.parse(call.function.arguments || "{}");
    } catch {
      throw new Error(`The AI supplied invalid arguments for ${name}.`);
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error(`The AI supplied invalid arguments for ${name}.`);
    }

    const result = await mcpClient.callTool({ name, arguments: input });
    const validatedResult = validateToolResult(name, result);
    messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: JSON.stringify(validatedResult)
    });
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

app.get("/", (_request, response) => {
  response.sendFile(path.join(ROOT, "index.html"));
});

app.get("/style.css", (_request, response) => {
  response.sendFile(path.join(ROOT, "style.css"));
});

app.get("/api/summary", async (_request, response, next) => {
  try {
    const data = await readData();
    response.json(makeSummary(data.expenses));
  } catch (error) {
    next(error);
  }
});

app.post("/api/expenses", async (request, response, next) => {
  try {
    const amount = Number(request.body?.amount);
    const category = typeof request.body?.category === "string" ? request.body.category.trim() : "";
    const description = typeof request.body?.description === "string" ? request.body.description.trim() : "";
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
      return response.status(400).json({ error: "Enter an amount greater than ₹0 and no more than ₹1,000,000,000." });
    }
    if (category.length === 0 || category.length > 60) {
      return response.status(400).json({ error: "Category must be between 1 and 60 characters." });
    }
    if (description.length === 0 || description.length > 200) {
      return response.status(400).json({ error: "Description must be between 1 and 200 characters." });
    }

    const expense = {
      id: `expense-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      amount: Number(amount.toFixed(2)),
      category,
      description,
      date: new Date().toISOString()
    };
    await addExpense(expense);
    response.status(201).json({ expense });
  } catch (error) {
    next(error);
  }
});

app.post("/api/chat", async (request, response, next) => {
  try {
    const question = typeof request.body?.question === "string" ? request.body.question.trim() : "";
    if (question.length === 0 || question.length > 1000) {
      return response.status(400).json({ error: "Question must be between 1 and 1,000 characters." });
    }
    const answer = await answerQuestion(question, availableTools);
    response.json({ answer });
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  console.error(error);
  if (response.headersSent) return;
  const status = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  const message = status === 500 ? "Something went wrong on the server. Check the server terminal for details." : error.message;
  response.status(status).json({ error: message });
});

let availableTools = [];

async function start() {
  availableTools = await connectMcp();
  const server = app.listen(PORT, "127.0.0.1", () => {
    console.log(`Smart Expense Advisor is running at http://127.0.0.1:${PORT}`);
    console.log(`Connected to MCP server with ${availableTools.length} tools.`);
    if (!process.env.OPENROUTER_API_KEY?.trim()) {
      console.warn("OPENROUTER_API_KEY is missing. Expense tracking works, but AI chat will need a key in .env.");
    }
  });

  const shutdown = () => {
    server.close(() => {
      void mcpClient.close().finally(() => process.exit(0));
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((error) => {
  console.error("Could not start the application:", error);
  process.exitCode = 1;
});
