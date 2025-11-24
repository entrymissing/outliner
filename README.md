# Outliner

An outliner inspired by [Workflowy](https://workflowy.com/).

A live version of this project is running at [entrymissing.github.io/outliner](https://entrymissing.github.io/outliner).

## Features

*   Infinite outlining of bullet points.
*   Login via Google Authentication.
*   Backend powered by Firebase.

## Local Development

To run this project locally, you will need to set up your own Firebase project.

1.  Create a Firebase project at [https://firebase.google.com/](https://firebase.google.com/).
2.  In your project settings, find your Firebase config.
3.  Create a `.env.local` file in the root of this project.
4.  Copy the contents of `.env.local.example` into your new `.env.local` file.
5.  Replace the placeholder values in `.env.local` with your Firebase project's configuration values.

Your `.env.local` file should look like this:

```
VITE_FIREBASE_API_KEY=your_api_key_here
VITE_FIREBASE_AUTH_DOMAIN=your-project.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=your-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-project.appspot.com
VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
VITE_FIREBASE_APP_ID=your_app_id
VITE_FIREBASE_MEASUREMENT_ID=your_measurement_id
```

Once you have created your `.env.local` file, you can install the dependencies and run the development server:

```bash
npm install
npm run dev
```