import { useState, useRef, useCallback } from "react";

const SPACE_API = "https://lightricks-ltx-video-distilled.hf.space";

const STATUS_STAGES = [
  "Initializing model...",
  "Processing your input...",
  "Generating frames...",
  "Rendering video...",
  "Finalizing output...",
];

function GlowOrb({ style }) {
  return <div style={{ position: "absolute", borderRadius: "50%", filter: "blur(80px)", opacity: 0.18, pointerEvents: "none", ...style }} />;
}

function Particle({ style }) {
  return <div style={{ position: "absolute", width: 2, height: 2, borderRadius: "50%", background: "#a78bfa", opacity: 0.5, ...style }} />;
}

export default function CymorVideoAI() {
  const [mode, setMode] = useState("text"); // "text" | "image"
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("blurry, low quality, distorted, watermark");
  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusIdx, setStatusIdx] = useState(0);
  const [videoUrl, setVideoUrl] = useState(null);
  const [error, setError] = useState(null);
  const [frames, setFrames] = useState(49);
  const [steps, setSteps] = useState(4);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef();
  const statusInterval = useRef(null);

  const startStatusCycle = () => {
    let i = 0;
    setStatusIdx(0);
    statusInterval.current = setInterval(() => {
      i = (i + 1) % STATUS_STAGES.length;
      setStatusIdx(i);
    }, 4000);
  };

  const stopStatusCycle = () => {
    clearInterval(statusInterval.current);
  };

  const handleImageDrop = useCallback((e) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer?.files?.[0] || e.target?.files?.[0];
    if (!file) return;
    setImageFile(file);
    setImagePreview(URL.createObjectURL(file));
  }, []);

  const toBase64 = (file) =>
    new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = rej;
      r.readAsDataURL(file);
    });

  const generate = async () => {
    if (!prompt.trim()) { setError("Please enter a prompt."); return; }
    if (mode === "image" && !imageFile) { setError("Please upload a reference image."); return; }
    setError(null);
    setVideoUrl(null);
    setLoading(true);
    startStatusCycle();

    try {
      // Step 1: Upload image if needed (image-to-video mode)
      let imageData = null;
      if (mode === "image" && imageFile) {
        const base64 = await toBase64(imageFile);
        // Upload to HF space as a file
        const uploadRes = await fetch(`${SPACE_API}/upload`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify([{ name: imageFile.name, data: base64 }]),
        });
        if (uploadRes.ok) {
          const uploadJson = await uploadRes.json();
          imageData = uploadJson?.[0]?.name || null;
        }
      }

      // Step 2: Queue the prediction
      const payload = mode === "text"
        ? {
            data: [
              prompt,
              negPrompt,
              null,      // image_input
              frames,    // num_frames
              steps,     // num_inference_steps
              0.9,       // guidance_scale (for distilled = 1.0 effectively)
              704,       // height
              1216,      // width
              Math.floor(Math.random() * 999999), // seed
            ],
          }
        : {
            data: [
              prompt,
              negPrompt,
              imageData ? { path: imageData } : null,
              frames,
              steps,
              0.9,
              704,
              1216,
              Math.floor(Math.random() * 999999),
            ],
          };

      const queueRes = await fetch(`${SPACE_API}/queue/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, fn_index: 0, session_hash: Math.random().toString(36).slice(2) }),
      });

      if (!queueRes.ok) throw new Error("Failed to queue generation request.");
      const { event_id } = await queueRes.json();

      // Step 3: Poll for result via SSE or polling
      // Use EventSource for SSE stream
      await new Promise((resolve, reject) => {
        const session_hash = Math.random().toString(36).slice(2);

        // Re-submit with session hash
        fetch(`${SPACE_API}/queue/join`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            fn_index: 0,
            session_hash,
          }),
        }).then(() => {
          const es = new EventSource(`${SPACE_API}/queue/data?session_hash=${session_hash}`);
          es.onmessage = (e) => {
            try {
              const msg = JSON.parse(e.data);
              if (msg.msg === "process_completed") {
                es.close();
                const output = msg.output?.data?.[0];
                if (output?.video?.url) {
                  setVideoUrl(output.video.url);
                } else if (output?.url) {
                  setVideoUrl(output.url);
                } else if (typeof output === "string" && output.startsWith("http")) {
                  setVideoUrl(output);
                } else {
                  // Try to find video in output
                  const allData = msg.output?.data || [];
                  const found = allData.find(d => d?.video?.url || d?.url || (typeof d === "string" && d.includes("http")));
                  if (found) {
                    setVideoUrl(found?.video?.url || found?.url || found);
                  } else {
                    reject(new Error("Video URL not found in response."));
                  }
                }
                resolve();
              } else if (msg.msg === "queue_full") {
                es.close();
                reject(new Error("HuggingFace queue is full. Please try again in a moment."));
              } else if (msg.msg === "process_errored") {
                es.close();
                reject(new Error(msg.output?.error || "Generation failed on server."));
              }
            } catch {}
          };
          es.onerror = () => {
            es.close();
            reject(new Error("Connection to HuggingFace lost. Please try again."));
          };
          // Timeout after 3 minutes
          setTimeout(() => { es.close(); reject(new Error("Generation timed out. Try a shorter video (fewer frames).")); }, 180000);
        });
      });

    } catch (err) {
      setError(err.message || "Something went wrong. Please try again.");
    } finally {
      stopStatusCycle();
      setLoading(false);
    }
  };

  const particles = Array.from({ length: 18 }, (_, i) => ({
    left: `${(i * 17 + 5) % 100}%`,
    top: `${(i * 23 + 10) % 100}%`,
    animationDelay: `${i * 0.4}s`,
  }));

  return (
    <div style={{
      minHeight: "100vh",
      background: "#04020f",
      color: "#f0ebff",
      fontFamily: "'Syne', 'Space Grotesk', sans-serif",
      position: "relative",
      overflow: "hidden",
    }}>
      {/* Ambient orbs */}
      <GlowOrb style={{ width: 600, height: 600, background: "#7c3aed", top: -200, left: -200 }} />
      <GlowOrb style={{ width: 500, height: 500, background: "#4f46e5", bottom: -100, right: -150 }} />
      <GlowOrb style={{ width: 300, height: 300, background: "#ec4899", top: "40%", left: "60%" }} />

      {/* Particles */}
      {particles.map((p, i) => <Particle key={i} style={p} />)}

      {/* Grid overlay */}
      <div style={{
        position: "fixed", inset: 0, pointerEvents: "none",
        backgroundImage: "linear-gradient(rgba(124,58,237,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(124,58,237,0.04) 1px, transparent 1px)",
        backgroundSize: "60px 60px",
      }} />

      <div style={{ position: "relative", zIndex: 1, maxWidth: 820, margin: "0 auto", padding: "40px 20px 80px" }}>
        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 48 }}>
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 10,
            background: "rgba(124,58,237,0.15)", border: "1px solid rgba(124,58,237,0.3)",
            borderRadius: 40, padding: "6px 18px", marginBottom: 20,
            fontSize: 12, letterSpacing: 3, color: "#a78bfa", textTransform: "uppercase",
          }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#a78bfa", display: "inline-block", boxShadow: "0 0 8px #a78bfa", animation: "pulse 2s infinite" }} />
            AI Video Generator
          </div>

          <h1 style={{
            fontSize: "clamp(2.4rem, 6vw, 4rem)",
            fontWeight: 800, margin: 0, lineHeight: 1.1,
            background: "linear-gradient(135deg, #e0d7ff 0%, #a78bfa 40%, #ec4899 100%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
            letterSpacing: "-1px",
          }}>
            CYMOR
          </h1>
          <p style={{ color: "#8b7aa8", marginTop: 10, fontSize: 15, letterSpacing: 2 }}>
            TEXT · IMAGE · VIDEO
          </p>
        </div>

        {/* Mode Toggle */}
        <div style={{
          display: "flex", gap: 8, background: "rgba(255,255,255,0.04)",
          borderRadius: 16, padding: 6, marginBottom: 28,
          border: "1px solid rgba(255,255,255,0.07)",
        }}>
          {["text", "image"].map((m) => (
            <button key={m} onClick={() => { setMode(m); setVideoUrl(null); setError(null); }} style={{
              flex: 1, padding: "12px 0", borderRadius: 12, border: "none", cursor: "pointer",
              fontWeight: 700, fontSize: 14, letterSpacing: 1.5, textTransform: "uppercase",
              transition: "all 0.25s",
              background: mode === m
                ? "linear-gradient(135deg, #7c3aed, #4f46e5)"
                : "transparent",
              color: mode === m ? "#fff" : "#6b5f8a",
              boxShadow: mode === m ? "0 4px 20px rgba(124,58,237,0.4)" : "none",
            }}>
              {m === "text" ? "✦ Text to Video" : "⬡ Image to Video"}
            </button>
          ))}
        </div>

        {/* Main Card */}
        <div style={{
          background: "rgba(255,255,255,0.03)",
          border: "1px solid rgba(255,255,255,0.08)",
          borderRadius: 24, padding: 28,
          backdropFilter: "blur(20px)",
          boxShadow: "0 24px 80px rgba(0,0,0,0.5)",
        }}>
          {/* Image Upload (image mode) */}
          {mode === "image" && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleImageDrop}
              onClick={() => fileRef.current.click()}
              style={{
                marginBottom: 20, borderRadius: 16, cursor: "pointer",
                border: `2px dashed ${dragOver ? "#a78bfa" : "rgba(124,58,237,0.3)"}`,
                background: dragOver ? "rgba(124,58,237,0.08)" : "rgba(255,255,255,0.02)",
                transition: "all 0.2s", overflow: "hidden",
                minHeight: 160, display: "flex", alignItems: "center", justifyContent: "center",
              }}
            >
              <input ref={fileRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleImageDrop} />
              {imagePreview ? (
                <div style={{ position: "relative", width: "100%" }}>
                  <img src={imagePreview} alt="reference" style={{ width: "100%", maxHeight: 280, objectFit: "cover", borderRadius: 14, display: "block" }} />
                  <div style={{
                    position: "absolute", bottom: 10, right: 10,
                    background: "rgba(124,58,237,0.9)", color: "#fff",
                    fontSize: 11, padding: "4px 10px", borderRadius: 20, letterSpacing: 1,
                  }}>REFERENCE IMAGE</div>
                </div>
              ) : (
                <div style={{ textAlign: "center", padding: 30 }}>
                  <div style={{ fontSize: 36, marginBottom: 10 }}>⬡</div>
                  <div style={{ color: "#8b7aa8", fontSize: 14 }}>Drop image here or <span style={{ color: "#a78bfa" }}>click to upload</span></div>
                  <div style={{ color: "#5a4f6e", fontSize: 12, marginTop: 6 }}>JPG, PNG, WebP — used as visual reference</div>
                </div>
              )}
            </div>
          )}

          {/* Prompt */}
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", color: "#8b7aa8", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>
              Prompt
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={mode === "text"
                ? "A cinematic aerial shot of a cyberpunk city at night, neon reflections on wet streets, slow dolly movement..."
                : "Animate this image with gentle wind, realistic motion, cinematic depth of field..."}
              style={{
                width: "100%", minHeight: 100, background: "rgba(255,255,255,0.04)",
                border: "1px solid rgba(255,255,255,0.1)", borderRadius: 14, padding: 16,
                color: "#f0ebff", fontSize: 14, resize: "vertical", outline: "none",
                fontFamily: "inherit", lineHeight: 1.6, boxSizing: "border-box",
                transition: "border-color 0.2s",
              }}
              onFocus={(e) => e.target.style.borderColor = "rgba(124,58,237,0.6)"}
              onBlur={(e) => e.target.style.borderColor = "rgba(255,255,255,0.1)"}
            />
          </div>

          {/* Negative Prompt */}
          <div style={{ marginBottom: 20 }}>
            <label style={{ display: "block", color: "#8b7aa8", fontSize: 11, letterSpacing: 2, textTransform: "uppercase", marginBottom: 8 }}>
              Negative Prompt
            </label>
            <input
              value={negPrompt}
              onChange={(e) => setNegPrompt(e.target.value)}
              style={{
                width: "100%", background: "rgba(255,255,255,0.03)",
                border: "1px solid rgba(255,255,255,0.07)", borderRadius: 12, padding: "12px 16px",
                color: "#8b7aa8", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box",
              }}
            />
          </div>

          {/* Settings Row */}
          <div style={{ display: "flex", gap: 16, marginBottom: 24 }}>
            {[
              { label: "Frames", value: frames, set: setFrames, min: 25, max: 121, step: 8, hint: `~${(frames / 24).toFixed(1)}s` },
              { label: "Steps", value: steps, set: setSteps, min: 2, max: 8, step: 1, hint: `quality` },
            ].map(({ label, value, set, min, max, step, hint }) => (
              <div key={label} style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ color: "#8b7aa8", fontSize: 11, letterSpacing: 2, textTransform: "uppercase" }}>{label}</span>
                  <span style={{ color: "#a78bfa", fontSize: 13, fontWeight: 700 }}>{value} <span style={{ color: "#5a4f6e", fontWeight: 400, fontSize: 11 }}>({hint})</span></span>
                </div>
                <input type="range" min={min} max={max} step={step} value={value}
                  onChange={(e) => set(Number(e.target.value))}
                  style={{ width: "100%", accentColor: "#7c3aed" }}
                />
              </div>
            ))}
          </div>

          {/* Generate Button */}
          <button
            onClick={generate}
            disabled={loading}
            style={{
              width: "100%", padding: "16px 0", borderRadius: 16, border: "none", cursor: loading ? "not-allowed" : "pointer",
              background: loading
                ? "rgba(124,58,237,0.2)"
                : "linear-gradient(135deg, #7c3aed 0%, #4f46e5 50%, #ec4899 100%)",
              color: "#fff", fontWeight: 800, fontSize: 15, letterSpacing: 2, textTransform: "uppercase",
              boxShadow: loading ? "none" : "0 8px 32px rgba(124,58,237,0.5)",
              transition: "all 0.3s",
              position: "relative", overflow: "hidden",
            }}
          >
            {loading ? (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
                <span style={{
                  width: 16, height: 16, border: "2px solid rgba(255,255,255,0.3)",
                  borderTopColor: "#fff", borderRadius: "50%",
                  display: "inline-block", animation: "spin 0.8s linear infinite",
                }} />
                {STATUS_STAGES[statusIdx]}
              </span>
            ) : "✦ Generate Video"}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 20, padding: "16px 20px", borderRadius: 14,
            background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)",
            color: "#fca5a5", fontSize: 14,
          }}>
            ⚠ {error}
          </div>
        )}

        {/* Video Output */}
        {videoUrl && (
          <div style={{
            marginTop: 28, borderRadius: 24, overflow: "hidden",
            border: "1px solid rgba(124,58,237,0.3)",
            boxShadow: "0 0 60px rgba(124,58,237,0.2)",
          }}>
            <div style={{
              background: "rgba(124,58,237,0.1)", padding: "12px 20px",
              display: "flex", alignItems: "center", justifyContent: "space-between",
              borderBottom: "1px solid rgba(124,58,237,0.2)",
            }}>
              <span style={{ color: "#a78bfa", fontSize: 12, letterSpacing: 2, textTransform: "uppercase", fontWeight: 700 }}>
                ✦ Video Generated
              </span>
              <a href={videoUrl} download="cymor-video.mp4" style={{
                color: "#a78bfa", fontSize: 12, textDecoration: "none",
                background: "rgba(124,58,237,0.2)", padding: "4px 14px", borderRadius: 20,
                border: "1px solid rgba(124,58,237,0.4)", letterSpacing: 1,
              }}>↓ Download</a>
            </div>
            <video
              src={videoUrl} controls autoPlay loop muted
              style={{ width: "100%", display: "block", background: "#000", maxHeight: 480 }}
            />
          </div>
        )}

        {/* Footer */}
        <div style={{ textAlign: "center", marginTop: 48, color: "#3d3450", fontSize: 12, letterSpacing: 1 }}>
          CYMOR VIDEO AI · POWERED BY LTX-VIDEO (LIGHTRICKS) · FREE VIA HUGGING FACE
        </div>
      </div>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&display=swap');
        * { box-sizing: border-box; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(124,58,237,0.4); border-radius: 4px; }
        input[type=range] { -webkit-appearance: none; height: 4px; border-radius: 4px; background: rgba(255,255,255,0.08); }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 16px; border-radius: 50%; background: #7c3aed; cursor: pointer; box-shadow: 0 0 8px rgba(124,58,237,0.6); }
      `}</style>
    </div>
  );
}
