# Echo Clash Online V0.4.2 Gameplay Parity Alpha

This build keeps the working V0.4 online room/server layer and restores the gameplay clarity and mechanics that regressed from the V3 local prototype.

## Core fixes in V0.4.2

- Detailed cards again show damage / HP / ATK / Guard / OC and card-specific rules.
- Live selected-card preview shows calculated Raw damage/HP, OC, Stable / Unstable / Rupture, Strain and Critical Overreach.
- Roll and Counter decisions are surfaced as a large resolution window instead of being easy to miss in the side panel.
- Added the missing `Barrier Form`, bringing the gameplay catalogue to 54 unique types and one gameplay deck to 108 cards at 2 copies each.
- Hand cap is 15. Draw Action draws up to +3 without exceeding 15.
- Trade Action remains 3 cards -> 1 or 5 cards -> 3.
- Temporary Output / Stability boosts now expire after the end of the owner's next scheduled Action.
- Echo Shell is a D60 temporary self-shell instead of a D0 attack.
- Echo Collapse triggers all remaining lingering ticks after it reaches a Player, then removes those lingering effects.
- Bind / Stone Spikes apply Spike Bind D5 for 2 turns. Bind only cancels a scheduled Action if that Player has not acted yet that round.
- Raw Water vs Fire Clash bonus, Earth Barrier interaction, and Acid vs Monster effectiveness are encoded.
- Wave resolves as an area attack and, after Barrier, affects the active Monster and Player simultaneously in each affected lane.
- Primary target is the only Player allowed to Counter an area attack. Adjacent side Players cannot Counter.
- Area Counters also spread around the original attacker if the Counter configuration itself is an area configuration.
- Resolution chains now finish fully before elimination / winner / tie-breaker checks. This fixes premature winner declarations during area attacks.
- Counter damage reaching the attacker can earn Strikes.
- Consecutive Losses are reset by winning a Clash or successfully damaging another Player.
- Monster direct Player damage can create Losses; lingering damage cannot.
- Human 3-Loss card penalty now requires selecting exactly 2 cards instead of silently returning the last two.
- Barrier retaliation damages the actual attacking entity, including Monsters.
- Monsters become active after summoning and attack on their owner's next attack opportunity, including a Counter opportunity.
- Echo Shell / Barrier / Monster / lingering fields are public, hands remain private.
- Host can replace an offline human with AI from the match UI.
- 5-minute reconnect grace now has an actual timeout path. If a pending Counter expires it is declined; if a pending roll expires it uses a virtual d4; if a scheduled turn expires it auto-passes.

## Current HP scaling

- 2-4 Players: 300 HP
- 5-6 Players: 400 HP
- 7-8 Players: 500 HP

## Deck scaling

- 2-3 Players: 1 x 108-card gameplay deck
- 4-6 Players: 2 decks
- 7-8 Players: 3 decks

## Tie-breaker

Eliminations are evaluated only after the entire attack resolution chain completes. If no Player remains alive after that chain, the Players who were alive when the chain started return at 20 HP for a Tie-Breaker Round.

## Run

```bash
npm install
npm test
npm start
```

Then open `http://localhost:3000`.

## Hosting

The existing Railway service can deploy this build. Replace the repository files with this V0.4.2 set and trigger a Railway deployment from `main`.

Room state remains in server memory for Alpha. A full Railway container restart still removes active rooms. Database/Redis persistence should be added after multiplayer gameplay stabilizes.
