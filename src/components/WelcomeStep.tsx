import Image from "next/image";

interface WelcomeStepProps {
  onNext: () => void;
}

const items = [
  {
    title: "Connect to WiFi",
    desc: "Link your ClawBox to your home network",
  },
  {
    title: "Connect Telegram",
    desc: "Set up your chat bot for messaging",
  },
  {
    title: "Start chatting",
    desc: "Talk to your AI from anywhere",
  },
];

export default function WelcomeStep({ onNext }: WelcomeStepProps) {
  return (
    <div className="w-full max-w-[520px]">
      <div className="bg-gray-800/50 border border-gray-700/50 rounded-2xl p-8">
        <div className="flex items-center gap-3 mb-6">
          <Image
            src="/clawbox-icon.png"
            alt="ClawBox"
            width={48}
            height={48}
            className="w-12 h-12 object-contain"
          />
          <h1 className="text-2xl font-bold font-display">
            Welcome to{" "}
            <span className="bg-gradient-to-r from-orange-400 to-orange-600 bg-clip-text text-transparent">
              ClawBox
            </span>
          </h1>
        </div>
        <p className="text-gray-400 mb-6 leading-relaxed">
          Your personal AI assistant is almost ready. This wizard will help you
          get set up in just a few minutes.
        </p>
        <div className="flex flex-col gap-4 mb-7">
          {items.map(({ title, desc }) => (
            <div key={title} className="flex gap-3.5 items-start">
              <span className="flex items-center justify-center w-7 h-7 rounded-full bg-orange-500/10 text-orange-400 text-sm font-bold shrink-0">
                &#10003;
              </span>
              <div>
                <strong className="block text-sm mb-0.5 text-gray-200">
                  {title}
                </strong>
                <p className="text-xs text-gray-500">{desc}</p>
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={onNext}
          className="px-8 py-3 btn-gradient text-white rounded-lg font-semibold text-sm transition transform hover:scale-105 shadow-lg shadow-orange-500/25 cursor-pointer"
        >
          Get Started
        </button>
      </div>
    </div>
  );
}
