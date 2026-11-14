// The confirmation window of an agent card fill: shows the site, the card's
// label, brand and last 4, and waits for the human. Only a real click on
// Confirm lets the fill run; Decline or closing the window refuses it.
import type { ConfirmDetails, ConfirmMessage } from "./messages";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const id = decodeURIComponent(location.hash.slice(1));

const BRAND: Record<string, string> = { visa: "Visa", mastercard: "Mastercard", amex: "American Express", discover: "Discover", diners: "Diners Club", jcb: "JCB", unionpay: "UnionPay", maestro: "Maestro", mir: "Mir" };

async function ask<T>(msg: ConfirmMessage): Promise<T & { error?: string }> {
  try {
    return ((await chrome.runtime.sendMessage(msg)) ?? {}) as T & { error?: string };
  } catch {
    return { error: "The extension background is not running." } as T & { error?: string };
  }
}

function gone(text: string): void {
  $("ask").hidden = true;
  $("gone").hidden = false;
  $("gone-text").textContent = text;
}

async function decide(decision: "confirm" | "decline"): Promise<void> {
  $<HTMLButtonElement>("btn-confirm").disabled = true;
  $<HTMLButtonElement>("btn-decline").disabled = true;
  gone(decision === "confirm" ? "Confirmed. Filling the card…" : "Declined. Nothing was filled.");
  // The background closes this window once it has the answer.
  await ask({ type: "confirm:decision", id, decision });
}

async function main(): Promise<void> {
  const d = await ask<ConfirmDetails>({ type: "confirm:details", id });
  if (d.error) return gone(d.error);
  $("c-host").textContent = d.host;
  $("c-card").textContent = `${d.label} — ${BRAND[d.brand] ?? "Card"} •••• ${d.last4}`;
  $("c-exp").textContent = d.exp;
  if (d.paymentHosts?.length) {
    $("c-frames").textContent = `The card fields are in the payment provider's frame (${d.paymentHosts.join(", ")}); Confirm fills them there too.`;
    $("c-frames").hidden = false;
  }
  $("ask").hidden = false;
  document.title = `Confirm card fill on ${d.host}`;
  const end = Date.now() + d.remainingMs;
  const tick = () => {
    const left = Math.max(0, Math.round((end - Date.now()) / 1000));
    $("c-timer").textContent = left ? `This request lapses in ${left} s.` : "This request has lapsed.";
    if (!left) {
      clearInterval(timer);
      gone("The request lapsed. Nothing was filled.");
    }
  };
  const timer = setInterval(tick, 1000);
  tick();
  // A short delay so a click aimed at something else cannot land on Confirm.
  setTimeout(() => ($<HTMLButtonElement>("btn-confirm").disabled = false), 700);
  $("btn-confirm").addEventListener("click", (e) => {
    if (e.isTrusted) void decide("confirm");
  });
  $("btn-decline").addEventListener("click", (e) => {
    if (e.isTrusted) void decide("decline");
  });
}

void main();
