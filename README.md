**Synergy**

Playable at https://synergy-game-977938858735.us-west1.run.app/

Synergy is a real time cooperative word association game where two players attempt to independently submit the same word. Players must think alike without communicating directly. The game supports both human teammates and an AI teammate powered by OpenAI. This project is fully deployed on Google Cloud and is intended as a portfolio ready, production style application.

This project demonstrates full stack development with real time networking, AI integration, and production ready deployment practices.

**How the Game Works**

Two players join the same room using a short room code
Each round, both players privately submit one word
When both words are revealed:
If the words match exactly, the team wins
If not, the pair becomes the hint for the next round
Each round has a 30 second timer
Duplicate words from previous rounds are not allowed
Missed input is counted as (no guess)
Players can also choose to play with an AI teammate instead of another human.

**Features**

Real time multiplayer using WebSockets
Play with a human teammate or AI teammate
AI teammate powered by OpenAI Responses API
Room codes for easy sharing
Round timer and inactivity handling
Duplicate word prevention
Clean, responsive UI
Designed for easy deployment and portfolio use

Tech Stack

Frontend, 
Vanilla JavaScript, 
HTML and CSS, 
Socket.IO client, 
Backend, 
Node.js, 
Express, 
Socket.IO server, 
AI Service, 
Python, 
FastAPI, 
OpenAI Responses API, 
HTTPX async client

## Architecture Overview

**Synergy Web App (Google Cloud Run)**
- Client (Browser UI)
  - Lobby UI
    - Display name input
    - Create room, join room, play with AI
    - Room code display and copy
  - Game UI
    - Teammate list and status
    - 3..2..1 countdown
    - 30 second round timer
    - Word submission form and input locking
    - Round history table
  - Results UI
    - Match result and win screen
    - Rematch flow
    - Return to lobby
  - Socket.IO Client
    - Real time room updates
    - Word submission events
    - Countdown and deadline synchronization

- Realtime Game Server (Node.js, Express, Socket.IO)
  - Static asset hosting
    - Serves frontend from `/public`
    - Health endpoint (`GET /healthz`)
  - Room orchestration
    - Create room, join by code, leave handling
    - Human vs Human and Human vs AI modes
    - Disconnect handling and room cleanup
    - Inactivity timeout and auto close
  - Round engine
    - Countdown orchestration (3..2..1)
    - 30 second server enforced deadline
    - Submission tracking and round resolution
    - Match detection and win condition
    - Rematch voting and reset
  - Validation
    - Duplicate word prevention across rounds
    - `(no guess)` handling for missed submissions

**AI Backend Service (FastAPI, Google Cloud Run)**
- REST API
  - Next word endpoint (`POST /nextword`)
  - Health endpoint (`GET /healthz`)
- Word generation pipeline
  - Prompting for convergent teammate matching
  - Exclude list support to avoid repeats
  - Output sanitization (single lowercase word)
  - Fallback seed words if OpenAI is unavailable

**External Services**
- OpenAI Responses API
  - Generates the AI teammate's next word using the previous round pair
  - Only called from the AI backend service

All AI requests are routed through the AI backend.  
Client side code never exposes API keys.



**AI Behavior Summary**

The AI teammate:
Sees only the previous round word pair and
attempts to converge on the most obvious shared association.
Avoids repeating any previously used words.
Falls back to neutral seed words if needed.
Runs entirely server side to keep API keys secure

**Why This Project**

This project demonstrates:
Real time multiplayer system design, 
WebSocket based game state synchronization, 
Clean client server separation, 
Secure AI integration with no client exposed secrets, 
Cloud native deployment on Google Cloud Run, 
Production ready structure suitable for scaling, 
This project is designed to be showcased directly via its live deployment and does not require Chrome Web Store publication.

Author
Eric Xu
