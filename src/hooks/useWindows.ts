"use client";

import { useReducer, useCallback } from "react";

export interface WindowState {
  id: string;
  appId: string;
  title: string;
  icon: React.ReactNode;
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  zIndex: number;
  isMinimized: boolean;
  isMaximized: boolean;
  isClosing: boolean;
  isOpening: boolean;
}

export interface WindowConfig {
  appId: string;
  title: string;
  icon: React.ReactNode;
  defaultWidth: number;
  defaultHeight: number;
  minWidth?: number;
  minHeight?: number;
  content: "settings" | "openclaw" | "placeholder";
}

interface WindowManagerState {
  windows: WindowState[];
  nextZIndex: number;
}

type WindowAction =
  | { type: "OPEN_WINDOW"; config: WindowConfig }
  | { type: "CLOSE_WINDOW"; id: string }
  | { type: "MINIMIZE_WINDOW"; id: string }
  | { type: "MAXIMIZE_WINDOW"; id: string }
  | { type: "RESTORE_WINDOW"; id: string }
  | { type: "FOCUS_WINDOW"; id: string }
  | { type: "MOVE_WINDOW"; id: string; x: number; y: number }
  | { type: "RESIZE_WINDOW"; id: string; width: number; height: number; x?: number; y?: number }
  | { type: "FINISH_OPENING"; id: string }
  | { type: "FINISH_CLOSING"; id: string };

function generateId(): string {
  return Math.random().toString(36).substring(2, 9);
}

function getCenteredPosition(width: number, height: number): { x: number; y: number } {
  if (typeof window === "undefined") return { x: 100, y: 100 };

  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;

  // Account for taskbar at bottom (60px) and header at top (60px)
  const availableHeight = screenHeight - 120;

  return {
    x: Math.max(20, (screenWidth - width) / 2),
    y: Math.max(60, (availableHeight - height) / 2 + 60),
  };
}

function windowReducer(state: WindowManagerState, action: WindowAction): WindowManagerState {
  switch (action.type) {
    case "OPEN_WINDOW": {
      // Check if window for this app is already open
      const existingWindow = state.windows.find(w => w.appId === action.config.appId);
      if (existingWindow) {
        // If minimized, restore it; otherwise just focus
        if (existingWindow.isMinimized) {
          return {
            ...state,
            windows: state.windows.map(w =>
              w.id === existingWindow.id
                ? { ...w, isMinimized: false, zIndex: state.nextZIndex }
                : w
            ),
            nextZIndex: state.nextZIndex + 1,
          };
        }
        // Just focus
        return {
          ...state,
          windows: state.windows.map(w =>
            w.id === existingWindow.id ? { ...w, zIndex: state.nextZIndex } : w
          ),
          nextZIndex: state.nextZIndex + 1,
        };
      }

      const { x, y } = getCenteredPosition(action.config.defaultWidth, action.config.defaultHeight);
      const newWindow: WindowState = {
        id: generateId(),
        appId: action.config.appId,
        title: action.config.title,
        icon: action.config.icon,
        x,
        y,
        width: action.config.defaultWidth,
        height: action.config.defaultHeight,
        minWidth: action.config.minWidth ?? 300,
        minHeight: action.config.minHeight ?? 200,
        zIndex: state.nextZIndex,
        isMinimized: false,
        isMaximized: false,
        isClosing: false,
        isOpening: true,
      };

      return {
        ...state,
        windows: [...state.windows, newWindow],
        nextZIndex: state.nextZIndex + 1,
      };
    }

    case "CLOSE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, isClosing: true } : w
        ),
      };
    }

    case "FINISH_CLOSING": {
      return {
        ...state,
        windows: state.windows.filter(w => w.id !== action.id),
      };
    }

    case "FINISH_OPENING": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, isOpening: false } : w
        ),
      };
    }

    case "MINIMIZE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, isMinimized: true } : w
        ),
      };
    }

    case "MAXIMIZE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, isMaximized: !w.isMaximized, zIndex: state.nextZIndex } : w
        ),
        nextZIndex: state.nextZIndex + 1,
      };
    }

    case "RESTORE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, isMinimized: false, zIndex: state.nextZIndex } : w
        ),
        nextZIndex: state.nextZIndex + 1,
      };
    }

    case "FOCUS_WINDOW": {
      const window = state.windows.find(w => w.id === action.id);
      if (!window || window.zIndex === state.nextZIndex - 1) {
        return state; // Already focused
      }
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, zIndex: state.nextZIndex } : w
        ),
        nextZIndex: state.nextZIndex + 1,
      };
    }

    case "MOVE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id ? { ...w, x: action.x, y: action.y } : w
        ),
      };
    }

    case "RESIZE_WINDOW": {
      return {
        ...state,
        windows: state.windows.map(w =>
          w.id === action.id
            ? {
                ...w,
                width: Math.max(w.minWidth, action.width),
                height: Math.max(w.minHeight, action.height),
                x: action.x !== undefined ? action.x : w.x,
                y: action.y !== undefined ? action.y : w.y,
              }
            : w
        ),
      };
    }

    default:
      return state;
  }
}

export function useWindows() {
  const [state, dispatch] = useReducer(windowReducer, {
    windows: [],
    nextZIndex: 100,
  });

  const openWindow = useCallback((config: WindowConfig) => {
    dispatch({ type: "OPEN_WINDOW", config });
  }, []);

  const closeWindow = useCallback((id: string) => {
    dispatch({ type: "CLOSE_WINDOW", id });
  }, []);

  const finishClosing = useCallback((id: string) => {
    dispatch({ type: "FINISH_CLOSING", id });
  }, []);

  const finishOpening = useCallback((id: string) => {
    dispatch({ type: "FINISH_OPENING", id });
  }, []);

  const minimizeWindow = useCallback((id: string) => {
    dispatch({ type: "MINIMIZE_WINDOW", id });
  }, []);

  const maximizeWindow = useCallback((id: string) => {
    dispatch({ type: "MAXIMIZE_WINDOW", id });
  }, []);

  const restoreWindow = useCallback((id: string) => {
    dispatch({ type: "RESTORE_WINDOW", id });
  }, []);

  const focusWindow = useCallback((id: string) => {
    dispatch({ type: "FOCUS_WINDOW", id });
  }, []);

  const moveWindow = useCallback((id: string, x: number, y: number) => {
    dispatch({ type: "MOVE_WINDOW", id, x, y });
  }, []);

  const resizeWindow = useCallback((id: string, width: number, height: number, x?: number, y?: number) => {
    dispatch({ type: "RESIZE_WINDOW", id, width, height, x, y });
  }, []);

  return {
    windows: state.windows,
    openWindow,
    closeWindow,
    finishClosing,
    finishOpening,
    minimizeWindow,
    maximizeWindow,
    restoreWindow,
    focusWindow,
    moveWindow,
    resizeWindow,
  };
}
