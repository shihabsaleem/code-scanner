"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { BrowserMultiFormatReader, NotFoundException } from "@zxing/browser";
import { DecodeHintType, BarcodeFormat, RGBLuminanceSource, BinaryBitmap, HybridBinarizer, MultiFormatReader } from "@zxing/library";
import { Camera, RefreshCcw, Square, Play, AlertCircle, CheckCircle2, Zap } from "lucide-react";

// ─── Reusable ZXing multi-format reader (created once, kept alive) ──────────
const FORMATS = [
  BarcodeFormat.QR_CODE,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.ITF,
];

function buildReader(): MultiFormatReader {
  const hints = new Map<DecodeHintType, any>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, true);
  const reader = new MultiFormatReader();
  reader.setHints(hints);
  return reader;
}

// ─── Decode one video frame using ZXing low-level API ───────────────────────
function decodeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  reader: MultiFormatReader
): string | null {
  const { videoWidth: w, videoHeight: h } = video;
  if (!w || !h) return null;

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Convert RGBA to luminance (greyscale) — ZXing needs Uint8ClampedArray
  const luminance = new Uint8ClampedArray(w * h);
  for (let i = 0; i < luminance.length; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // Perceived luminance weights
    luminance[i] = (r * 77 + g * 151 + b * 28) >> 8;
  }

  try {
    const source = new RGBLuminanceSource(luminance, w, h);
    const bitmap = new BinaryBitmap(new HybridBinarizer(source));
    const result = reader.decode(bitmap);
    return result.getText();
  } catch {
    return null;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef<number | null>(null);
  const readerRef = useRef<MultiFormatReader>(buildReader());
  const lastScannedRef = useRef<string | null>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [facingMode, setFacingMode] = useState<"environment" | "user">("environment");
  const [scannedResult, setScannedResult] = useState<string | null>(null);
  const [fps, setFps] = useState(0);

  // FPS tracking
  const fpsCounterRef = useRef({ count: 0, last: Date.now() });

  // ── Beep ────────────────────────────────────────────────────────────────────
  const playBeep = useCallback(() => {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(900, ctx.currentTime);
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch {}
  }, []);

  // ── Scan loop using requestAnimationFrame ───────────────────────────────────
  const scanLoop = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    // FPS counter
    const now = Date.now();
    fpsCounterRef.current.count++;
    if (now - fpsCounterRef.current.last >= 1000) {
      setFps(fpsCounterRef.current.count);
      fpsCounterRef.current = { count: 0, last: now };
    }

    const text = decodeFrame(video, canvas, readerRef.current);

    if (text && text !== lastScannedRef.current) {
      lastScannedRef.current = text;
      setScannedResult(text);
      playBeep();

      // Clear debounce so same code can scan again after 2.5s
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        lastScannedRef.current = null;
      }, 2500);
    }

    rafRef.current = requestAnimationFrame(scanLoop);
  }, [playBeep]);

  // ── Start camera + scan loop ────────────────────────────────────────────────
  const startScanning = useCallback(async (facing: "environment" | "user" = facingMode) => {
    setError(null);
    setIsScanning(true);
    setScannedResult(null);
    lastScannedRef.current = null;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280, max: 1280 },
          height: { ideal: 720, max: 720 },
          frameRate: { ideal: 30 },
        },
      });

      streamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      fpsCounterRef.current = { count: 0, last: Date.now() };
      rafRef.current = requestAnimationFrame(scanLoop);
    } catch (err: any) {
      setIsScanning(false);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
        setHasPermission(false);
      } else {
        setError("Failed to start camera: " + (err.message ?? err.name));
      }
    }
  }, [facingMode, scanLoop]);

  // ── Stop scanning ───────────────────────────────────────────────────────────
  const stopScanning = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsScanning(false);
    setFps(0);
  }, []);

  // ── Switch front/back camera ────────────────────────────────────────────────
  const switchCamera = useCallback(() => {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    stopScanning();
    setTimeout(() => startScanning(next), 200);
  }, [facingMode, stopScanning, startScanning]);

  // ── Init: check permission + enumerate devices ──────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        stream.getTracks().forEach((t) => t.stop());
        setHasPermission(true);

        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(all.filter((d) => d.kind === "videoinput"));
      } catch {
        setHasPermission(false);
      }
    };
    init();
    return () => stopScanning();
  }, [stopScanning]);

  // ─── UI ───────────────────────────────────────────────────────────────────
  if (hasPermission === false) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-red-500/10 rounded-2xl border border-red-500/30 text-red-500">
        <AlertCircle className="w-12 h-12 mb-4" />
        <h3 className="text-xl font-bold mb-2">Camera Permission Denied</h3>
        <p className="text-center opacity-80">
          Please allow camera access in your browser settings and refresh the page.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center w-full max-w-md mx-auto">
      {/* Scanner Container */}
      <div className="relative w-full aspect-4/3 bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-800">

        {/* Video */}
        <video
          ref={videoRef}
          playsInline
          muted
          className={`w-full h-full object-cover transition-opacity duration-500 ${isScanning ? "opacity-100" : "opacity-0"}`}
        />

        {/* Hidden canvas for frame capture */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Idle overlay */}
        {!isScanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
            <Camera className="w-16 h-16 mb-4 opacity-40" />
            <p className="font-medium">Camera is inactive</p>
          </div>
        )}

        {/* Scan frame overlay */}
        {isScanning && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="w-full h-full border-40 border-black/40 box-border" />
            {/* Sweep line */}
            <div className="absolute top-10 left-10 right-10 h-0.5 bg-red-500 animate-[scan_1.5s_ease-in-out_infinite] shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
            {/* Corners */}
            <div className="absolute top-8.75 left-8.75 w-8 h-8 border-t-4 border-l-4 border-white" />
            <div className="absolute top-8.75 right-8.75 w-8 h-8 border-t-4 border-r-4 border-white" />
            <div className="absolute bottom-8.75 left-8.75 w-8 h-8 border-b-4 border-l-4 border-white" />
            <div className="absolute bottom-8.75 right-8.75 w-8 h-8 border-b-4 border-r-4 border-white" />
            {/* Green flash on detect */}
            {scannedResult && (
              <div className="absolute inset-0 border-4 border-green-500 shadow-[inset_0_0_24px_rgba(34,197,94,0.6)] transition-all duration-200 pointer-events-none" />
            )}
          </div>
        )}

        {/* Top status bar */}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-center z-10 pointer-events-none">
          <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider backdrop-blur-md flex items-center gap-2
            ${isScanning
              ? scannedResult
                ? "bg-green-500/80 text-white"
                : "bg-blue-500/80 text-white"
              : "bg-zinc-800/80 text-zinc-400"
            }`}>
            {isScanning ? (
              <>
                <span className={`w-2 h-2 rounded-full bg-white ${!scannedResult && "animate-pulse"}`} />
                {scannedResult ? "Detected!" : "Scanning…"}
              </>
            ) : (
              <>
                <Square className="w-3 h-3 fill-current" />
                Stopped
              </>
            )}
          </div>

          {/* FPS badge */}
          {isScanning && fps > 0 && (
            <div className="px-2 py-1 rounded-full text-xs font-mono font-bold backdrop-blur-md bg-black/50 text-emerald-400 flex items-center gap-1">
              <Zap className="w-3 h-3" />
              {fps} fps
            </div>
          )}
        </div>

        {error && (
          <div className="absolute bottom-4 left-4 right-4 bg-red-500/90 text-white p-3 rounded-xl text-sm font-medium backdrop-blur-md">
            {error}
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="mt-6 flex flex-wrap gap-4 justify-center">
        {!isScanning ? (
          <button
            onClick={() => startScanning()}
            disabled={hasPermission === null}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Play className="w-5 h-5 fill-current" />
            Start Scanner
          </button>
        ) : (
          <button
            onClick={stopScanning}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-black/20 transition-all active:scale-95"
          >
            <Square className="w-5 h-5 fill-current" />
            Stop Camera
          </button>
        )}

        {devices.length > 1 && (
          <button
            onClick={switchCamera}
            className="flex items-center gap-2 bg-zinc-100 hover:bg-white text-zinc-900 px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-black/5 transition-all active:scale-95"
          >
            <RefreshCcw className="w-5 h-5" />
            {facingMode === "environment" ? "Front Cam" : "Back Cam"}
          </button>
        )}
      </div>

      {/* Result */}
      <div className={`mt-8 w-full transition-all duration-300 ${scannedResult ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        <div className="bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-xl border border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-3 mb-4 text-green-600 dark:text-green-400">
            <CheckCircle2 className="w-6 h-6" />
            <h3 className="text-lg font-bold">Successfully Scanned</h3>
          </div>
          <div className="bg-zinc-100 dark:bg-zinc-900 p-4 rounded-2xl font-mono text-xl text-center break-all text-zinc-800 dark:text-zinc-100 select-all">
            {scannedResult ?? "---"}
          </div>
        </div>
      </div>
    </div>
  );
}
