**Synergy**


Synergy is a real time cooperative word association game where two players attempt to independently submit the same word. Players must think alike without communicating directly. The game supports both human teammates and an AI teammate powered by OpenAI.

This project demonstrates full stack development with real time networking, AI integration, and production ready deployment practices.

How the Game Works

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

Frontend
Vanilla JavaScript
HTML and CSS
Socket.IO client
Backend
Node.js
Express
Socket.IO server
AI Service
Python
FastAPI
OpenAI Responses API
HTTPX async client
