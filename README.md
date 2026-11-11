# Deluxe Meet

Video calls in the browser, for everyone. Part of the Deluxe websites: sign in with **Deluxe Main**,
or join as a guest.

- **Start a meeting** and share its link (`https://deluxe-meet.vercel.app/abc-defg-hij`), or join with a code.
- **Before joining:** camera preview, mic level, choose camera and microphone, type your name.
- **In the call:** auto-sizing video grid, who is speaking, mute / camera off, **present your screen**,
  pin someone to the main screen (double-click a tile), **chat**, **reactions**, **raise hand**, people list,
  call timer. Ctrl+D mutes, Ctrl+E turns the camera on and off.
- Up to 12 people per meeting.

## Connected to Deluxe Main

The page loads `https://deluxe-main.vercel.app/deluxe.js` with `data-app="meet"`:

- The **Sign in with Deluxe Main** button and the menu of every Deluxe website sit in the top right.
- Signed in, your **name** comes from your Deluxe account and your **meeting history** (code, time,
  length, who was there) is saved in Deluxe Main (`Deluxe.data`, keys `call:<time>`), so it follows you
  to any device. Guests keep their history in their browser only.
- Deluxe Main lists Deluxe Meet under the app id `meet` and allows sign-ins from
  `https://deluxe-meet.vercel.app` (`worker/apps.js` in Deluxe-Main). **If this site is deployed at a
  different address**, add that address there (or to the `APP_ORIGINS` variable) or sign-in is refused.

## How calls work

Calls are **peer to peer** (WebRTC, through PeerJS): video and sound go directly between the people in
the meeting; nothing is recorded or stored. PeerJS's free public server (`0.peerjs.com`) only introduces
people, and its STUN/TURN servers help connections through home routers.

Each person has a random id. One person also holds the meeting's "front desk" id; newcomers knock
there, are told who is in, and call each of them. If the front-desk holder leaves, someone else takes
it over, and everyone checks in now and then, so the call heals itself.

To use your own PeerJS server or TURN server, set them in `public/config.js`.

## Files

```
public/index.html, styles.css, app.js   the whole app (no build step)
public/config.js                         optional own PeerJS / TURN servers
public/vendor/peerjs.min.js              PeerJS 1.5.4 (MIT, see peerjs.LICENSE.txt)
vercel.json                              publishes public/, sends /abc-defg-hij to index.html
tools/serve.mjs                          local server: node tools/serve.mjs 8080
tests/meet.test.mjs                      three browsers with fake cameras in one call
```

## Deploy

Import this repository on Vercel (no build; `vercel.json` publishes `public/`). Name the project
`deluxe-meet` so it lands at `https://deluxe-meet.vercel.app`.

Camera and microphone only work over **https** (or `http://localhost`).

## Test

```
npm install
node tests/meet.test.mjs
```

Runs a local PeerJS server and the site, then has three Chromium browsers with fake cameras join,
chat, mute, raise a hand, leave and rejoin.

Directed by **Shivad Sujith**. AI support: **Claude**.
