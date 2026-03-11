"use client";

interface AndroidNavBarProps {
  onHome?: () => void;
}

export function AndroidNavBar({ onHome }: AndroidNavBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 h-8 flex items-end justify-center pb-2">
      <button
        onClick={onHome}
        className="bg-white rounded-full hover:bg-white/80 transition-all active:scale-95 cursor-pointer"
        style={{ width: "134px", height: "5px" }}
        aria-label="Home"
      />
    </div>
  );
}
