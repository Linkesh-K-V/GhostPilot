# ⬡ GhostPilot

GhostPilot is a stealth, local-first technical AI copilot designed for software engineering, embedded systems, and robotics workflows. Built as a borderless, click-through desktop HUD, it runs completely offline using a local LLM backend.

## ✨ Features
* **Local Intelligence Engine:** Connects to a local `llama-server` (running models like Qwen2.5-Coder) for zero-latency, private inference.
* **Stealth Desktop HUD:** Features a transparent, glassmorphism UI with native click-through support. The app hovers seamlessly over your IDE or terminal without blocking mouse interactions.
* **Screen Context (Vision OCR):** Utilizes `tesseract.js` and native Rust screen capture to read your current active window and feed code/logs directly to the LLM.
* **Voice Dictation (Auto-Submit):** Integrated Speech-to-Text for hands-free queries. 
* **Engineering-Tuned UI:** Custom markdown parsers for rendering isolated code blocks with one-click copy functionality.

## 🛠️ Tech Stack
* **Frontend:** React, TypeScript, Vite
* **Backend Framework:** Tauri v2, Rust
* **AI Integration:** Local `llama-server.exe` (GGUF Models)
* **Vision/OCR:** Tesseract.js, `image`, `xcap` crates
* **Audio:** Web Speech API (WebView2)

## 🚀 Getting Started

### Prerequisites
1. [Node.js](https://nodejs.org/) installed.
2. [Rust](https://www.rust-lang.org/) and Cargo installed.
3. A local LLM server running on port `8080` (e.g., `llama-server.exe --port 8080`).

### Installation
```bash
# Clone the repository
git clone [https://github.com/yourusername/ghost-pilot.git](https://github.com/yourusername/ghost-pilot.git)

# Navigate into the directory
cd ghost-pilot

# Install frontend dependencies
npm install

# Run the desktop app in development mode
npm run tauri dev