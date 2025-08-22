import express from "express";
import multer from "multer";
import sharp from "sharp";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";

// ---------------- Setup ----------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

// ---------------- CORS ----------------
const allowedOrigins = [
  "https://filesizecompressor.vercel.app",
  "http://localhost:3000", // dev
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("CORS origin not allowed"), false);
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.options("*", cors());

// ---------------- Request Logger ----------------
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// ---------------- FFmpeg codec detection & fallbacks ----------------
const CODEC_SUPPORT = {
  x264: false,
  mpeg4: false,
  mp3: false,
  aac: false,
  opus: false,
};

let VIDEO_CONFIG = { vCodec: "libx264", aCodec: "aac", container: "mp4" };
let AUDIO_CONFIG = { codec: "libmp3lame", container: "mp3", mime: "audio/mpeg" };

function logCodecPlan() {
  console.log("🎬 Video plan:", VIDEO_CONFIG);
  console.log("🎵 Audio plan:", AUDIO_CONFIG);
}

ffmpeg.getAvailableCodecs((err, codecs) => {
  if (err) {
    console.error("❌ Failed to query ffmpeg codecs:", err);
  } else {
    CODEC_SUPPORT.x264 = !!(codecs.libx264 && codecs.libx264.canEncode);
    CODEC_SUPPORT.mpeg4 = !!(codecs.mpeg4 && codecs.mpeg4.canEncode);
    CODEC_SUPPORT.mp3 = !!(codecs.libmp3lame && codecs.libmp3lame.canEncode);
    CODEC_SUPPORT.aac = !!(codecs.aac && codecs.aac.canEncode);
    CODEC_SUPPORT.opus = !!(codecs.libopus && codecs.libopus.canEncode);

    // Decide video codec/container
    if (CODEC_SUPPORT.x264) {
      VIDEO_CONFIG.vCodec = "libx264";
      VIDEO_CONFIG.container = "mp4";
    } else if (CODEC_SUPPORT.mpeg4) {
      // Widely available fallback (older MPEG-4 Part 2), larger files but works
      VIDEO_CONFIG.vCodec = "mpeg4";
      VIDEO_CONFIG.container = "mp4";
      console.warn("⚠️ Falling back to mpeg4 for video (libx264 not available).");
    } else {
      console.warn("⚠️ No preferred video encoder found; attempting libx264 anyway.");
    }

    // Decide video audio codec
    if (CODEC_SUPPORT.aac) {
      VIDEO_CONFIG.aCodec = "aac";
    } else if (CODEC_SUPPORT.mp3) {
      // mp3 in mp4 is not ideal, but many players accept it; prefer AAC when possible.
      VIDEO_CONFIG.aCodec = "libmp3lame";
      console.warn("⚠️ Using MP3 audio inside MP4 (AAC not available).");
    } else {
      VIDEO_CONFIG.aCodec = "copy";
      console.warn("⚠️ Copying source audio (no AAC/MP3 encoders available).");
    }

    // Decide audio endpoint defaults & MIME
    if (CODEC_SUPPORT.mp3) {
      AUDIO_CONFIG = { codec: "libmp3lame", container: "mp3", mime: "audio/mpeg" };
    } else if (CODEC_SUPPORT.aac) {
      AUDIO_CONFIG = { codec: "aac", container: "m4a", mime: "audio/mp4" };
      console.warn("⚠️ Falling back to AAC (.m4a) for audio endpoint (MP3 not available).");
    } else if (CODEC_SUPPORT.opus) {
      AUDIO_CONFIG = { codec: "libopus", container: "ogg", mime: "audio/ogg" };
      console.warn("⚠️ Falling back to Opus (.ogg) for audio endpoint (MP3/AAC not available).");
    } else {
      console.warn("❌ No suitable audio encoder found for audio endpoint.");
    }
  }

  logCodecPlan();
});

// ---------------- Helpers ----------------
const tmpFile = (ext = "") => path.join(os.tmpdir(), `${uuidv4()}${ext ? "." + ext : ""}`);
const cleanup = (files = []) =>
  files.forEach((f) => {
    try {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {}
  });

// ---------------- IMAGE COMPRESSION ----------------
app.post("/compress/image", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("No file uploaded");

    // Tweak sizes/quality as you like or make it dynamic
    const buffer = await sharp(req.file.buffer)
      .resize({ width: 800 })
      .jpeg({ quality: 70 })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.send(buffer);
  } catch (err) {
    console.error("Image compression error:", err);
    res.status(500).send("Image compression failed");
  }
});

// ---------------- VIDEO COMPRESSION ----------------
app.post("/compress/video", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const inExt = path.extname(req.file.originalname).replace(/^\./, "") || "tmp";
  const tmpInput = tmpFile(inExt);
  const tmpOutput = tmpFile(VIDEO_CONFIG.container); // mp4 by default
  fs.writeFileSync(tmpInput, req.file.buffer);

  const outName = `compressed_${path.parse(req.file.originalname).name}.${VIDEO_CONFIG.container}`;
  res.setHeader("Content-Type", "video/mp4"); // container is mp4 in both x264/mpeg4 paths
  res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);

  const cmd = ffmpeg(tmpInput)
    .outputOptions([
      `-vcodec ${VIDEO_CONFIG.vCodec}`,
      "-crf 28",
      "-preset superfast",
      `-c:a ${VIDEO_CONFIG.aCodec}`,
      "-b:a 128k",
      "-movflags +faststart", // better streaming
    ])
    .on("error", (err) => {
      console.error("FFmpeg video error:", err.message);
      if (!res.headersSent) res.status(500).send("Video compression failed");
      cleanup([tmpInput, tmpOutput]);
    })
    .on("end", () => {
      const readStream = fs.createReadStream(tmpOutput);
      readStream.pipe(res);
      readStream.on("close", () => cleanup([tmpInput, tmpOutput]));
    })
    .save(tmpOutput);

  // If no audio encoder available and copy also fails for some inputs, you can
  // conditionally drop audio instead by replacing aCodec with "none" and adding "-an".
});

// ---------------- AUDIO COMPRESSION ----------------
app.post("/compress/audio", upload.single("file"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  if (!CODEC_SUPPORT.mp3 && !CODEC_SUPPORT.aac && !CODEC_SUPPORT.opus) {
    return res
      .status(501)
      .send("No suitable audio encoders available on this server (MP3/AAC/Opus).");
  }

  const inExt = path.extname(req.file.originalname).replace(/^\./, "") || "tmp";
  const tmpInput = tmpFile(inExt);
  const tmpOutput = tmpFile(AUDIO_CONFIG.container);
  fs.writeFileSync(tmpInput, req.file.buffer);

  const base = path.parse(req.file.originalname).name;
  const outName = `compressed_${base}.${AUDIO_CONFIG.container}`;

  res.setHeader("Content-Type", AUDIO_CONFIG.mime);
  res.setHeader("Content-Disposition", `attachment; filename="${outName}"`);

  const chain = ffmpeg(tmpInput)
    .audioCodec(AUDIO_CONFIG.codec)
    .on("error", (err) => {
      console.error("FFmpeg audio error:", err.message);
      if (!res.headersSent) res.status(500).send("Audio compression failed");
      cleanup([tmpInput, tmpOutput]);
    })
    .on("end", () => {
      const readStream = fs.createReadStream(tmpOutput);
      readStream.pipe(res);
      readStream.on("close", () => cleanup([tmpInput, tmpOutput]));
    });

  // Bitrate / sample rate per codec
  if (AUDIO_CONFIG.codec === "libmp3lame") {
    chain.audioBitrate("96k").format("mp3");
  } else if (AUDIO_CONFIG.codec === "aac") {
    chain.audioBitrate("96k").format("ipod"); // m4a/aac in mp4 container
  } else if (AUDIO_CONFIG.codec === "libopus") {
    chain.audioBitrate("64k").format("ogg");
  }

  chain.save(tmpOutput);
});

// ---------------- Serve static frontend ----------------
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// ---------------- SPA fallback & catch-all ----------------
app.get("*", (req, res) => {
  if (req.path.startsWith("/compress/")) {
    return res.status(404).send("Route not found");
  }
  const indexHtml = path.join(publicDir, "index.html");
  if (fs.existsSync(indexHtml)) {
    res.sendFile(indexHtml);
  } else {
    res.status(404).send("Frontend not found");
  }
});

// ---------------- Log routes (debug) ----------------
app._router?.stack?.forEach((middleware) => {
  if (middleware.route) {
    const methods = Object.keys(middleware.route.methods)
      .map((m) => m.toUpperCase())
      .join(", ");
    console.log(`${methods} ${middleware.route.path}`);
  }
});

// ---------------- Start server ----------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
