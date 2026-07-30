"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  DecodeHintType,
  BarcodeFormat,
  RGBLuminanceSource,
  BinaryBitmap,
  HybridBinarizer,
  MultiFormatReader,
} from "@zxing/library";
import {
  Camera, RefreshCcw, Square, Play, AlertCircle, CheckCircle2, Zap, Cpu,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
declare global {
  interface Window { BarcodeDetector?: any; }
}

// ─── Constants ────────────────────────────────────────────────────────────────
const NATIVE_FORMATS = ["qr_code", "code_128", "code_39", "ean_13", "ean_8", "upc_a", "upc_e", "itf"];

const ZXING_FORMATS = [
  BarcodeFormat.QR_CODE, BarcodeFormat.CODE_128, BarcodeFormat.CODE_39,
  BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E, BarcodeFormat.ITF,
];

// Max dimensions fed into ZXing — smaller = faster, still accurate enough
const ZXING_MAX_W = 640;
const ZXING_MAX_H = 360;

// ─── ZXing reader (singleton) ─────────────────────────────────────────────────
function buildZxingReader(): MultiFormatReader {
  const hints = new Map<DecodeHintType, any>();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
  hints.set(DecodeHintType.TRY_HARDER, false); // TRY_HARDER is slow on mobile; disable for speed
  const r = new MultiFormatReader();
  r.setHints(hints);
  return r;
}

// ─── Decode helpers ───────────────────────────────────────────────────────────

/**
 * Native path: passes the <video> element directly — no canvas copy needed.
 * Returns the detected value, or null.
 */
async function decodeNative(detector: any, video: HTMLVideoElement): Promise<string | null> {
  try {
    const results: any[] = await detector.detect(video);
    return results.length > 0 ? (results[0].rawValue as string) : null;
  } catch {
    return null;
  }
}

/**
 * ZXing fallback: downscales the video to ZXING_MAX_W × ZXING_MAX_H
 * before converting to greyscale, significantly reducing pixel work.
 */
function decodeZxing(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  reader: MultiFormatReader
): string | null {
  const { videoWidth: vw, videoHeight: vh } = video;
  if (!vw || !vh) return null;

  // Scale down proportionally so the largest side is at most the max dimension
  const scale = Math.min(ZXING_MAX_W / vw, ZXING_MAX_H / vh, 1);
  const w = Math.round(vw * scale);
  const h = Math.round(vh * scale);

  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;

  const ctx = canvas.getContext("2d", { willReadFrequently: true, alpha: false });
  if (!ctx) return null;

  ctx.drawImage(video, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  // Fast perceived-luminance conversion (avoids floating point)
  const luminance = new Uint8ClampedArray(w * h);
  for (let i = 0; i < luminance.length; i++) {
    const p = i * 4;
    luminance[i] = (data[p] * 77 + data[p + 1] * 151 + data[p + 2] * 28) >> 8;
  }

  try {
    const src = new RGBLuminanceSource(luminance, w, h);
    const bmp = new BinaryBitmap(new HybridBinarizer(src));
    return reader.decode(bmp).getText();
  } catch {
    return null;
  }
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function BarcodeScanner() {
  const videoRef    = useRef<HTMLVideoElement>(null);
  const canvasRef   = useRef<HTMLCanvasElement>(null);
  const streamRef   = useRef<MediaStream | null>(null);
  const rafRef      = useRef<number | null>(null);

  // Prevents stacking async native detect() calls
  const detectingRef    = useRef(false);
  const nativeRef       = useRef<any>(null);
  const zxingRef        = useRef<MultiFormatReader | null>(null);
  const isNativeRef     = useRef(false);

  const lastScannedRef  = useRef<string | null>(null);
  const debounceRef     = useRef<NodeJS.Timeout | null>(null);

  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error,         setError]         = useState<string | null>(null);
  const [isScanning,    setIsScanning]    = useState(false);
  const [devices,       setDevices]       = useState<MediaDeviceInfo[]>([]);
  const [facingMode,    setFacingMode]    = useState<"environment" | "user">("environment");
  const [scannedResult, setScannedResult] = useState<string | null>(null);
  const [fps,           setFps]           = useState(0);
  const [engineLabel,   setEngineLabel]   = useState<"Native" | "ZXing JS">("ZXing JS");

  const fpsRef = useRef({ count: 0, last: Date.now() });

  // ── Init engine ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const initEngine = async () => {
      if (typeof window !== "undefined" && window.BarcodeDetector) {
        try {
          const supported: string[] = await window.BarcodeDetector.getSupportedFormats();
          const available = NATIVE_FORMATS.filter((f) => supported.includes(f));
          nativeRef.current = new window.BarcodeDetector({ formats: available.length ? available : NATIVE_FORMATS });
          isNativeRef.current = true;
          setEngineLabel("Native");
          return;
        } catch {
          try {
            nativeRef.current = new window.BarcodeDetector({ formats: NATIVE_FORMATS });
            isNativeRef.current = true;
            setEngineLabel("Native");
            return;
          } catch {}
        }
      }
      // Fallback
      zxingRef.current = buildZxingReader();
      setEngineLabel("ZXing JS");
    };
    initEngine();
  }, []);

  // ── Beep ──────────────────────────────────────────────────────────────────────
  const playBeep = useCallback(() => {
    try {
      const ctx  = new (window.AudioContext || (window as any).webkitAudioContext)();
      const osc  = ctx.createOscillator();
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

  // ── Handle a successful decode ────────────────────────────────────────────────
  const handleDetected = useCallback((text: string) => {
    if (text === lastScannedRef.current) return;
    lastScannedRef.current = text;
    setScannedResult(text);
    playBeep();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => { lastScannedRef.current = null; }, 2500);
  }, [playBeep]);

  // ── RAF scan loop ─────────────────────────────────────────────────────────────
  const scanLoop = useCallback(() => {
    const video  = videoRef.current;
    const canvas = canvasRef.current;

    if (!video || video.readyState < 2) {
      rafRef.current = requestAnimationFrame(scanLoop);
      return;
    }

    // FPS counter
    const now = Date.now();
    fpsRef.current.count++;
    if (now - fpsRef.current.last >= 1000) {
      setFps(fpsRef.current.count);
      fpsRef.current = { count: 0, last: now };
    }

    if (isNativeRef.current && nativeRef.current) {
      // ── Native path ────────────────────────────────────────────────────────
      // Gate: only issue a new detect() when the previous one has resolved.
      if (!detectingRef.current) {
        detectingRef.current = true;
        decodeNative(nativeRef.current, video).then((text) => {
          detectingRef.current = false;
          if (text) handleDetected(text);
        });
      }
    } else if (zxingRef.current && canvas) {
      // ── ZXing path (synchronous, always keep up) ──────────────────────────
      const text = decodeZxing(video, canvas, zxingRef.current);
      if (text) handleDetected(text);
    }

    rafRef.current = requestAnimationFrame(scanLoop);
  }, [handleDetected]);

  // ── Start ─────────────────────────────────────────────────────────────────────
  const startScanning = useCallback(async (facing: "environment" | "user" = facingMode) => {
    setError(null);
    setIsScanning(true);
    setScannedResult(null);
    lastScannedRef.current  = null;
    detectingRef.current    = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: facing },
          width:     { ideal: 1280, max: 1280 },
          height:    { ideal: 720,  max: 720  },
          frameRate: { ideal: 30 },
        },
      });

      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }

      fpsRef.current = { count: 0, last: Date.now() };
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

  // ── Stop ──────────────────────────────────────────────────────────────────────
  const stopScanning = useCallback(() => {
    if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current)  { videoRef.current.srcObject = null; }
    detectingRef.current = false;
    setIsScanning(false);
    setFps(0);
  }, []);

  // ── Switch camera ─────────────────────────────────────────────────────────────
  const switchCamera = useCallback(() => {
    const next = facingMode === "environment" ? "user" : "environment";
    setFacingMode(next);
    stopScanning();
    setTimeout(() => startScanning(next), 200);
  }, [facingMode, stopScanning, startScanning]);

  // ── Permission init ───────────────────────────────────────────────────────────
  useEffect(() => {
    const init = async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({ video: true });
        s.getTracks().forEach((t) => t.stop());
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

  // ─── UI ───────────────────────────────────────────────────────────────────────
  if (hasPermission === false) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-red-500/10 rounded-2xl border border-red-500/30 text-red-500">
        <AlertCircle className="w-12 h-12 mb-4" />
        <h3 className="text-xl font-bold mb-2">Camera Permission Denied</h3>
        <p className="text-center opacity-80">Please allow camera access in your browser settings and refresh.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center w-full max-w-md mx-auto">

      {/* Engine label */}
      <div className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-zinc-500 dark:text-zinc-400">
        <Cpu className="w-4 h-4" />
        Engine:&nbsp;
        <span className={engineLabel === "Native" ? "text-emerald-500" : "text-amber-500"}>
          {engineLabel}
        </span>
        {engineLabel === "Native" && <span className="text-emerald-400 normal-case tracking-normal">(hardware-accelerated ⚡)</span>}
      </div>

      {/* Viewport */}
      <div className="relative w-full aspect-4/3 bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-800">

        <video
          ref={videoRef}
          playsInline
          muted
          className={`w-full h-full object-cover transition-opacity duration-500 ${isScanning ? "opacity-100" : "opacity-0"}`}
        />

        {/* Hidden canvas — only used by ZXing fallback */}
        <canvas ref={canvasRef} className="hidden" />

        {/* Idle */}
        {!isScanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
            <Camera className="w-16 h-16 mb-4 opacity-40" />
            <p className="font-medium">Camera is inactive</p>
          </div>
        )}

        {/* Scan overlay */}
        {isScanning && (
          <div className="absolute inset-0 pointer-events-none">
            <div className="w-full h-full border-40 border-black/40 box-border" />
            <div className="absolute top-10 left-10 right-10 h-0.5 bg-red-500 animate-[scan_1.2s_ease-in-out_infinite] shadow-[0_0_8px_rgba(239,68,68,0.9)]" />
            <div className="absolute top-8.75 left-8.75 w-8 h-8 border-t-4 border-l-4 border-white" />
            <div className="absolute top-8.75 right-8.75 w-8 h-8 border-t-4 border-r-4 border-white" />
            <div className="absolute bottom-8.75 left-8.75 w-8 h-8 border-b-4 border-l-4 border-white" />
            <div className="absolute bottom-8.75 right-8.75 w-8 h-8 border-b-4 border-r-4 border-white" />
            {scannedResult && (
              <div className="absolute inset-0 border-4 border-green-500 shadow-[inset_0_0_24px_rgba(34,197,94,0.6)] transition-all duration-150 pointer-events-none" />
            )}
          </div>
        )}

        {/* Status + FPS */}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-center z-10 pointer-events-none">
          <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider backdrop-blur-md flex items-center gap-2
            ${isScanning ? (scannedResult ? "bg-green-500/80 text-white" : "bg-blue-500/80 text-white") : "bg-zinc-800/80 text-zinc-400"}`}>
            {isScanning ? (
              <>
                <span className={`w-2 h-2 rounded-full bg-white ${!scannedResult && "animate-pulse"}`} />
                {scannedResult ? "Detected!" : "Scanning…"}
              </>
            ) : (
              <><Square className="w-3 h-3 fill-current" /> Stopped</>
            )}
          </div>

          {isScanning && fps > 0 && (
            <div className="px-2 py-1 rounded-full text-xs font-mono font-bold backdrop-blur-md bg-black/50 text-emerald-400 flex items-center gap-1">
              <Zap className="w-3 h-3" />{fps} fps
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
          <button onClick={() => startScanning()} disabled={hasPermission === null}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-blue-500/30 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed">
            <Play className="w-5 h-5 fill-current" /> Start Scanner
          </button>
        ) : (
          <button onClick={stopScanning}
            className="flex items-center gap-2 bg-zinc-800 hover:bg-zinc-700 text-white px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-black/20 transition-all active:scale-95">
            <Square className="w-5 h-5 fill-current" /> Stop Camera
          </button>
        )}

        {devices.length > 1 && (
          <button onClick={switchCamera}
            className="flex items-center gap-2 bg-zinc-100 hover:bg-white text-zinc-900 px-6 py-3 rounded-2xl font-semibold shadow-lg shadow-black/5 transition-all active:scale-95">
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
