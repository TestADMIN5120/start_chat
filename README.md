# Chat app with built-in tasks (version 0.1)

A messaging app where every group can also hold tasks, notices and a daily summary.
Each person chooses between two modes:

- **Chat mode** (default): plain chats and groups, like any messaging app.
- **Advanced mode**: adds the Today screen, plus Tasks, Notices and Summary tabs inside each group.

A task or notice sent to someone in chat mode still reaches them as a card in the chat, with a button to finish or confirm it.

## Run it

You need Node.js 22.5 or newer.

```
npm install
npm start
```

Then open http://localhost:3000 on the same computer. To try it with two people, open it in two different browsers (or one normal window and one private window) and sign in with two different phone numbers.

Phones on the same Wi-Fi can open `http://<your computer's IP address>:3000`.

Settings (optional environment variables): `PORT` (default 3000) and `DB_FILE` (default `data.db` in this folder).

## What works

- Sign in with name and phone number
- Create groups and add people by phone number
- Live group chat (messages appear on other phones without refreshing)
- Turn a message into a task, or add a task directly, with a person and a due time
- Mark tasks done or reopen them; the group is told
- Today screen: everything assigned to you across all groups
- Notices that each member confirms, with a count of who has and hasn't
- Daily summary per group: done today and still pending
- Switch between chat mode and advanced mode at any time

## Not built yet

- **Phone number verification (SMS code).** Right now anyone who knows a phone number can sign in as that person. This must be added before real users are invited.
- Voice and video calls
- Photos, files and voice notes
- Notifications when the app is closed
- One-to-one chats as their own type (for now, make a group of two)
- Repeating daily checklists and shift handover notes
- Telugu and Hindi
- Limits on how fast someone can send requests, backups, and an Android app in the Play Store

## Files

- `server.js`: the server, database tables and live updates
- `public/app.js`: all the screens
- `public/style.css`: the look
- `data.db`: created on first run; holds all the data
