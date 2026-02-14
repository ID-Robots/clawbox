interface StatusMessageProps {
  type: "success" | "error";
  message: string;
}

export default function StatusMessage({ type, message }: StatusMessageProps) {
  return (
    <div
      role="status"
      aria-live={type === "error" ? "assertive" : "polite"}
      aria-atomic="true"
      className={`mt-3 px-3.5 py-2.5 rounded-lg text-xs leading-relaxed ${
        type === "success"
          ? "bg-green-500/10 text-green-400 border border-green-500/20"
          : "bg-red-500/10 text-red-400 border border-red-500/20"
      }`}
    >
      {message}
    </div>
  );
}
