import BarcodeScanner from "@/components/BarcodeScanner";

export default function Home() {
  return (
    <main className="min-h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-900 dark:text-zinc-50 py-12 px-4 flex flex-col items-center">
      <div className="max-w-3xl w-full text-center mb-12">
        <h1 className="text-4xl md:text-5xl font-extrabold tracking-tight mb-4 bg-linear-to-r from-blue-600 to-indigo-600 dark:from-blue-400 dark:to-indigo-400 text-transparent bg-clip-text">
          Next.js Barcode Scanner
        </h1>
        <p className="text-lg text-zinc-600 dark:text-zinc-400 max-w-xl mx-auto">
          A production-ready scanner supporting QR Code, EAN, UPC, Code 128, and more. 
          Point your camera at a barcode to get started.
        </p>
      </div>

      <BarcodeScanner />
      
    </main>
  );
}
