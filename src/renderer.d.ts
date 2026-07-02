import type { CodexDeskApi } from "./types";

declare global {
  interface Window {
    codexDesk: CodexDeskApi;
  }
}

export {};

