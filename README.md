# Outliner

An outliner inspired by [Workflowy](https://workflowy.com/).

A live version of this project is running at [entrymissing.github.io/outliner](https://entrymissing.github.io/outliner).

## Features

*   Infinite outlining of bullet points.
*   Login via Google Authentication.
*   Single Markdown file in Google Drive is the Source-of-Truth (no Firebase).

## Local Development

This version uses Google OAuth 2.0 and the Google Drive API. You will need a Google OAuth Client ID for a web application.

1.  Create OAuth 2.0 Client Credentials in Google Cloud Console and configure an Authorized JavaScript origin for your dev host (e.g., `http://localhost:5173`).
2.  Create a `.env.local` file in the root of this project.
3.  Add the `VITE_GOOGLE_CLIENT_ID` environment variable to your `.env.local` file.

Your `.env.local` file should include:

```
VITE_GOOGLE_CLIENT_ID=your_google_web_client_id.apps.googleusercontent.com
```

When you sign in the app will search for a file named `Outliner.md` in your Drive. If none is found the app will create one and use it as the single Markdown Source-of-Truth.

The `Outliner.md` file is intended to be a read-only source for external tooling (ML/agents) to gather project context and status.

Once you have created your `.env.local` file, you can install the dependencies and run the development server:

```bash
npm install
npm run dev
```