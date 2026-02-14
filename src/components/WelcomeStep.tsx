import Image from "next/image";

interface WelcomeStepProps {
  onNext: () => void;
}

export default function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <div className="flex flex-col items-center gap-3 mb-6">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={48}
            height={48}
            className="w-12 h-12 object-contain"
          />
          <h1 className="text-2xl font-bold font-display text-center">
            Welcome to{" "}
            <span className="bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">
              ClawBox
            </span>
          </h1>
        </div>
        <p className="text-gray-400 mb-6 leading-relaxed text-center">
          Your personal AI assistant is almost ready. This wizard will help you
          get set up in just a few minutes.
        </p>
        <div className="flex justify-center">
          <button
            type="button"
            onClick={onNext}
            className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
          >
            Get Started
          </button>
        </div>
      </div>
    </div>
  );
}
