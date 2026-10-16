# Smart Expense Advisor AI

A local expense tracker with an AI budgeting assistant. Run it locally with Express and local `data.json` storage, or deploy it to Netlify with serverless functions and Netlify Blobs.

**GitHub repository:** [vaishnavishinde015/smart-expanse-advisor-ai](https://github.com/vaishnavishinde015/smart-expanse-advisor-ai)

## Tech stack

| Area | Technology |
| --- | --- |
| Frontend | HTML, CSS, and vanilla JavaScript |
| Local backend | Node.js 20+ and Express 5 |
| Netlify backend | Netlify Functions (Node.js 22) |
| AI assistant | OpenRouter API |
| Local AI tools | Model Context Protocol (MCP) SDK |
| Local data storage | `data.json` file |
| Netlify data storage | Netlify Blobs, isolated per browser |
| Package management | npm |

## Requirements

- Node.js 20 or newer (npm is included with Node.js)
- An OpenRouter account and API key to use the AI chat feature (optional; expense tracking works without it)

## 1. Download the project from GitHub

Install Git if it is not already installed, then open PowerShell or a terminal and run:

```powershell
git clone https://github.com/vaishnavishinde015/smart-expanse-advisor-ai.git
cd smart-expanse-advisor-ai
```

Alternatively, use the repository’s [**Code → Download ZIP**](https://github.com/vaishnavishinde015/smart-expanse-advisor-ai) option on GitHub, extract the ZIP, and open a terminal in the extracted project folder.

## 2. Install Node.js

Download and install the current Node.js LTS release (version 20 or newer) from [nodejs.org](https://nodejs.org/). Open a new terminal and check the installation:

```powershell
node --version
npm --version
```

Use Node.js 20 or newer for local development. Netlify is configured to use Node.js 22.

## 3. Install project dependencies

From the project folder, run:

```powershell
npm install
```

## 4. Get an OpenRouter API key

The app sends AI chat requests to OpenRouter using `nvidia/nemotron-3.5-super-vl:free` with reasoning enabled. When the model requests local expense tools, the app preserves the returned `reasoning_details` in the assistant message sent with the tool results so the model can continue that response. OpenRouter and model availability, free-tier terms, and access requirements can change; check the model page and your account for current details.

Create an account or sign in at [openrouter.ai](https://openrouter.ai/), then create a key from the [OpenRouter API Keys page](https://openrouter.ai/keys). Review OpenRouter’s current account, credit, and model-access requirements.

Keep the key private. Do not paste it into source code, browser code, screenshots, or a public GitHub repository.

## 5. Configure the API key

In the project root, make a local `.env` file by copying `.env.example`:

```powershell
Copy-Item .env.example .env
```

Open `.env` in a text editor and replace the placeholder with your key:

```dotenv
OPENROUTER_API_KEY=your_actual_openrouter_api_key
```

Do not add quotes unless required by your key, and do not add spaces around `=`. The `.env` file is excluded from Git by `.gitignore`; keep it that way and never commit your real API key. If you do not configure a key, expense tracking still works, but the AI chat feature will not.

## 6. Run the project

In the project folder, start the server:

```powershell
npm start
```

When startup succeeds, the terminal reports that the app is running and that it connected to the MCP server. Open [http://127.0.0.1:3000](http://127.0.0.1:3000) in your browser.

To stop the server, focus the terminal running it and press **Ctrl+C**.

## Deploy to Netlify

1. Push this repository to GitHub and import it in Netlify. Select the `main` branch.
2. Leave the base directory empty. The included `netlify.toml` configures the build command, publish directory, and functions directory.
3. In Netlify, open **Project configuration → Environment variables** and add `OPENROUTER_API_KEY` with your newly created OpenRouter key. Never put the key in frontend code or commit it to GitHub.
4. Trigger a deploy. Netlify builds the static frontend into `dist` and publishes the API functions. The `/api/summary`, `/api/expenses`, and `/api/chat` routes are routed to those functions.
5. Visit the deployed site and add an expense. The first API request creates a private, random browser session; expenses are stored in Netlify Blobs for that browser.

The Netlify version starts with an empty expense list; it does not import records from `data.json`. Data is scoped to the browser's HttpOnly cookie. Clearing site cookies or using another browser creates a different expense list, so this is not an account-based sync or backup system. Do not use it for sensitive financial records without adding authenticated accounts and backups.

## Data and privacy

- When run locally, expense records are kept in the local `data.json` file. On Netlify, they are stored in Netlify Blobs and separated by a random, HttpOnly browser cookie.
- The API key stays in the server-side `.env` file locally or in Netlify environment variables after deployment; it is not included in browser code.
- When you ask the AI advisor a question, the app sends the question and, when needed to answer it, relevant expense/tool results to OpenRouter. Do not use the chat feature with sensitive information unless you are comfortable sending it to that service.
- Back up `data.json` if you want to preserve your local expense history when moving or reinstalling the project.

## Troubleshooting

- **`node` or `npm` is not recognized:** Install Node.js 20 or newer, then close and reopen the terminal.
- **Port 3000 is already in use:** Stop the other process using the port, or start the app with another port in PowerShell:

  ```powershell
  $env:PORT = "3001"
  npm start
  ```

  Then open `http://127.0.0.1:3001`.
- **AI chat reports a missing key:** Check that `.env` is in the project root, the variable is named exactly `OPENROUTER_API_KEY`, and restart the server after editing it.
- **OpenRouter returns an error:** Verify the key is valid and active, your account has any required credits, and the account can access the configured model.
- **The app cannot read expense data:** Check that `data.json` exists and contains valid JSON with `expenses` and `budgetTips` arrays. Restore it from a backup if it was damaged.
- **Netlify reports `/api/...` as 404:** Confirm the deploy is built from this repository's latest `main` commit and that Netlify is using the repository's `netlify.toml`. Trigger a fresh deploy after pushing configuration changes.
- **Netlify AI chat reports a missing key:** Add `OPENROUTER_API_KEY` in the Netlify project's environment variables, then trigger a new deploy.
