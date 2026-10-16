import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";

const DATA_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "data.json");

async function readData() {
  const data = JSON.parse(await readFile(DATA_PATH, "utf8"));
  if (!data || !Array.isArray(data.expenses) || !Array.isArray(data.budgetTips)) {
    throw new Error("data.json must contain expenses and budgetTips arrays.");
  }
  return data;
}

function validateExpenses(expenses) {
  if (expenses.some((expense) =>
    typeof expense?.amount !== "number" ||
    !Number.isFinite(expense.amount) ||
    expense.amount <= 0 ||
    typeof expense?.category !== "string" ||
    typeof expense?.description !== "string"
  )) {
    throw new Error("Stored expenses contain invalid data.");
  }
}

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function validObjectArguments(args) {
  return args !== null && typeof args === "object" && !Array.isArray(args);
}

const server = new Server(
  { name: "smart-expense-advisor-tools", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "getExpenses",
      description: "Get all expenses stored in the local JSON file. Use for questions about the user's actual spending.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false }
    },
    {
      name: "calculateTotal",
      description: "Calculate total spending across all expenses, or only for a named category.",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: "Optional category name to total, for example Food." }
        },
        additionalProperties: false
      }
    },
    {
      name: "searchBudgetTips",
      description: "Search the local budgeting knowledge file for tips relevant to the question.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The user's budgeting question or topic." }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (!validObjectArguments(args)) {
      return toolError("Tool arguments must be a JSON object.");
    }

    const data = await readData();
    validateExpenses(data.expenses);

    if (name === "getExpenses") {
      if (Object.keys(args).length > 0) {
        return toolError("getExpenses does not accept arguments.");
      }
      return textResult(data.expenses);
    }

    if (name === "calculateTotal") {
      if (Object.keys(args).some((key) => key !== "category")) {
        return toolError("calculateTotal only accepts an optional category.");
      }
      if (args.category !== undefined && (
        typeof args.category !== "string" ||
        args.category.trim().length === 0 ||
        args.category.trim().length > 60
      )) {
        return toolError("category must be a non-empty string of at most 60 characters.");
      }
      const category = typeof args.category === "string" ? args.category.trim() : null;
      const matching = category
        ? data.expenses.filter((expense) => expense.category.toLowerCase() === category.toLowerCase())
        : data.expenses;
      const total = matching.reduce((sum, expense) => sum + expense.amount, 0);
      return textResult({
        total: Number(total.toFixed(2)),
        category,
        expenseCount: matching.length
      });
    }

    if (name === "searchBudgetTips") {
      if (Object.keys(args).some((key) => key !== "query")) {
        return toolError("searchBudgetTips only accepts query.");
      }
      if (typeof args.query !== "string" || args.query.trim().length === 0 || args.query.length > 300) {
        return toolError("query must be a non-empty string of at most 300 characters.");
      }
      if (data.budgetTips.some((tip) =>
        typeof tip?.title !== "string" ||
        typeof tip?.text !== "string" ||
        !Array.isArray(tip?.keywords) ||
        tip.keywords.some((keyword) => typeof keyword !== "string")
      )) {
        throw new Error("Stored budget tips contain invalid data.");
      }
      const terms = args.query.toLowerCase().match(/[a-z0-9₹]+/g) || [];
      const stopWords = new Set(["about", "after", "expense", "expenses", "from", "have", "help", "much", "next", "that", "the", "this", "what", "with", "would", "your"]);
      const keywords = terms.filter((term) => term.length > 2 && !stopWords.has(term));
      const ranked = data.budgetTips
        .map((tip) => {
          const searchable = `${tip.title} ${tip.text} ${tip.keywords.join(" ")}`.toLowerCase();
          const score = keywords.reduce((total, term) => total + (searchable.includes(term) ? 1 : 0), 0);
          return { tip, score };
        })
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3)
        .map(({ tip }) => ({ title: tip.title, text: tip.text }));
      return textResult({ tips: ranked });
    }

    return toolError(`Unknown tool: ${name}`);
  } catch (error) {
    console.error(`MCP tool ${name} failed:`, error);
    return toolError("The requested tool could not read or process local data.");
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
