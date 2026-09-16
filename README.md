# Echo Clash Online V0.4.1 Alpha

## Main fixes from V0.4

### Setup selectors
Total Seats and AI Seats now work even when the HTML is opened as a standalone preview.
The previous client tried to create the Socket.IO connection before the setup UI finished initializing.
If the Node server is not running, the setup remains usable and shows a clear server-offline notice.

### Area attacks and seat adjacency
Area / multiplayer attacks use the primary target's fixed seat adjacency.

Example with 4 players:
- P1 targets P3
- affected: P2, P3, P4

Example with 3 players:
- P1 targets P3
- affected: P2, P3
- P1 is never hit by their own area

Example with 2 players:
- P1 targets P2
- affected: P2 only

Only the PRIMARY target can Counter.
Adjacent side players cannot Counter.

Current area-enabled attacks:
- Raw Wave
- Lightning Arc
- Corrosive Surge
- Thunder Burst only when its d4 is 4
- Ricochet Arrow: primary takes its primary damage; adjacent side players take the Ricochet secondary damage

The primary target's Counter changes only the primary lane.
Side lanes still resolve independently against each side player's Barrier → Monster → Player.

## Blade exact split
There is no arbitrary 45/55 split anymore.

Blade contributes +D15.
The Blade/Form portion attacks the Barrier.
The Essence portion penetrates the Barrier.
All synergy, Force and d4 scaling affects both components equally.

Example:
Fire D25 + Blade D15 + Compression ×2 = D80
- Blade share: 15 / 40 = 37.5% → D30 attacks Barrier
- Essence share: 25 / 40 = 62.5% → D50 penetrates Barrier
- Monster can still Guard the penetrating damage

Frost Lance:
Ice D20 + Blade D15 = D35
- D15 Barrier-facing
- D20 penetrating

## Monster / Barrier parity pass
"Parity pass" means checking the digital engine against every special rule written on the cards so the web game behaves the same as the tabletop rules.

V0.4.1 adds / audits:
- Ashfang +D10 when attacking a Burning target
- Stoneback D10 Guard mitigation
- Stormclaw Charge and +D10 next autoattack
- Rotcrawler adds extra lingering pressure to an already affected target
- Emberhide D10 retaliation when it survives configuration damage
- Shardling +1 Stability
- Flame Barrier retaliation
- Water Barrier D10 reduction
- Wind Barrier Projectile reduction
- Ice / Glacial freeze on break
- Lightning / Magma retaliation upgrade on break
- Acid Barrier Corrosion
- Storm Barrier D20 + Stun on break
- Inferno Barrier immediate Burn retaliation + next-turn Burn
- Permafrost temporary Stability reduction
- Barrier retaliation also works against Monster attacks

There will still be playtest balancing, but these effects are no longer intentionally omitted.

## Persistence
Rooms are still stored in server memory for the Alpha.

That means:
- refreshing/reconnecting to the same running server works
- if the hosting service restarts the Node process, active rooms disappear

This is acceptable for early online playtests.
After multiplayer behavior is stable, move room state to Redis/Postgres or another persistent store so deploys/restarts do not kill matches.

## Run locally
```bash
npm install
npm start
```

Open:
http://localhost:3000

Do not judge Create/Join by opening public/index.html alone.
The standalone HTML preview now lets you test setup controls, but real rooms require the Node server.
