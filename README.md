# Echo Clash Online V0.5 — Game Experience Alpha

V0.5 keeps the V0.4.2 authoritative multiplayer combat engine and adds the first complete player-facing game shell.

## What V0.5 adds

- Main menu with New Game, Join Game, Tutorial, Rule Book and a V0.6 Profile placeholder.
- Complete in-app Rule Book covering setup, scheduled turns, Actions, Counter, Output/Stability/Rupture, defense, area attacks, Strikes/Losses/States, conditions, elimination and tie-breaker.
- Card Encyclopedia generated from the same 54-card catalogue used by the server.
- Guided seven-step tutorial match covering automatic draw, Barriers, Counter, Monsters, Unstable casting, Rupture, Strikes and States.
- **Automatic Draw 1 at the start of every scheduled turn**, up to the 15-card hand cap.
- Draw Action remains +3, so a normal Draw turn can add four cards total: automatic +1 plus Action +3.
- Eight persistent Player colors used in seats, turn order, battlefield pods and Battle Log.
- Player IDs (P1–P8) remain visible alongside color so the UI does not depend on color alone.
- Latest Event panel in the center battlefield for faster live readability without requiring the Battle Log.
- Resume previous room entry from the main menu.
- Rule Book can be opened from the header without deleting the saved room session.

## Intentionally not in V0.5

- Accounts, permanent player profiles, match history and statistics are planned for V0.6.
- Full combat/performance animation is planned for V0.7 after the experience and persistence layers settle.

## Core rules retained from V0.4.2

- 2–8 Players, free-for-all.
- Fixed scheduled order P1 → P2 → P3… each round.
- Counter is an immediate interruption and does not consume the defender's later scheduled Action.
- Starting hand 12, hand cap 15.
- Output 5, Stability 3.
- Stable / Unstable / Rupture resolution and mandatory d4 where appropriate.
- Critical Overreach at OC ≥ Output + 3 with D300 self-damage after resolution.
- Barrier → Monster → Player defense order.
- Phase Strike bypasses Barrier and Monster while Echo Shell can still protect the Player.
- One active Monster and one active Barrier per Player.
- Full area-resolution chain completes before elimination/winner evaluation.
- 5 Strikes grants a Normal State.
- 3 consecutive Losses triggers the Loss penalty.
- 20 HP Tie-Breaker when all remaining Players fall in the same resolution chain.
- 54 unique gameplay card types × 2 = 108 cards per gameplay deck.
- 2–3 Players: 1 deck; 4–6: 2 decks; 7–8: 3 decks.
- HP scaling: 300 / 400 / 500 by table size.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm test
npm start
```

Open `http://localhost:3000`.

## Railway

The server listens on `process.env.PORT || 3000` and includes:

- `Dockerfile`
- `railway.json`
- `/health`
- Socket.IO authoritative multiplayer server

Current production setup can continue using the existing `PORT=3000` Railway variable and existing public domain.

## Audit

```bash
npm test
```

The audit verifies the 54-card catalogue, 108-card deck size, Raw/Blade/Barrier calculations, area seating, Ricochet values, HP/deck scaling and Echo Shell definition. The V0.5 build also performs static syntax checks before packaging.
