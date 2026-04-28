const express = require("express");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");
const axios = require("axios");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 3001;
const VIDEOS_DIR = path.join(__dirname, "videos");

if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use("/videos", express.static(VIDEOS_DIR));

app.get("/", (req, res) => res.json({ status: "ok", message: "HLS Converter API running" }));

function isValidUrl(string) {
  try {
    const url = new URL(string);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function downloadVideo(url, destPath) {
  const response = await axios({
    method: "GET",
    url,
    responseType: "stream",
    timeout: 120000,
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  return new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });
}

function convertToHLS(inputPath, outputDir) {
  return new Promise((resolve, reject) => {
    const playlistPath = path.join(outputDir, "playlist.m3u8");

    ffmpeg(inputPath)
      .outputOptions([
        "-hls_time 5",
        "-hls_list_size 0",
        "-f hls"
      ])
      .output(playlistPath)
      .on("end", () => resolve(playlistPath))
      .on("error", () => reject(new Error("FFmpeg conversion failed")))
      .run();
  });
}

app.post("/convert", async (req, res) => {
  const { url } = req.body;

  if (!url || !isValidUrl(url)) {
    return res.status(400).json({ error: "Invalid or missing URL." });
  }

  if (!url.endsWith(".mp4")) {
    return res.status(400).json({ error: "Only .mp4 links supported for conversion" });
  }

  const id = uuidv4();
  const videoDir = path.join(VIDEOS_DIR, id);
  fs.mkdirSync(videoDir, { recursive: true });

  const inputPath = path.join(videoDir, "input.mp4");

  try {
    await downloadVideo(url, inputPath);

    const stat = fs.statSync(inputPath);
    if (stat.size === 0) throw new Error("Downloaded file is empty.");

    await convertToHLS(inputPath, videoDir);

    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    const streamUrl = `${baseUrl}/videos/${id}/playlist.m3u8`;

    res.json({ streamUrl, id });
  } catch (err) {
    try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch {}

    const msg = err.message.toLowerCase();
    if (msg.includes("download") || msg.includes("axios")) {
      res.status(502).json({ error: "Failed to download video." });
    } else if (msg.includes("ffmpeg")) {
      res.status(500).json({ error: "Video conversion failed." });
    } else {
      res.status(500).json({ error: "Server error." });
    }
  }
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
