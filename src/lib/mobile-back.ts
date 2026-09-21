"use client";

/**
 * In-app Back: a stack of "go up one level" handlers that the desktop's Back
 * handling (page.tsx) consults BEFORE it closes a window.
 *
 * On a phone every app is full-screen, so the Android back gesture used to
 * close the whole app from anywhere inside it: a Settings section, an open
 * Coding Agent project or a sub-folder in Files all went straight back to the
 * desktop, and the only way up one level was a small control somewhere on the
 * page. A screen that has a level above it registers here while it is showing
 * (`useMobileBack(active, goUp)`); Back and the phone window's own back chevron
 * call the most recently registered handler first.
 *
 * The stack's size is also part of the history depth page.tsx keeps: every
 * level gets its own history entry, pushed while the tap that opened it still
 * counts as a user activation. Chrome on Android skips entries pushed WITHOUT
 * one when the back gesture walks history, which is how a second Back used to
 * leave the app instead of closing the next thing.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

type Entry = { id: number; run: () => void };

let nextId = 1;
let stack: Entry[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function registerMobileBack(run: () => void): () => void {
  const entry: Entry = { id: nextId++, run };
  stack = [...stack, entry];
  emit();
  return () => {
    const before = stack.length;
    stack = stack.filter((e) => e.id !== entry.id);
    if (stack.length !== before) emit();
  };
}

/** Runs the deepest in-app Back. Returns false when no screen claimed it. */
export function runMobileBack(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.run();
  return true;
}

export function mobileBackDepth(): number {
  return stack.length;
}

export function subscribeMobileBack(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useMobileBackDepth(): number {
  return useSyncExternalStore(subscribeMobileBack, mobileBackDepth, () => 0);
}

/**
 * While `active`, Back runs `onBack` instead of closing the app. `levels` is
 * how many presses that takes to exhaust (a folder three deep is three), so the
 * history depth matches and every press has an entry of its own.
 */
export function useMobileBack(active: boolean, onBack: () => void, levels = 1): void {
  const ref = useRef(onBack);
  useEffect(() => { ref.current = onBack; });
  const count = active ? Math.max(0, Math.floor(levels)) : 0;
  useEffect(() => {
    if (count === 0) return;
    const offs = Array.from({ length: count }, () => registerMobileBack(() => ref.current()));
    return () => { for (const off of offs.reverse()) off(); };
  }, [count]);
}

/** The width below which the desktop draws every app full-screen (page.tsx). */
export const PHONE_LAYOUT_MAX_WIDTH = 767;

/**
 * True while the desktop is in its phone layout. For screens that should only
 * claim Back there: on a desktop several windows of one app can be open, and
 * Back belongs to the top window rather than to whichever registered last.
 */
export function usePhoneLayout(): boolean {
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    const check = () => setPhone(window.innerWidth <= PHONE_LAYOUT_MAX_WIDTH);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);
  return phone;
}

/** Test seam. */
export function resetMobileBackForTests(): void {
  stack = [];
  emit();
}
