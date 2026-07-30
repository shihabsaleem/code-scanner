"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { DecodeHintType, Result } from "@zxing/library";
import { Camera, RefreshCcw, Square, Play, AlertCircle, CheckCircle2 } from "lucide-react";

export default function BarcodeScanner() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [hasPermission, setHasPermission] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isScanning, setIsScanning] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [scannedResult, setScannedResult] = useState<string | null>(null);
  const [recentlyScanned, setRecentlyScanned] = useState<string | null>(null);
  
  const readerRef = useRef<BrowserMultiFormatReader | null>(null);
  const controlsRef = useRef<any>(null);
  const scanTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Initialize Audio Context for beep
  const playBeep = useCallback(() => {
    try {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(800, audioCtx.currentTime); // 800Hz beep
      
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.1);
    } catch (err) {
      console.warn("Audio API not supported or user hasn't interacted with document", err);
    }
  }, []);

  useEffect(() => {
    // Request permissions and list devices on mount
    const initCamera = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        setHasPermission(true);
        // Stop initial stream since we just needed it for permission
        stream.getTracks().forEach((track) => track.stop());

        const devicesList = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = devicesList.filter((device) => device.kind === "videoinput");
        setDevices(videoDevices);
        
        if (videoDevices.length > 0) {
          // Prefer back camera
          const backCamera = videoDevices.find((d) => d.label.toLowerCase().includes("back") || d.label.toLowerCase().includes("environment"));
          setSelectedDeviceId(backCamera ? backCamera.deviceId : videoDevices[0].deviceId);
        }
      } catch (err: any) {
        setHasPermission(false);
        setError("Camera access denied or unavailable.");
        console.error("Camera access error:", err);
      }
    };

    initCamera();

    return () => {
      stopScanning();
    };
  }, []);

  const handleResult = useCallback((result: Result) => {
    const text = result.getText();
    
    // Debounce duplicate scans
    if (recentlyScanned === text) return;
    
    setScannedResult(text);
    setRecentlyScanned(text);
    playBeep();
    
    if (scanTimeoutRef.current) {
      clearTimeout(scanTimeoutRef.current);
    }
    
    scanTimeoutRef.current = setTimeout(() => {
      setRecentlyScanned(null);
    }, 2000); // Wait 2s before accepting the same barcode again
  }, [recentlyScanned, playBeep]);

  const startScanning = async () => {
    if (!videoRef.current || !selectedDeviceId) return;
    
    setError(null);
    setIsScanning(true);
    setScannedResult(null);

    try {
      // Configure formats
      const hints = new Map<DecodeHintType, any>();
      // Using library defaults which include most 1D and 2D formats (QR, EAN, UPC, Code39, Code128, ITF, etc)
      
      readerRef.current = new BrowserMultiFormatReader(hints);
      
      controlsRef.current = await readerRef.current.decodeFromVideoDevice(
        selectedDeviceId,
        videoRef.current,
        (result: any, err: any) => {
          if (result) {
            handleResult(result);
          }
          if (err && err.name !== 'NotFoundException') {
            // Ignore NotFoundException as it just means no barcode is currently visible
            console.debug("Scan error:", err);
          }
        }
      );
    } catch (err: any) {
      setError("Failed to start scanner.");
      setIsScanning(false);
      console.error(err);
    }
  };

  const stopScanning = () => {
    setIsScanning(false);
    if (controlsRef.current) {
      controlsRef.current.stop();
      controlsRef.current = null;
    }
    if (readerRef.current) {
      readerRef.current = null;
    }
    
    if (videoRef.current && videoRef.current.srcObject) {
      const stream = videoRef.current.srcObject as MediaStream;
      stream.getTracks().forEach((track) => track.stop());
      videoRef.current.srcObject = null;
    }
  };

  const switchCamera = () => {
    if (devices.length < 2) return;
    
    const currentIndex = devices.findIndex((d) => d.deviceId === selectedDeviceId);
    const nextIndex = (currentIndex + 1) % devices.length;
    setSelectedDeviceId(devices[nextIndex].deviceId);
    
    if (isScanning) {
      stopScanning();
      setTimeout(startScanning, 300);
    }
  };

  if (hasPermission === false) {
    return (
      <div className="flex flex-col items-center justify-center p-8 bg-red-500/10 rounded-2xl border border-red-500/30 text-red-500">
        <AlertCircle className="w-12 h-12 mb-4" />
        <h3 className="text-xl font-bold mb-2">Camera Permission Denied</h3>
        <p className="text-center opacity-80">Please allow camera access in your browser settings to use the barcode scanner.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center w-full max-w-md mx-auto">
      {/* Scanner Container */}
      <div className="relative w-full aspect-4/3 bg-zinc-900 rounded-3xl overflow-hidden shadow-2xl border border-zinc-800 transition-all duration-300">
        
        {/* Video Element */}
        <video 
          ref={videoRef}
          playsInline
          muted
          autoPlay
          className={`w-full h-full object-cover ${!isScanning ? 'opacity-0' : 'opacity-100'} transition-opacity duration-500`}
        />

        {/* Placeholder / Off State */}
        {!isScanning && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500">
            <Camera className="w-16 h-16 mb-4 opacity-50" />
            <p className="font-medium">Camera is inactive</p>
          </div>
        )}

        {/* Scanning Overlay Grid/Frame */}
        {isScanning && (
          <div className="absolute inset-0 pointer-events-none">
            {/* Dark overlay with transparent center */}
            <div className="w-full h-full border-40 border-black/40 box-border"></div>
            
            {/* Animated Scanning Line */}
            <div className="absolute top-10 left-10 right-10 h-0.5 bg-red-500 animate-[scan_2s_ease-in-out_infinite] shadow-[0_0_10px_rgba(239,68,68,0.8)]"></div>
            
            {/* Corner Markers */}
            <div className="absolute top-8.75 left-8.75 w-8 h-8 border-t-4 border-l-4 border-white"></div>
            <div className="absolute top-8.75 right-8.75 w-8 h-8 border-t-4 border-r-4 border-white"></div>
            <div className="absolute bottom-8.75 left-8.75 w-8 h-8 border-b-4 border-l-4 border-white"></div>
            <div className="absolute bottom-8.75 right-8.75 w-8 h-8 border-b-4 border-r-4 border-white"></div>
            
            {/* Visual Feedback on scan */}
            {scannedResult && (
              <div className="absolute inset-0 border-4 border-green-500 shadow-[inset_0_0_20px_rgba(34,197,94,0.5)] transition-all duration-300 pointer-events-none"></div>
            )}
          </div>
        )}

        {/* Status Badge */}
        <div className="absolute top-4 left-4 right-4 flex justify-between items-center z-10 pointer-events-none">
          <div className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider backdrop-blur-md flex items-center gap-2
            ${isScanning ? (scannedResult ? 'bg-green-500/80 text-white' : 'bg-blue-500/80 text-white') : 'bg-zinc-800/80 text-zinc-400'}`}>
            {isScanning ? (
              <>
                <span className={`w-2 h-2 rounded-full ${scannedResult ? 'bg-white' : 'bg-white animate-pulse'}`}></span>
                {scannedResult ? 'Barcode Detected' : 'Scanning...'}
              </>
            ) : (
              <>
                <Square className="w-3 h-3 fill-current" />
                Stopped
              </>
            )}
          </div>
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
            onClick={startScanning}
            disabled={!hasPermission}
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
            Switch Camera
          </button>
        )}
      </div>

      {/* Result Display */}
      <div className={`mt-8 w-full transition-all duration-500 ${scannedResult ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-4 pointer-events-none'}`}>
        <div className="bg-white dark:bg-zinc-800 rounded-3xl p-6 shadow-xl border border-zinc-200 dark:border-zinc-700">
          <div className="flex items-center gap-3 mb-4 text-green-600 dark:text-green-400">
            <CheckCircle2 className="w-6 h-6" />
            <h3 className="text-lg font-bold">Successfully Scanned</h3>
          </div>
          <div className="bg-zinc-100 dark:bg-zinc-900 p-4 rounded-2xl font-mono text-xl text-center break-all text-zinc-800 dark:text-zinc-100">
            {scannedResult || "---"}
          </div>
        </div>
      </div>
    </div>
  );
}
