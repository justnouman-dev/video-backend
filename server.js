const express = require("express");
const cors = require("cors");
const { exec } = require("child_process");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 3001;
const VIDEOS_DIR = path.join(__dirname, "videos");

// Ensure videos directory exists
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use("/videos", express.static(VIDEOS_DIR));

// Health check
app.get("/", (req, res) => res.json({ status: "ok", message: "HLS Converter API running" }));

// Validate URL
function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

// Download video using axios with streaming
async function downloadVideo(url, destPath, onProgress) {
  onProgress("Downloading video...");
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

// Convert to HLS using FFmpeg
function convertToHLS(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, "playlist.m3u8");
    const cmd = `ffmpeg -i "${inputPath}" -hls_time 5 -hls_list_size 0 -f hls "${playlistPath}"`;

    exec(cmd, { timeout: 300000 }, (error, stdout, stderr) => {
      if (error) {
        console.error("FFmpeg error:", stderr);
        return reject(new Error("FFmpeg conversion failed: " + stderr.slice(-300)));
      }
      resolve(playlistPath);
    });
  });
}

// POST /convert
app.post("/convert", async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing URL." });
  }

  const id = uuidv4();
  const videoDir = path.join(VIDEOS_DIR, id);
  fs.mkdirSync(videoDir, { recursive: true });

  const inputPath = path.join(videoDir, "input.mp4");

  try {
    // Download
    await downloadVideo(url, inputPath, console.log);

    // Verify file downloaded
    const stat = fs.statSync(inputPath);
    if (stat.size === 0) throw new Error("Downloaded file is empty.");

    // Convert
    console.log("Converting to HLS...");
    await convertToHLS(inputPath, videoDir);

    // Build stream URL
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const streamUrl = `${baseUrl}/videos/${id}/playlist.m3u8`;

    res.json({ streamUrl, id });
  } catch (err) {
    console.error("Conversion error:", err.message);

    // Cleanup on error
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch {}

    const msg = err.message.toLowerCase();
    if (msg.includes("download") || msg.includes("axios") || msg.includes("econnrefused")) {
      res.status(502).json({ error: "Failed to download video. Check the URL and try again." });
    } else if (msg.includes("ffmpeg")) {
      res.status(500).json({ error: "Video conversion failed. The file may not be a supported format." });
    } else {
      res.status(500).json({ error: err.message || "Unexpected server error." });
    }
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
