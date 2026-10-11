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
- Edit or delete your own messages (deleted messages show as "Message deleted" for everyone)
- 1:1 audio/video calls: tap the phone icon next to a member in a group's People panel. Ringing, accept/decline, mute, camera on/off, hang up.
- Installable as an app on Android (Chrome "Install app") and iOS ("Add to Home Screen" in Safari)

## Calling notes

- Calls are 1:1 only, signaled over the same WebSocket connection used for live chat, with no server in the media path — audio/video goes directly between the two phones (peer-to-peer WebRTC).
- Uses a public STUN server only, no TURN server. This works on most home/office Wi-Fi, but calls between two people on strict/corporate NAT or some carrier-grade mobile networks may fail to connect. Adding a TURN server would fix that at the cost of running (or paying for) one.
- No call history or missed-call list — calls are not stored anywhere.
- Camera and microphone access needs a secure context: it works on the deployed `https://` site and on `http://localhost`, but **not** on `http://<lan-ip>:3000` opened from a phone. Test calling either on the deployed site or with both browser tabs on `localhost`.

## Not built yet

- **Phone number verification (SMS code).** Right now anyone who knows a phone number can sign in as that person. This must be added before real users are invited.
- Group calls (more than two people)
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
