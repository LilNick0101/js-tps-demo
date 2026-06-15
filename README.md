# Multiplayer Third Person Shooter demo (Three.js + Rapier3d)

This is a demo of a multiplayer third person shooter game built with Three.js and Rapier3d. The game features multiplayer action with basic movement, shooting mechanics, a hero shooter component and simple physics.

## Features
- Basic movement and shooting mechanics.
- 7 Heroes with unique abilities.
- An arena with a simple layout, filled with pickup items.
- Working Team deathmatch mode.
- Scoreboard and killstreak tracking.
- Bot players to use for practice.

## Tech stack
- **Three.js**: For in-game rendering and 3D graphics.
- **Express**: For serving the game.
- **Rapier3d**: For server-side physics calculation.
- **Geckos.io**: Real-time client-server communication using UDP messages.
- **bitecs**: Server-side Entity Component System.

# Running the game

To run the game, follow these steps:

- Install the dependencies:
```bash
npm install
```

- Run the server:
```bash
npm start
```

- Run the client:
```bash
npx vite
```
By default, the server will run on `http://localhost:10000` and the client on `http://localhost:5173`. Open the client URL in your browser to start playing.
The following enviromnent variables can be set if needed:
- `VITE_SERVER_URL`: The URL the client will try to connect to(default is http://localhost).
- `VITE_SERVER_PORT`: The port the client will try to connect to (default is 10000).
- `SERVER_PORT`: The port the server will listen to (default is 10000).


