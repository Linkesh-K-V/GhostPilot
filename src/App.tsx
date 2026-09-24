import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import Tesseract from "tesseract.js";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [useScreenContext, setUseScreenContext] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [opacity, setOpacity] = useState(0.92);

  const recognitionRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  // NATIVE ENGINE LOCKS (Synchronous bypass for React state delays)
  const isRecognizingRef = useRef(false);
  const inputRef = useRef("");

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 120)}px`;
    }
  }, [input]);

  // --------------------------------------------------
  // CRASH-PROOF AUDIO SETUP
  // --------------------------------------------------
  useEffect(() => {
    // @ts-ignore
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SpeechRecognition) {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-US";

      // Track exact native engine state
      recognition.onstart = () => {
        isRecognizingRef.current = true;
      };

      recognition.onresult = (event: any) => {
        let transcript = "";
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        setInput(transcript);
      };

      recognition.onerror = (event: any) => {
        console.warn("Mic Error:", event.error);
        if (event.error !== 'no-speech') {
          isRecognizingRef.current = false;
          setIsListening(false);
        }
      };

      recognition.onend = () => {
        isRecognizingRef.current = false;
        setIsListening(false);
      };

      recognitionRef.current = recognition;
    }
  }, []);

  const safeStopMic = () => {
    try {
      if (recognitionRef.current && isRecognizingRef.current) {
        recognitionRef.current.stop();
      }
    } catch (e) {
      console.warn("Safely caught mic stop exception", e);
    } finally {
      isRecognizingRef.current = false;
      setIsListening(false);
    }
  };

  const toggleListen = () => {
    if (!recognitionRef.current) return;
    
    if (isListening) {
      // 1. Stop mic safely
      safeStopMic();
      
      // 2. Auto-submit transcribed text (slight delay allows state to settle)
      setTimeout(() => {
        if (inputRef.current.trim()) {
          askModel(inputRef.current);
        }
      }, 50);
      
    } else {
      // Start mic safely
      setInput(""); 
      setIsListening(true);
      
      try {
        if (!isRecognizingRef.current) {
          recognitionRef.current.start();
        }
      } catch (e) {
        console.warn("Safely caught mic start exception", e);
        setIsListening(false);
        isRecognizingRef.current = false;
      }
    }
  };

  // --------------------------------------------------
  // AI EXECUTION & STREAMING
  // --------------------------------------------------
  const askModel = async (overrideInput?: string | React.MouseEvent | React.KeyboardEvent) => {
    const finalQuery = typeof overrideInput === "string" ? overrideInput : input;
    const userQuery = finalQuery.trim();
    
    if (!userQuery || loading) return;

    if (isListening) {
       safeStopMic();
    }

    setInput("");
    setLoading(true);

    const newUserMsg: Message = { id: Date.now().toString(), role: "user", content: userQuery };
    setMessages((prev) => [...prev, newUserMsg]);

    let screenText = "";
    let systemStatusMsgId = (Date.now() + 1).toString();

    if (useScreenContext) {
      setMessages((prev) => [...prev, { id: systemStatusMsgId, role: "assistant", content: "🔍 Scanning visual context..." }]);
      try {
        const base64Image = await invoke<string>("capture_screen");
        const { data } = await Tesseract.recognize(base64Image, "eng");
        
        if (data.text.trim()) {
          screenText = `\n\n[SYSTEM CONTEXT: CURRENT VISIBLE SCREEN DATA]\n${data.text}\n[END SYSTEM CONTEXT]\n`;
        }
      } catch (e: any) {
        console.error("Vision Error:", e);
      }
      setMessages((prev) => prev.filter(m => m.id !== systemStatusMsgId));
    }

    const finalPrompt = screenText ? `${screenText}\nUser Query: ${userQuery}` : userQuery;
    
    const assistantMsgId = (Date.now() + 2).toString();
    setMessages((prev) => [...prev, { id: assistantMsgId, role: "assistant", content: "" }]);

    try {
      const apiMessages = [
        {
          role: "system",
          content: "You are GhostPilot, an elite local technical engineering assistant. Provide highly accurate, concise answers. Format code using standard markdown blocks. Prioritize technical exactness for systems engineering, machine learning, and advanced development."
        },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: finalPrompt }
      ];

      const res = await fetch("http://127.0.0.1:8080/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: apiMessages,
          stream: true,
          temperature: 0.15,
          max_tokens: 2048
        }),
      });

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      if (!reader) throw new Error("Stream failed");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n").filter((l) => l.trim() !== "");

        for (const line of lines) {
          if (line.includes("[DONE]")) return;
          if (line.startsWith("data:")) {
            try {
              const parsed = JSON.parse(line.replace("data: ", ""));
              const token = parsed.choices?.[0]?.delta?.content;
              if (token) {
                setMessages((prev) => 
                  prev.map((msg) => 
                    msg.id === assistantMsgId ? { ...msg, content: msg.content + token } : msg
                  )
                );
              }
            } catch {}
          }
        }
      }
    } catch (error) {
      setMessages((prev) => 
        prev.map((msg) => 
          msg.id === assistantMsgId ? { ...msg, content: "⚠️ Local engine communication failure. Verify llama-server is running." } : msg
        )
      );
    } finally {
      setLoading(false);
    }
  };

  // --------------------------------------------------
  // UI UTILITIES (Markdown & Code Blocks)
  // --------------------------------------------------
  const renderMessageContent = (content: string) => {
    const parts = content.split(/(```[\s\S]*?```)/g);
    
    return parts.map((part, idx) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        const rawCode = part.slice(3, -3);
        const langMatch = rawCode.match(/^.*\n/);
        const lang = langMatch ? langMatch[0].trim() : "code";
        const code = langMatch ? rawCode.replace(/^.*\n/, "") : rawCode;

        return (
          <div key={idx} style={{ margin: "12px 0", borderRadius: "8px", background: "rgba(0,0,0,0.4)", border: "1px solid rgba(255,255,255,0.08)", overflow: "hidden", pointerEvents: "auto" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 12px", background: "rgba(255,255,255,0.03)", borderBottom: "1px solid rgba(255,255,255,0.05)", fontSize: "10px", color: "#94a3b8", fontFamily: "monospace" }}>
              <span>{lang}</span>
              <button 
                onClick={() => navigator.clipboard.writeText(code)}
                style={{ background: "transparent", border: "none", color: "#38bdf8", cursor: "pointer", fontSize: "10px" }}
              >
                Copy
              </button>
            </div>
            <pre style={{ margin: 0, padding: "12px", overflowX: "auto", fontSize: "12px", fontFamily: "monospace", color: "#e2e8f0" }}>
              <code>{code}</code>
            </pre>
          </div>
        );
      }
      return <span key={idx} style={{ pointerEvents: "auto" }}>{part}</span>;
    });
  };

  // --------------------------------------------------
  // RENDER
  // --------------------------------------------------
  return (
    <div
      data-tauri-drag-region
      style={{
        width: "100vw", height: "100vh",
        background: `rgba(9, 9, 11, ${opacity})`,
        color: "#cbd5e1",
        fontFamily: "Inter, system-ui, sans-serif",
        display: "flex", flexDirection: "column",
        overflow: "hidden", borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.06)",
        boxShadow: "0 25px 80px rgba(0,0,0,0.9)",
        boxSizing: "border-box", backdropFilter: "blur(20px)",
        pointerEvents: "none"
      }}
    >
      <header
        data-tauri-drag-region
        style={{
          height: "48px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "0 16px", background: "rgba(9, 9, 11, 0.6)",
          borderBottom: "1px solid rgba(255,255,255,0.04)",
          pointerEvents: "auto", cursor: "grab"
        }}
      >
        <div data-tauri-drag-region style={{ display: "flex", alignItems: "center", gap: "12px", pointerEvents: "none" }}>
          <div style={{ width: "8px", height: "8px", borderRadius: "50%", background: "#10b981", boxShadow: "0 0 10px rgba(16, 185, 129, 0.5)" }} />
          <div style={{ fontSize: "12px", fontWeight: 700, letterSpacing: "0.1em", color: "#f8fafc" }}>
            GHOST<span style={{ color: "#64748b" }}>PILOT</span>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "12px", pointerEvents: "auto" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", opacity: 0.7 }}>
            <span style={{ fontSize: "9px", fontWeight: 600, letterSpacing: "0.05em" }}>HUD</span>
            <input 
              type="range" min="0.1" max="0.95" step="0.05" value={opacity}
              onChange={(e) => setOpacity(parseFloat(e.target.value))}
              style={{ width: "60px", height: "2px", accentColor: "#94a3b8", cursor: "pointer" }}
            />
          </div>

          <button
            onClick={() => setUseScreenContext(!useScreenContext)}
            style={{
              padding: "4px 10px", borderRadius: "4px",
              background: useScreenContext ? "rgba(56, 189, 248, 0.1)" : "transparent",
              border: useScreenContext ? "1px solid rgba(56, 189, 248, 0.3)" : "1px solid rgba(255,255,255,0.1)",
              color: useScreenContext ? "#38bdf8" : "#94a3b8",
              fontSize: "10px", fontWeight: 600, cursor: "pointer", transition: "all 0.2s"
            }}
          >
            {useScreenContext ? "VISION: ACTIVE" : "VISION: OFF"}
          </button>
        </div>
      </header>

      <main style={{ flex: 1, overflowY: "auto", padding: "24px", position: "relative", pointerEvents: "none" }}>
        {messages.length === 0 ? (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", opacity: 0.8, pointerEvents: "none" }}>
            <div style={{ fontSize: "24px", marginBottom: "16px", color: "#38bdf8" }}>⬡</div>
            <h3 style={{ fontSize: "14px", color: "#f8fafc", margin: "0 0 8px 0", fontWeight: 500 }}>System Initialized</h3>
            <p style={{ fontSize: "12px", color: "#64748b", margin: "0 0 24px 0", textAlign: "center", maxWidth: "300px", lineHeight: "1.6" }}>
              Local engine operational. Awaiting engineering parameters, visual context, or system logs.
            </p>
            
            <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center", maxWidth: "400px", pointerEvents: "auto" }}>
              {[
                { label: "Debug STM32 code", prompt: "Can you analyze the embedded C code on my screen for STM32 initialization errors?" },
                { label: "Gazebo URDF", prompt: "Review my URDF file and suggest kinematics improvements for an omnidirectional chassis." },
                { label: "Optimize CNN", prompt: "How can I optimize this convolutional neural network architecture for faster inference?" },
                { label: "Hough Transform", prompt: "Explain the mathematics behind using a Hough Transform for autonomous lane tracking." }
              ].map((item, idx) => (
                <button 
                  key={idx}
                  onClick={() => askModel(item.prompt)}
                  style={{ padding: "6px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: "6px", color: "#94a3b8", fontSize: "11px", cursor: "pointer" }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ maxWidth: "800px", margin: "0 auto", display: "flex", flexDirection: "column", gap: "20px" }}>
            {messages.map((msg) => (
              <div key={msg.id} style={{ display: "flex", flexDirection: "column", alignItems: msg.role === "user" ? "flex-end" : "flex-start", pointerEvents: "none" }}>
                <div style={{ fontSize: "10px", color: "#475569", marginBottom: "6px", fontWeight: 600, letterSpacing: "0.05em", textTransform: "uppercase" }}>
                  {msg.role === "user" ? "USER" : "GHOSTPILOT"}
                </div>
                <div style={{
                  maxWidth: "85%",
                  padding: msg.role === "user" ? "10px 14px" : "0",
                  background: msg.role === "user" ? "rgba(56, 189, 248, 0.1)" : "transparent",
                  border: msg.role === "user" ? "1px solid rgba(56, 189, 248, 0.2)" : "none",
                  borderRadius: "8px",
                  color: msg.role === "user" ? "#f8fafc" : "#cbd5e1",
                  fontSize: "13px", lineHeight: "1.6", whiteSpace: "pre-wrap", wordBreak: "break-word",
                  pointerEvents: "auto"
                }}>
                  {msg.role === "user" ? msg.content : renderMessageContent(msg.content)}
                </div>
              </div>
            ))}
            {loading && <div style={{ fontSize: "12px", color: "#38bdf8", animation: "pulse 1.5s infinite" }}>Processing...</div>}
            <div ref={chatEndRef} />
          </div>
        )}
      </main>

      <footer style={{ padding: "16px", background: "rgba(9, 9, 11, 0.8)", borderTop: "1px solid rgba(255,255,255,0.04)", pointerEvents: "auto" }}>
        <div style={{ maxWidth: "800px", margin: "0 auto", display: "flex", alignItems: "flex-end", gap: "10px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "8px", padding: "8px" }}>
          
          <button
            onClick={toggleListen}
            style={{
              width: "32px", height: "32px", flexShrink: 0, borderRadius: "6px",
              background: isListening ? "rgba(239, 68, 68, 0.1)" : "transparent",
              border: "none", color: isListening ? "#ef4444" : "#64748b",
              cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center"
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
          </button>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                askModel();
              }
            }}
            placeholder={isListening ? "Listening..." : "Provide systems parameters or query..."}
            style={{
              flex: 1, minHeight: "20px", maxHeight: "120px", background: "transparent", border: "none", outline: "none",
              color: "#f8fafc", fontSize: "13px", resize: "none", padding: "6px 0", fontFamily: "inherit"
            }}
          />

          <button
            onClick={() => askModel()}
            disabled={loading || !input.trim()}
            style={{
              width: "32px", height: "32px", flexShrink: 0, borderRadius: "6px",
              background: loading || !input.trim() ? "rgba(255,255,255,0.05)" : "#38bdf8",
              border: "none", color: loading || !input.trim() ? "#475569" : "#0f172a",
              cursor: loading || !input.trim() ? "default" : "pointer",
              display: "flex", alignItems: "center", justifyContent: "center"
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
          </button>
        </div>
      </footer>

      <style>{`
        ::-webkit-scrollbar { display: none !important; }
        * { scrollbar-width: none !important; }
        @keyframes pulse { 0% { opacity: 0.6; } 50% { opacity: 1; } 100% { opacity: 0.6; } }
      `}</style>
    </div>
  );
}