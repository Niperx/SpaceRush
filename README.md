# SpaceRush

![SpaceRush](https://i.imgur.com/vhAj30A.png)

Multiplayer browser game: each player is a planet. Build your economy, raise a fleet, attack neighbors, and mine asteroids. Canvas 2D + Socket.io — no heavy frameworks.

## Run

```bash
npm install
npm start
```

Open in browser: **http://localhost:3000**

## Overview

- **Nickname** — set once, saved between sessions
- **Upgrades** — economy, military, fortification
- **Fleet & shield** — buy with resources; fleet for attacks and asteroid mining
- **PvP** — attack mode → click enemy planet → choose fleet size. Win/lose with death screen and respawn
- **Language** — RU/EN toggle in the top-right corner

## Stack

Node.js, Express, Socket.io, HTML5 Canvas 2D, Vanilla JS. Server listens on `0.0.0.0` — play over LAN.
