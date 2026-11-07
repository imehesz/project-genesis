# Project Genesis

A browser 4X space strategy game: turn-based galaxy map and space battles, real-time ground battles.

## Run

    npm install
    npm run dev        # http://localhost:5173
    npm run headless   # proves the engine runs without a browser
    npm run build

## Layout

| Folder          | Role |
|-----------------|------|
| `src/engine/`   | Game logic. Pure TypeScript: **no React, Three.js, Zustand or DOM**. State changes only via `engine.dispatch(command)`. Will move to a Node server in Phase 2. |
| `src/store/`    | Zustand. `useGame` is a read-only mirror of engine state for React; `useUi` is screen/UI-only state. |
| `src/render/`   | Three.js. `Stage` = renderer, bloom, camera, backdrop, labels; `views/` = swappable scenes (sandbox, galaxy). Views subscribe to the engine and draw; they never change game state. |
| `src/theme.ts`  | Colors/labels shared by the 3D views and the UI. |
| `src/ui/`       | React overlay: menu, cutscenes, HUD. |
| `src/loop.ts`   | Browser host: one rAF loop that advances the engine clock, then draws. |

Two clocks: `turn` (strategic layer, advanced by `END_TURN`) and `tick` (20 Hz fixed step, runs only when `engine.setRealtime(true)`, for ground battles).

## Galaxy

Every New Campaign rolls a random seed and dispatches `NEW_CAMPAIGN`; `src/engine/galaxy.ts` builds the
whole galaxy from that seed (same seed = same galaxy): 2-4 spiral arms, 65-85 systems, procedural names,
planets by orbit zone, and the three faction homeworlds spread far apart. The seed is shown bottom-left.

## Economy (turn-based)

`src/engine/economy.ts` + data in `src/engine/data/{buildings,techs}.ts`. Each END_TURN: production flows down
each colony's build queue, population grows toward capacity, morale drifts toward its target (tax lowers it,
Holo Arenas raise it), taxes minus upkeep go to the treasury, research points go to the selected tech.
Credits can rush-buy the front of a build queue (2.5 credits per remaining production point). Faction traits:
Terran +20% tax income; Saurian +30% growth, -20% research, volcanic homes; Apex +20% research,
no natural growth (Assembly Foundry manufactures citizens). `colonyStats()` is pure, so the UI
shows exactly what END_TURN will apply.

Art: `public/art/planets/<type>.webp`, `public/art/buildings/<id>.webp` (Higgsfield, nano_banana_pro).

## Fleets, colonization, AI

Ships (`src/engine/data/ships.ts`) are built in a colony's queue (needs an Orbital Shipyard; homeworlds start with one)
and join the faction's parked fleet at that system. Fleets fly `speed` galaxy units per turn (slowest ship sets the pace)
and can be redirected anytime. A Colony Ship at a system founds a colony on a habitable planet (`COLONIZE`), which
claims the system if it was unowned. Galaxy map: left-click a fleet to select it, right-click a star to set course.

Every command is applied for an actor faction and validated against it (`applyCommand(state, cmd, actor)`).
`src/engine/ai.ts` plans the rival empires' turns as plain Commands, so they follow exactly the player's rules.

## Planet surfaces

`src/engine/surface.ts` generates each planet's surface grid from the galaxy seed + planet (side = `SURFACE_SCALE` × (5 + size) cells, currently 12-20):
`land` (buildable), `rough` (mountains/mesas/craters) and `liquid` (seas/lava/crevasses), with heights for rendering
and, later, ground battles. Colonies hold placed `structures` (x, y = top-left cell; Arcology/Shipyard/Arena are 2x2);
`src/engine/land.ts` checks placement and auto-places. `QUEUE_BUILDING` takes an optional `at`; without it the
building goes to the best free spot (dashboard + AI). `DEMOLISH` removes a structure.

`src/render/views/PlanetView.ts` draws it: terraced low-poly terrain coloured per planet type, animated water/lava,
sky + fog (airless worlds show space), building models (`public/models/buildings/*.glb`, Higgsfield tripo_3d),
construction sites that rise out of a hologram as progress accrues, and a green/red placement ghost.

## Space battles (turn-based)

`src/engine/battle.ts`. At end of turn, any two factions with fleets parked at the same system fight if either side
has warships (`findEncounters`). AI-vs-AI fights auto-resolve; the player's queue up in `state.battle` /
`battleQueue`, and `END_TURN` is refused until they're closed. Tactical map 14x9 with asteroids; each ship moves
(8-way, `move` cells) and fires (`range`, Chebyshev) once per round, then the opponent's AI plays its part.
Faction traits: Terran +1 weapon range, Saurian +1 hull repair per round, Apex 3-point shields that refill each round.
Retreat = enemy warships in range get a parting shot, then the fleet flies to its nearest colony. Results (lost ships)
are written back to the fleets and the turn report. Everything is deterministic (battle RNG seeded from galaxy seed,
system and turn). `src/render/views/SpaceBattleView.ts` replays the battle log as animation.

Dev shortcut: `npm run dev`, then open `/?scenario=battle` to start inside a fight (`src/devScenarios.ts`).

## Ground battles (real-time)

`src/engine/ground.ts` + `data/units.ts`. A fleet with Troop Transports (6 infantry + 2 tanks each) at a system with
an enemy colony and no enemy warships can `INVADE`. Both sides deploy inside the largest connected land region
(garrison from population + industry; Terran garrisons x1.5), attackers at a roomy landing zone far from the colony.
The battle runs on the engine's fixed 20 Hz tick (`simulateTick` -> `groundTick`): A* over land cells (8-way, no corner
cutting), targeting/aggro, chase, reload, separation; defenders hold 20 s, then hunt. Player units only auto-engage
nearby enemies. Saurian troops +25% hp/damage, Apex +20% speed. Win = colony captured with its buildings (pop -25%).
`GroundBattleView` layers units, tracers and explosions over `PlanetView`; RTS controls (left-drag box select,
right-click move/attack, WASD pan, middle-drag rotate, Ctrl+A, Space pauses).

Dev shortcut: `/?scenario=ground` lands two transports on the Saurian homeworld.

## Terrain dressing

`src/render/terrainDressing.ts`: splat-mapped ground (base + variation by large-scale noise, triplanar cliff rock by
slope/height, shoreline, roads) using Poly Haven CC0 textures in `public/textures/terrain/`; dirt roads = minimum
spanning tree over the buildings walked with the engine's A*, plus a supply road to the nearest reachable map edge;
instanced trees/rocks/plants from the Kenney Nature Kit (CC0, `public/models/nature/`), per planet type, thinned to a
clearing around the settlement and kept off roads and buildings. Kenney's colours are sRGB numbers in glTF's linear
factor, so props are repainted by material name (`PALETTE`, plus per-biome `palette` overrides). Purely visual:
props don't block units.

## Credits

Kenney Nature Kit (kenney.nl) and Poly Haven textures (polyhaven.com), both CC0. Licence files sit next to the assets.

## Cutscenes

Drop videos at `public/cutscenes/<id>.mp4` and register the id in `src/cutscenes.ts`.
A missing file shows a placeholder card instead.
